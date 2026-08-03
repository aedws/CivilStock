/**
 * 발행 플로우 — 발행권 이양의 진입점. 순수 함수 + 원장 효과.
 *
 * 유저가 회사 주식(IPO)·ETF·채권을 직접 발행한다. 운영자 승인 게이트는 없고,
 * 발행은 도메인 레코드 생성 + 발행자 포지션 크레딧으로 이뤄진다. 이후 매도·유동성
 * 공급은 CLOB/AMM/라우터가 담당한다(발행 ≠ 판매 분리).
 */
import {
  exactAdd,
  exactPositionValue,
  exactQuantityMultiply,
  normalizeExactQuantity,
} from "../number/exactAmount";
import type { ExactAmount } from "../number/exactAmount";
import {
  getPosition,
  quantityAdd,
  quantityCompare,
  setPosition,
  type LedgerState,
} from "./ledger";
import type {
  BondDetails,
  EquityDetails,
  EtfDetails,
  OptionDetails,
  Security,
} from "./types";

/** 신규 상품 헤더 공통 필드. */
interface IssueBase {
  id: string;
  ticker: string;
  issuerUserId: string;
  nationId: string;
  exchangeId: string;
  currency: string;
}

function header(base: IssueBase, type: Security["type"]): Security {
  return { ...base, type, issuerUserId: base.issuerUserId, status: "listed" };
}

/** 회사 주식 발행(IPO): 발행자에게 총 발행주식을 크레딧. */
export function issueEquity(
  state: LedgerState,
  base: IssueBase,
  sharesOutstanding: string,
): { security: Security; details: EquityDetails } {
  const shares = normalizeExactQuantity(sharesOutstanding);
  setPosition(state, base.issuerUserId, base.id, quantityAdd(getPosition(state, base.issuerUserId, base.id), shares));
  return {
    security: header(base, "equity"),
    details: { securityId: base.id, sharesOutstanding: shares },
  };
}

/** 증자: 발행주식수를 늘리고 발행자에게 신주를 크레딧. */
export function issueSecondary(
  state: LedgerState,
  details: EquityDetails,
  issuerUserId: string,
  newShares: string,
): EquityDetails {
  const shares = normalizeExactQuantity(newShares);
  setPosition(state, issuerUserId, details.securityId, quantityAdd(getPosition(state, issuerUserId, details.securityId), shares));
  return { ...details, sharesOutstanding: quantityAdd(details.sharesOutstanding, shares) };
}

/** 채권 발행: 발행자에게 총 발행좌수를 크레딧(1차 판매는 원장 체결로). */
export function issueBond(
  state: LedgerState,
  base: IssueBase,
  spec: Omit<BondDetails, "securityId">,
  unitsIssued: string,
): { security: Security; details: BondDetails } {
  const units = normalizeExactQuantity(unitsIssued);
  setPosition(state, base.issuerUserId, base.id, quantityAdd(getPosition(state, base.issuerUserId, base.id), units));
  return { security: header(base, "bond"), details: { ...spec, securityId: base.id } };
}

/** 1좌·1주기당 쿠폰액(정수 최소단위 문자열). couponRate는 연율 백분율. */
export function bondCouponPerUnit(details: BondDetails, ticksPerYear: number): ExactAmount {
  // face × (rate/100) × (interval / ticksPerYear), 정수 연산·버림.
  const face = BigInt(details.faceValue.startsWith("-") ? "0" : details.faceValue);
  const rateMicroPercent = decimalMicroPercent(details.couponRate);
  const numerator = face * rateMicroPercent * BigInt(details.couponIntervalTicks);
  const denominator = 100n * 1_000_000n * BigInt(Math.max(1, ticksPerYear));
  return (numerator / denominator).toString();
}

function decimalMicroPercent(rate: string): bigint {
  // "5.25" → 5_250_000 (백분율 × 1e6).
  const scaled = normalizeExactQuantity(rate).replace("-", "");
  const [whole = "0", frac = ""] = scaled.split(".");
  const micro = `${whole}${frac.padEnd(6, "0").slice(0, 6)}`;
  return BigInt(micro || "0");
}

/** ETF 발행: 구성종목·비중 정의. 상품만 생성(지분은 생성/상환으로). */
export function issueEtf(
  base: IssueBase,
  constituents: EtfDetails["constituents"],
): { security: Security; details: EtfDetails } {
  return { security: header(base, "etf"), details: { securityId: base.id, constituents } };
}

/** ETF 1주당 순자산가치(NAV) = 구성종목 시세 × 편입수량 합. */
export function etfNav(
  details: EtfDetails,
  priceOf: (securityId: string) => ExactAmount,
): ExactAmount {
  let nav: ExactAmount = "0";
  for (const c of details.constituents) {
    nav = exactAdd(nav, exactPositionValue(priceOf(c.securityId), c.unitsPerShare));
  }
  return nav;
}

export type EtfResult =
  | { ok: true }
  | { ok: false; reason: "insufficient_basket" | "insufficient_shares"; securityId?: string };

/** ETF 생성: 유저가 바스켓을 예치하고 ETF 지분을 받는다. */
export function createEtfShares(
  state: LedgerState,
  userId: string,
  details: EtfDetails,
  shares: string,
): EtfResult {
  const need = details.constituents.map((c) => ({
    securityId: c.securityId,
    quantity: exactQuantityMultiply(c.unitsPerShare, shares),
  }));
  for (const n of need) {
    if (quantityCompare(getPosition(state, userId, n.securityId), n.quantity) < 0) {
      return { ok: false, reason: "insufficient_basket", securityId: n.securityId };
    }
  }
  for (const n of need) {
    setPosition(state, userId, n.securityId, quantityAdd(getPosition(state, userId, n.securityId), `-${normalizeExactQuantity(n.quantity)}`));
  }
  setPosition(state, userId, details.securityId, quantityAdd(getPosition(state, userId, details.securityId), shares));
  return { ok: true };
}

/** ETF 상환: 유저가 ETF 지분을 소각하고 바스켓을 돌려받는다. */
export function redeemEtfShares(
  state: LedgerState,
  userId: string,
  details: EtfDetails,
  shares: string,
): EtfResult {
  if (quantityCompare(getPosition(state, userId, details.securityId), shares) < 0) {
    return { ok: false, reason: "insufficient_shares" };
  }
  setPosition(state, userId, details.securityId, quantityAdd(getPosition(state, userId, details.securityId), `-${normalizeExactQuantity(shares)}`));
  for (const c of details.constituents) {
    const quantity = exactQuantityMultiply(c.unitsPerShare, shares);
    setPosition(state, userId, c.securityId, quantityAdd(getPosition(state, userId, c.securityId), quantity));
  }
  return { ok: true };
}

/** 옵션 발행(라이터): 상품만 생성. 증거금·행사 정산은 파생 엔진(다음 슬라이스). */
export function issueOption(
  base: IssueBase,
  spec: Omit<OptionDetails, "securityId">,
): { security: Security; details: OptionDetails } {
  return { security: header(base, "option"), details: { ...spec, securityId: base.id } };
}

/**
 * worldTick — 경제의 심장박동. 순수(+원장 변형) 함수.
 *
 * 거래(주문 체결·AMM 스왑)는 유저 행위에 따라 실시간·연속으로 일어나고 서버
 * 권위 상태에 즉시 반영된다. worldTick은 그와 별개로, **시간에 종속된 정기
 * 이벤트**를 배치 처리한다: 채권 쿠폰 지급·만기 상환, ETF NAV 스냅샷 등.
 * (증거금 마크투마켓·강제청산·실물 생산은 다음 슬라이스에서 이 위에 얹는다.)
 *
 * 서버에서는 Cloud Scheduler가 N분마다 이 로직을 호출하고, **멱등**하게(같은 틱
 * 재실행이 이중 지급을 만들지 않게) 처리한 틱 번호를 기록한다.
 */
import {
  exactAdd,
  exactCompare,
  exactPositionValue,
  exactSubtract,
} from "../number/exactAmount";
import type { ExactAmount } from "../number/exactAmount";
import { bondCouponPerUnit } from "./issuance";
import {
  getCash,
  holdersOf,
  setCash,
  setPosition,
  type LedgerState,
} from "./ledger";
import type { BondDetails, EtfDetails, Security } from "./types";

export interface TickContext {
  tick: number;
  ticksPerYear: number;
}

export type TickEvent =
  | { kind: "coupon"; securityId: string; issuerId: string; totalPaid: ExactAmount; tick: number }
  | { kind: "maturity"; securityId: string; issuerId: string; totalRedeemed: ExactAmount; tick: number }
  | { kind: "default"; securityId: string; issuerId: string; owed: ExactAmount; tick: number }
  | { kind: "nav"; securityId: string; nav: ExactAmount; tick: number };

export interface BondEntry {
  security: Security;
  details: BondDetails;
}

/** 발행자가 보유자 목록에 지불해야 할 총액과 좌수별 지급액을 계산. */
function obligation(
  perUnit: ExactAmount,
  holders: Array<{ userId: string; quantity: string }>,
): { total: ExactAmount; payouts: Array<{ userId: string; amount: ExactAmount; quantity: string }> } {
  let total: ExactAmount = "0";
  const payouts = holders.map((h) => {
    const amount = exactPositionValue(perUnit, h.quantity);
    total = exactAdd(total, amount);
    return { userId: h.userId, amount, quantity: h.quantity };
  });
  return { total, payouts };
}

/**
 * 채권 쿠폰·만기 처리. 발행자 현금이 총 지급액에 못 미치면 default 이벤트만 내고
 * 지급하지 않는다(발행자는 계속 채무를 진다 — 부분지급·구조조정은 이후 확장).
 * 발행자가 자기 보유분에는 스스로 지급하지 않는다.
 */
export function processBonds(
  state: LedgerState,
  bonds: BondEntry[],
  ctx: TickContext,
): TickEvent[] {
  const events: TickEvent[] = [];
  for (const { security, details } of bonds) {
    if (security.status !== "listed") continue;
    const issuer = security.issuerUserId;
    if (!issuer) continue;
    const currency = security.currency;
    const holders = holdersOf(state, security.id).filter((h) => h.userId !== issuer);

    // 만기: 원금 상환 후 상장폐지.
    if (ctx.tick >= details.maturityTick) {
      const { total, payouts } = obligation(details.faceValue, holders);
      if (exactCompare(getCash(state, issuer, currency), total) < 0) {
        events.push({ kind: "default", securityId: security.id, issuerId: issuer, owed: total, tick: ctx.tick });
        continue;
      }
      setCash(state, issuer, currency, exactSubtract(getCash(state, issuer, currency), total));
      for (const p of payouts) {
        setCash(state, p.userId, currency, exactAdd(getCash(state, p.userId, currency), p.amount));
        setPosition(state, p.userId, security.id, "0");
      }
      security.status = "delisted";
      events.push({ kind: "maturity", securityId: security.id, issuerId: issuer, totalRedeemed: total, tick: ctx.tick });
      continue;
    }

    // 쿠폰: 주기 도래 시.
    if (details.couponIntervalTicks > 0 && ctx.tick > 0 && ctx.tick % details.couponIntervalTicks === 0) {
      const perUnit = bondCouponPerUnit(details, ctx.ticksPerYear);
      const { total, payouts } = obligation(perUnit, holders);
      if (exactCompare(total, "0") <= 0) continue;
      if (exactCompare(getCash(state, issuer, currency), total) < 0) {
        events.push({ kind: "default", securityId: security.id, issuerId: issuer, owed: total, tick: ctx.tick });
        continue;
      }
      setCash(state, issuer, currency, exactSubtract(getCash(state, issuer, currency), total));
      for (const p of payouts) {
        setCash(state, p.userId, currency, exactAdd(getCash(state, p.userId, currency), p.amount));
      }
      events.push({ kind: "coupon", securityId: security.id, issuerId: issuer, totalPaid: total, tick: ctx.tick });
    }
  }
  return events;
}

export interface EtfEntry {
  security: Security;
  details: EtfDetails;
}

/** ETF NAV 스냅샷을 기록(가격 표시·차익거래 기준용). */
export function snapshotEtfNav(
  etfs: EtfEntry[],
  priceOf: (securityId: string) => ExactAmount,
  ctx: TickContext,
): TickEvent[] {
  const events: TickEvent[] = [];
  for (const { security, details } of etfs) {
    let nav: ExactAmount = "0";
    for (const c of details.constituents) {
      nav = exactAdd(nav, exactPositionValue(priceOf(c.securityId), c.unitsPerShare));
    }
    events.push({ kind: "nav", securityId: security.id, nav, tick: ctx.tick });
  }
  return events;
}

/** 한 틱의 모든 시간종속 처리를 순서대로 수행하고 이벤트 로그를 반환. */
export function runWorldTick(
  state: LedgerState,
  input: { bonds: BondEntry[]; etfs: EtfEntry[]; priceOf: (securityId: string) => ExactAmount },
  ctx: TickContext,
): TickEvent[] {
  return [
    ...processBonds(state, input.bonds, ctx),
    ...snapshotEtfNav(input.etfs, input.priceOf, ctx),
  ];
}

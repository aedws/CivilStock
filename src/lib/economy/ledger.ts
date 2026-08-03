/**
 * 현금(통화별)·포지션(증권별) 원장과 체결 정산 — 순수 참조 구현.
 *
 * 서버 권위: 실제 정산은 Cloud Run 서버가 이 규칙대로 Postgres 트랜잭션 안에서
 * 원자적으로 수행한다(음수 국고 금지 등 불변식은 검증 후에만 반영). 이 모듈은
 * 그 규칙의 테스트 가능한 기준 구현이다.
 */
import {
  decimalToScaledInteger,
  exactAdd,
  exactCompare,
  exactSubtract,
  normalizeExactAmount,
  normalizeExactQuantity,
} from "../number/exactAmount";
import type { ExactAmount } from "../number/exactAmount";
import type { Fill } from "./types";

/** userId → currency → 잔액(정수 최소단위 문자열). */
export type CashLedger = Map<string, Map<string, ExactAmount>>;
/** userId → securityId → 수량(6dp micros 문자열). */
export type PositionLedger = Map<string, Map<string, string>>;

export interface LedgerState {
  cash: CashLedger;
  positions: PositionLedger;
}

export function createLedger(): LedgerState {
  return { cash: new Map(), positions: new Map() };
}

export function getCash(state: LedgerState, userId: string, currency: string): ExactAmount {
  return state.cash.get(userId)?.get(currency) ?? "0";
}

export function getPosition(state: LedgerState, userId: string, securityId: string): string {
  return state.positions.get(userId)?.get(securityId) ?? "0";
}

export function setCash(
  state: LedgerState,
  userId: string,
  currency: string,
  amount: ExactAmount,
): void {
  const byCurrency = state.cash.get(userId) ?? new Map<string, ExactAmount>();
  byCurrency.set(currency, normalizeExactAmount(amount));
  state.cash.set(userId, byCurrency);
}

export function setPosition(
  state: LedgerState,
  userId: string,
  securityId: string,
  quantity: string,
): void {
  const bySecurity = state.positions.get(userId) ?? new Map<string, string>();
  bySecurity.set(securityId, normalizeExactQuantity(quantity));
  state.positions.set(userId, bySecurity);
}

function quantityCompare(a: string, b: string): -1 | 0 | 1 {
  const av = decimalToScaledInteger(normalizeExactQuantity(a), 6);
  const bv = decimalToScaledInteger(normalizeExactQuantity(b), 6);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function quantityAdd(a: string, b: string): string {
  const sum =
    decimalToScaledInteger(normalizeExactQuantity(a), 6) +
    decimalToScaledInteger(normalizeExactQuantity(b), 6);
  const negative = sum < 0n;
  const abs = negative ? -sum : sum;
  const decimal = `${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, "0")}`;
  return normalizeExactQuantity(negative ? `-${decimal}` : decimal);
}

export type SettleResult =
  | { ok: true }
  | { ok: false; reason: "insufficient_cash" | "insufficient_position" };

/**
 * 체결 한 건을 매수자↔매도자 사이에 정산한다. 검증 통과 시에만 상태를 변경한다.
 * @param currency 결제 통화 코드.
 * @param buyerId  포지션을 사고 현금을 내는 쪽.
 * @param sellerId 포지션을 팔고 현금을 받는 쪽.
 * @param allowShort 매도자 포지션 부족 시 공매도 허용 여부(MVP 기본 false).
 */
export function settleFill(
  state: LedgerState,
  fill: Fill,
  currency: string,
  buyerId: string,
  sellerId: string,
  securityId: string,
  allowShort = false,
): SettleResult {
  const buyerCash = getCash(state, buyerId, currency);
  if (exactCompare(buyerCash, fill.value) < 0) {
    return { ok: false, reason: "insufficient_cash" };
  }
  const sellerPosition = getPosition(state, sellerId, securityId);
  if (!allowShort && quantityCompare(sellerPosition, fill.quantity) < 0) {
    return { ok: false, reason: "insufficient_position" };
  }

  setCash(state, buyerId, currency, exactSubtract(buyerCash, fill.value));
  setCash(state, sellerId, currency, exactAdd(getCash(state, sellerId, currency), fill.value));
  setPosition(
    state,
    buyerId,
    securityId,
    quantityAdd(getPosition(state, buyerId, securityId), fill.quantity),
  );
  setPosition(
    state,
    sellerId,
    securityId,
    quantityAdd(sellerPosition, `-${normalizeExactQuantity(fill.quantity)}`),
  );
  return { ok: true };
}

/**
 * 가격-시간 우선(price-time priority) 지정가 매칭 — 순수 함수.
 *
 * 2DStock은 가격을 결정론으로 계산했지만, "유저가 시장 조성자"인 CivilStock에선
 * 가격이 실제 주문 흐름에서 창발한다. 이 매처가 그 창발의 규칙이다.
 *
 * 모든 수량 연산은 micros(6dp) BigInt로 정확히 처리하고, 결제 금액은
 * exactPositionValue로 큰 수 손실 없이 계산한다.
 */
import {
  decimalToScaledInteger,
  exactCompare,
  exactPositionValue,
  normalizeExactQuantity,
} from "../number/exactAmount";
import type { Fill, Order, Side } from "./types";

const MICRO = 1_000_000n;

function toMicros(quantity: string): bigint {
  return decimalToScaledInteger(normalizeExactQuantity(quantity), 6);
}

function fromMicros(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const decimal = `${abs / MICRO}.${(abs % MICRO).toString().padStart(6, "0")}`;
  return normalizeExactQuantity(negative ? `-${decimal}` : decimal);
}

/** 들어온 주문이 게시된 호가와 교차하는가(체결 가능한가). */
function crosses(takerSide: Side, takerLimit: string, makerPrice: string): boolean {
  // 매수 테이커: 지정가가 매도호가 이상이면 체결.
  // 매도 테이커: 지정가가 매수호가 이하이면 체결.
  const cmp = exactCompare(takerLimit, makerPrice);
  return takerSide === "buy" ? cmp >= 0 : cmp <= 0;
}

/**
 * 반대편 호가장(best-first로 정렬됨)을 상대로 들어온 지정가 주문을 체결한다.
 * 원본을 변형하지 않고 결과를 반환한다.
 */
export interface MatchResult {
  fills: Fill[];
  /** 미체결 잔량(6dp micros 문자열). 0이면 완전체결. */
  remaining: string;
  /** 갱신된 반대편 호가장(부분체결 반영·완전체결분 제거). */
  restingBook: Order[];
}

export function matchOrder(
  incoming: {
    id: string;
    ownerId: string;
    side: Side;
    limitPrice: string;
    quantity: string;
  },
  oppositeBook: Order[],
): MatchResult {
  let remaining = toMicros(incoming.quantity);
  const fills: Fill[] = [];
  const restingBook: Order[] = [];

  for (const resting of oppositeBook) {
    if (remaining <= 0n || !crosses(incoming.side, incoming.limitPrice, resting.limitPrice)) {
      restingBook.push(resting);
      continue;
    }
    const restingQty = toMicros(resting.quantity);
    const traded = remaining < restingQty ? remaining : restingQty;
    const quantity = fromMicros(traded);
    fills.push({
      makerOrderId: resting.id,
      makerId: resting.ownerId,
      takerId: incoming.ownerId,
      takerSide: incoming.side,
      price: resting.limitPrice,
      quantity,
      value: exactPositionValue(resting.limitPrice, quantity),
    });
    remaining -= traded;
    const restingLeftover = restingQty - traded;
    if (restingLeftover > 0n) {
      restingBook.push({ ...resting, quantity: fromMicros(restingLeftover) });
    }
    // restingLeftover === 0n → 호가 완전 소진, 장부에서 제거.
  }

  return { fills, remaining: fromMicros(remaining), restingBook };
}

/**
 * 반대편 호가장을 best-first로 정렬한다.
 * 매수 테이커는 매도장을 (가격 오름차순, 시간 오름차순)으로 소진하고,
 * 매도 테이커는 매수장을 (가격 내림차순, 시간 오름차순)으로 소진한다.
 */
export function sortRestingBook(makerSide: Side, book: Order[]): Order[] {
  return [...book].sort((a, b) => {
    const priceCmp = exactCompare(a.limitPrice, b.limitPrice);
    if (priceCmp !== 0) return makerSide === "sell" ? priceCmp : -priceCmp;
    return a.ts - b.ts;
  });
}

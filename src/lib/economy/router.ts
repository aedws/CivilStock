/**
 * 스마트 주문 라우터 — CLOB + AMM 병용의 최선체결(best execution). 순수 함수.
 *
 * 전략(매수 기준): 저렴한 소스부터 소진한다. AMM 현물가가 다음 CLOB 호가보다
 * 싸면 AMM에서 그 호가 수준까지 담고, 그 다음 CLOB 호가를 소진한다. 반복.
 * 이 과정에서 두 시장의 가격이 벌어지면 차익거래처럼 자동 수렴한다.
 *
 * AMM 임계(가격 도달 물량)는 수수료를 무시한 추정이지만, 실제 체결은 fee 포함
 * 역스왑(quoteInForBaseOut)으로 정확히 계산하므로 가치 유출은 없다.
 */
import {
  decimalToScaledInteger,
  exactCompare,
  exactPositionValue,
  normalizeExactQuantity,
} from "../number/exactAmount";
import type { ExactAmount } from "../number/exactAmount";
import {
  maxBaseBuyableToPrice,
  maxBaseSellableToPrice,
  quoteInForBaseOut,
  swapBaseForQuote,
  type AmmPool,
} from "./amm";
import { sortRestingBook } from "./orderBook";
import type { Order, Side } from "./types";

const MICRO = 1_000_000n;

function micros(quantity: string): bigint {
  return decimalToScaledInteger(normalizeExactQuantity(quantity), 6);
}

function fromMicros(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const decimal = `${abs / MICRO}.${(abs % MICRO).toString().padStart(6, "0")}`;
  return normalizeExactQuantity(negative ? `-${decimal}` : decimal);
}

/** 평균 체결가(1.0단위당 결제통화 최소단위 정수 문자열). */
function averagePrice(value: bigint, quantityMicros: bigint): ExactAmount {
  if (quantityMicros === 0n) return "0";
  return ((value * MICRO) / quantityMicros).toString();
}

export interface RouteExecution {
  source: "clob" | "amm";
  /** 체결 평균가(정수 최소단위 문자열). */
  price: ExactAmount;
  /** 체결 수량(6dp 문자열). */
  quantity: string;
  /** 결제금액(정수 최소단위 문자열). */
  value: ExactAmount;
  /** CLOB 체결이면 상대 호가 id. */
  makerOrderId?: string;
}

export interface RouteResult {
  executions: RouteExecution[];
  /** 체결된 수량(6dp 문자열). */
  filled: string;
  /** 미체결 잔량(6dp 문자열). */
  remaining: string;
  /** 매수: 지불한 결제통화 총액 / 매도: 수취한 결제통화 총액(정수 최소단위 문자열). */
  totalValue: ExactAmount;
  /** 갱신된 반대편 호가장. */
  restingBook: Order[];
  /** 갱신된 AMM 풀(없으면 null). */
  pool: AmmPool | null;
}

/** 매수 라우팅: base `quantity`만큼을 CLOB 매도호가와 AMM에서 가장 싸게 매집. */
export function routeBuy(
  quantity: string,
  limitPrice: ExactAmount | null,
  asks: Order[],
  pool: AmmPool | null,
): RouteResult {
  const requested = micros(quantity);
  let remaining = requested;
  let totalValue = 0n;
  const executions: RouteExecution[] = [];
  const book = sortRestingBook("sell", asks);
  let currentPool = pool;
  let i = 0;

  const takeAmm = (cap: bigint): void => {
    if (!currentPool || cap <= 0n) return;
    const available = micros(currentPool.reserveBase) - 1n; // 풀 고갈 방지
    let base = cap < remaining ? cap : remaining;
    if (base > available) base = available;
    if (base <= 0n) return;
    const { quoteIn, pool: next } = quoteInForBaseOut(currentPool, fromMicros(base));
    const cost = BigInt(quoteIn);
    executions.push({ source: "amm", price: averagePrice(cost, base), quantity: fromMicros(base), value: quoteIn });
    totalValue += cost;
    remaining -= base;
    currentPool = next;
  };

  while (remaining > 0n && i < book.length) {
    const level = book[i]!;
    if (limitPrice !== null && exactCompare(level.limitPrice, limitPrice) > 0) break;
    takeAmm(micros(maxBaseBuyableToPrice(currentPool ?? emptyPool(), level.limitPrice)));
    if (remaining <= 0n) break;

    const levelQty = micros(level.quantity);
    const take = levelQty < remaining ? levelQty : remaining;
    const value = exactPositionValue(level.limitPrice, fromMicros(take));
    executions.push({ source: "clob", price: level.limitPrice, quantity: fromMicros(take), value, makerOrderId: level.id });
    totalValue += BigInt(value);
    remaining -= take;
    if (take === levelQty) i += 1;
    else book[i] = { ...level, quantity: fromMicros(levelQty - take) };
  }

  const restingBook = book.slice(i);
  if (remaining > 0n && currentPool) {
    const cap = limitPrice !== null ? micros(maxBaseBuyableToPrice(currentPool, limitPrice)) : remaining;
    takeAmm(cap);
  }

  return {
    executions,
    filled: fromMicros(requested - remaining),
    remaining: fromMicros(remaining),
    totalValue: totalValue.toString(),
    restingBook,
    pool: currentPool,
  };
}

/** 매도 라우팅: base `quantity`만큼을 CLOB 매수호가와 AMM에서 가장 비싸게 처분. */
export function routeSell(
  quantity: string,
  limitPrice: ExactAmount | null,
  bids: Order[],
  pool: AmmPool | null,
): RouteResult {
  const requested = micros(quantity);
  let remaining = requested;
  let totalValue = 0n;
  const executions: RouteExecution[] = [];
  const book = sortRestingBook("buy", bids);
  let currentPool = pool;
  let i = 0;

  const takeAmm = (cap: bigint): void => {
    if (!currentPool || cap <= 0n) return;
    const base = cap < remaining ? cap : remaining;
    if (base <= 0n) return;
    const { amountOut, pool: next } = swapBaseForQuote(currentPool, fromMicros(base));
    const proceeds = BigInt(amountOut);
    executions.push({ source: "amm", price: averagePrice(proceeds, base), quantity: fromMicros(base), value: amountOut });
    totalValue += proceeds;
    remaining -= base;
    currentPool = next;
  };

  while (remaining > 0n && i < book.length) {
    const level = book[i]!;
    if (limitPrice !== null && exactCompare(level.limitPrice, limitPrice) < 0) break;
    takeAmm(micros(maxBaseSellableToPrice(currentPool ?? emptyPool(), level.limitPrice)));
    if (remaining <= 0n) break;

    const levelQty = micros(level.quantity);
    const take = levelQty < remaining ? levelQty : remaining;
    const value = exactPositionValue(level.limitPrice, fromMicros(take));
    executions.push({ source: "clob", price: level.limitPrice, quantity: fromMicros(take), value, makerOrderId: level.id });
    totalValue += BigInt(value);
    remaining -= take;
    if (take === levelQty) i += 1;
    else book[i] = { ...level, quantity: fromMicros(levelQty - take) };
  }

  const restingBook = book.slice(i);
  if (remaining > 0n && currentPool) {
    const cap = limitPrice !== null ? micros(maxBaseSellableToPrice(currentPool, limitPrice)) : remaining;
    takeAmm(cap);
  }

  return {
    executions,
    filled: fromMicros(requested - remaining),
    remaining: fromMicros(remaining),
    totalValue: totalValue.toString(),
    restingBook,
    pool: currentPool,
  };
}

function emptyPool(): AmmPool {
  return { securityId: "", currency: "", reserveBase: "0", reserveQuote: "0", totalShares: "0", feeBps: 0 };
}

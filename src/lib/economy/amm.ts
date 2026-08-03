/**
 * AMM 유동성 풀(상수곱 x·y=k) — 순수 함수. CLOB과 병용하는 유동성 모델의 절반.
 *
 * 유저 발행 마이크로캡은 호가장(CLOB)이 텅 빌 수 있다. 그래서 유저가 풀에
 * 유동성을 예치하면 언제나 즉시 매매가 가능해진다. 시장조성 = 호가 게시(CLOB)
 * 또는 풀 예치(AMM) 둘 중 하나로 할 수 있다.
 *
 * 단위 규율(exactAmount와 동일):
 * - reserveQuote: 결제통화 정수 최소단위 문자열(minor unit).
 * - reserveBase / totalShares: 6자리 소수(micros) 문자열.
 * - 모든 내부 연산은 BigInt로 정확히 처리, 반올림은 항상 버림(풀에 유리 = 안전).
 */
import {
  decimalToScaledInteger,
  normalizeExactAmount,
  normalizeExactQuantity,
} from "../number/exactAmount";
import type { ExactAmount } from "../number/exactAmount";

const MICRO = 1_000_000n;
const BPS = 10_000n;

export interface AmmPool {
  securityId: string;
  currency: string;
  /** 기초자산 준비금(6dp micros 문자열). */
  reserveBase: string;
  /** 결제통화 준비금(정수 최소단위 문자열). */
  reserveQuote: ExactAmount;
  /** 총 LP 지분(6dp micros 문자열). */
  totalShares: string;
  /** 스왑 수수료(bps). 예: 30 = 0.30%. LP에게 귀속. */
  feeBps: number;
}

function micros(quantity: string): bigint {
  return decimalToScaledInteger(normalizeExactQuantity(quantity), 6);
}

function fromMicros(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const decimal = `${abs / MICRO}.${(abs % MICRO).toString().padStart(6, "0")}`;
  return normalizeExactQuantity(negative ? `-${decimal}` : decimal);
}

function minor(amount: string): bigint {
  return BigInt(normalizeExactAmount(amount));
}

/** 상수곱 스왑 출력: 수수료 차감 후 reserveOut·dx / (reserveIn + dx). 버림. */
function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const inAfterFee = (amountIn * (BPS - BigInt(feeBps))) / BPS;
  return (reserveOut * inAfterFee) / (reserveIn + inAfterFee);
}

export interface SwapResult {
  pool: AmmPool;
  /** 사용자가 받는 산출량. */
  amountOut: string;
}

/** 결제통화를 넣고 기초자산을 받는다(매수). amountOut은 6dp 수량 문자열. */
export function swapQuoteForBase(pool: AmmPool, quoteIn: ExactAmount): SwapResult {
  const x = minor(pool.reserveQuote);
  const y = micros(pool.reserveBase);
  const dx = minor(quoteIn);
  const dy = amountOut(dx, x, y, pool.feeBps);
  return {
    amountOut: fromMicros(dy),
    pool: {
      ...pool,
      reserveQuote: (x + dx).toString(),
      reserveBase: fromMicros(y - dy),
    },
  };
}

/** 기초자산을 넣고 결제통화를 받는다(매도). amountOut은 정수 최소단위 문자열. */
export function swapBaseForQuote(pool: AmmPool, baseIn: string): SwapResult {
  const x = micros(pool.reserveBase);
  const y = minor(pool.reserveQuote);
  const dx = micros(baseIn);
  const dy = amountOut(dx, x, y, pool.feeBps);
  return {
    amountOut: dy.toString(),
    pool: {
      ...pool,
      reserveBase: fromMicros(x + dx),
      reserveQuote: (y - dy).toString(),
    },
  };
}

/** 현물가(기초자산 1.0단위당 결제통화 최소단위 정수 문자열) — CLOB 가격과 동일 단위. */
export function spotPrice(pool: AmmPool): ExactAmount {
  const base = micros(pool.reserveBase);
  if (base === 0n) return "0";
  return ((minor(pool.reserveQuote) * MICRO) / base).toString();
}

export interface LiquidityResult {
  pool: AmmPool;
  /** 발행된 LP 지분(6dp 문자열). */
  sharesMinted: string;
}

/**
 * 유동성 예치. 최초 예치자는 예치한 base micros를 초기 지분으로 받는다.
 * 이후 예치자는 base 비율만큼 지분을 받는다(quote도 비례 예치를 가정).
 */
export function addLiquidity(pool: AmmPool, baseIn: string, quoteIn: ExactAmount): LiquidityResult {
  const dBase = micros(baseIn);
  const dQuote = minor(quoteIn);
  const total = micros(pool.totalShares);
  const reserveBase = micros(pool.reserveBase);

  const minted = total === 0n || reserveBase === 0n ? dBase : (total * dBase) / reserveBase;
  return {
    sharesMinted: fromMicros(minted),
    pool: {
      ...pool,
      reserveBase: fromMicros(reserveBase + dBase),
      reserveQuote: (minor(pool.reserveQuote) + dQuote).toString(),
      totalShares: fromMicros(total + minted),
    },
  };
}

export interface RemoveResult {
  pool: AmmPool;
  baseOut: string;
  quoteOut: ExactAmount;
}

/** 정수 제곱근(내림). Newton 반복. */
function isqrt(value: bigint): bigint {
  if (value < 0n) throw new RangeError("isqrt of negative");
  if (value < 2n) return value;
  let x0 = value;
  let x1 = (value >> 1n) + 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) >> 1n;
  }
  return x0;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * 원하는 기초자산 산출량(baseOut)을 얻기 위해 필요한 결제통화 입력량(역스왑).
 * 반올림은 올림(풀에 유리). 풀을 비울 순 없다(baseOut < reserveBase).
 */
export function quoteInForBaseOut(pool: AmmPool, baseOut: string): { quoteIn: ExactAmount; pool: AmmPool } {
  const x = minor(pool.reserveQuote);
  const y = micros(pool.reserveBase);
  const dy = micros(baseOut);
  if (dy <= 0n) return { quoteIn: "0", pool };
  if (dy >= y) throw new RangeError("baseOut drains the pool");
  const inAfterFee = ceilDiv(dy * x, y - dy);
  const dx = ceilDiv(inAfterFee * BPS, BPS - BigInt(pool.feeBps));
  return {
    quoteIn: dx.toString(),
    pool: { ...pool, reserveQuote: (x + dx).toString(), reserveBase: fromMicros(y - dy) },
  };
}

/** 원하는 결제통화 산출량(quoteOut)을 얻기 위해 필요한 기초자산 입력량(역스왑). */
export function baseInForQuoteOut(pool: AmmPool, quoteOut: ExactAmount): { baseIn: string; pool: AmmPool } {
  const x = minor(pool.reserveQuote);
  const y = micros(pool.reserveBase);
  const dy = minor(quoteOut);
  if (dy <= 0n) return { baseIn: "0", pool };
  if (dy >= x) throw new RangeError("quoteOut drains the pool");
  const inAfterFee = ceilDiv(dy * y, x - dy);
  const dxBase = ceilDiv(inAfterFee * BPS, BPS - BigInt(pool.feeBps));
  return {
    baseIn: fromMicros(dxBase),
    pool: { ...pool, reserveBase: fromMicros(y + dxBase), reserveQuote: (x - dy).toString() },
  };
}

/**
 * 현물가가 targetPrice에 도달하기 전까지 매수 가능한 기초자산 최대량(6dp 문자열).
 * 수수료를 무시한 임계 추정(라우팅 분기용). 실제 체결은 fee 포함 역스왑으로 정확히.
 */
export function maxBaseBuyableToPrice(pool: AmmPool, targetPrice: ExactAmount): string {
  const x = minor(pool.reserveQuote);
  const y = micros(pool.reserveBase);
  const k = x * y;
  const target = BigInt(normalizeExactAmount(targetPrice));
  const xTarget = isqrt((target * k) / MICRO);
  if (xTarget <= x) return "0";
  const yTarget = k / xTarget;
  return fromMicros(y - yTarget);
}

/** 현물가가 targetPrice로 내려가기 전까지 매도 가능한 기초자산 최대량(6dp 문자열). */
export function maxBaseSellableToPrice(pool: AmmPool, targetPrice: ExactAmount): string {
  const x = minor(pool.reserveQuote);
  const y = micros(pool.reserveBase);
  const k = x * y;
  const target = BigInt(normalizeExactAmount(targetPrice));
  const xTarget = isqrt((target * k) / MICRO);
  if (xTarget >= x) return "0";
  const yTarget = k / xTarget;
  return fromMicros(yTarget - y);
}

/** LP 지분을 소각하고 준비금을 비례 인출한다. */
export function removeLiquidity(pool: AmmPool, shares: string): RemoveResult {
  const burn = micros(shares);
  const total = micros(pool.totalShares);
  if (total === 0n || burn <= 0n) {
    return { pool, baseOut: "0", quoteOut: "0" };
  }
  const reserveBase = micros(pool.reserveBase);
  const reserveQuote = minor(pool.reserveQuote);
  const baseOut = (reserveBase * burn) / total;
  const quoteOut = (reserveQuote * burn) / total;
  return {
    baseOut: fromMicros(baseOut),
    quoteOut: quoteOut.toString(),
    pool: {
      ...pool,
      reserveBase: fromMicros(reserveBase - baseOut),
      reserveQuote: (reserveQuote - quoteOut).toString(),
      totalShares: fromMicros(total - burn),
    },
  };
}

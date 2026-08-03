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

import assert from "node:assert";
import {
  addLiquidity,
  removeLiquidity,
  spotPrice,
  swapBaseForQuote,
  swapQuoteForBase,
  type AmmPool,
} from "../src/lib/economy/amm";

function pool(feeBps = 30): AmmPool {
  // 1,000 base @ $1.00 → reserveQuote 100,000 minor, reserveBase 1000.
  return {
    securityId: "SEC",
    currency: "USD",
    reserveBase: "1000",
    reserveQuote: "100000",
    totalShares: "1000",
    feeBps,
  };
}

// --- 현물가: quote(minor)/base = 100000/1000 = 100 minor(=$1.00)당 1주 ---
assert.equal(spotPrice(pool()), "100");

// --- 스왑: 결제통화로 기초자산 매수(수수료 0으로 검증) ---
{
  // fee 0, x=100000, y=1000(micros=1e9). dx=10000 → dy = 1e9*10000/(100000+10000)
  //  = 1e13/110000 = 90909090(micros) = 90.90909 base.
  const r = swapQuoteForBase(pool(0), "10000");
  assert.equal(r.amountOut, "90.90909");
  assert.equal(r.pool.reserveQuote, "110000");
  // k(대략)는 스왑 후에도 유지: 매수로 base 준비금은 감소.
  assert.equal(r.pool.reserveBase, "909.09091");
}

// --- 스왑 왕복: 수수료가 있으면 되팔 때 원금 이하로 돌아온다(LP 이득) ---
{
  const bought = swapQuoteForBase(pool(30), "10000");
  const soldBack = swapBaseForQuote(bought.pool, bought.amountOut);
  assert.ok(
    BigInt(soldBack.amountOut) < 10000n,
    `round-trip must lose to fees, got ${soldBack.amountOut}`,
  );
}

// --- 유동성: 비례 예치 → 비례 지분, 소각 시 비례 인출 ---
{
  const added = addLiquidity(pool(), "1000", "100000"); // 기존과 동일 비율, 2배로
  assert.equal(added.sharesMinted, "1000");
  assert.equal(added.pool.totalShares, "2000");
  assert.equal(added.pool.reserveBase, "2000");
  assert.equal(added.pool.reserveQuote, "200000");

  const removed = removeLiquidity(added.pool, "1000"); // 절반 인출
  assert.equal(removed.baseOut, "1000");
  assert.equal(removed.quoteOut, "100000");
  assert.equal(removed.pool.totalShares, "1000");
}

// --- 큰 수: 천문학적 준비금 풀에서도 스왑이 정확 ---
{
  const whalePool: AmmPool = {
    securityId: "MEGA",
    currency: "KRW",
    reserveBase: "1000000000000",
    reserveQuote: "1000000000000000000000000000000",
    totalShares: "1000000000000",
    feeBps: 0,
  };
  const r = swapQuoteForBase(whalePool, "1000000000000000000000000");
  assert.ok(BigInt(r.pool.reserveQuote) > 0n);
  assert.notEqual(r.amountOut, "0");
}

console.log("amm · constant-product swap · liquidity · big-number reserves passed");

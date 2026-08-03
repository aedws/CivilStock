import assert from "node:assert";
import { createLedger, getPosition } from "../src/lib/economy/ledger";
import {
  bondCouponPerUnit,
  createEtfShares,
  etfNav,
  issueBond,
  issueEquity,
  issueEtf,
  issueSecondary,
  redeemEtfShares,
} from "../src/lib/economy/issuance";

const base = (id: string, ticker: string) => ({
  id,
  ticker,
  issuerUserId: "founder",
  nationId: "N1",
  exchangeId: "EX1",
  currency: "USD",
});

// --- 주식 발행(IPO) + 증자 ---
{
  const state = createLedger();
  const { security, details } = issueEquity(state, base("EQ1", "ACME"), "1000000");
  assert.equal(security.type, "equity");
  assert.equal(security.issuerUserId, "founder");
  assert.equal(security.status, "listed");
  assert.equal(details.sharesOutstanding, "1000000");
  assert.equal(getPosition(state, "founder", "EQ1"), "1000000"); // 발행자에 전량 크레딧

  const grown = issueSecondary(state, details, "founder", "500000");
  assert.equal(grown.sharesOutstanding, "1500000");
  assert.equal(getPosition(state, "founder", "EQ1"), "1500000");
}

// --- 채권 발행 + 쿠폰 계산 ---
{
  const state = createLedger();
  const { security, details } = issueBond(
    state,
    base("BND1", "N1-5Y"),
    { faceValue: "1000000", couponRate: "5", maturityTick: 43800, couponIntervalTicks: 8760 },
    "10000",
  );
  assert.equal(security.type, "bond");
  assert.equal(getPosition(state, "founder", "BND1"), "10000");
  // face $10,000(=1,000,000 minor) × 5% × (8760/8760) = $500 = 50,000 minor.
  assert.equal(bondCouponPerUnit(details, 8760), "50000");
  // 반기 쿠폰(interval 4380) = 절반.
  assert.equal(bondCouponPerUnit({ ...details, couponIntervalTicks: 4380 }, 8760), "25000");
}

// --- ETF 발행 + NAV + 생성/상환 왕복 ---
{
  const state = createLedger();
  const { security, details } = issueEtf(base("ETF1", "IDX"), [
    { securityId: "A", unitsPerShare: "2" },
    { securityId: "B", unitsPerShare: "3" },
  ]);
  assert.equal(security.type, "etf");

  // NAV = A(100)×2 + B(50)×3 = 200 + 150 = 350.
  const prices: Record<string, string> = { A: "100", B: "50" };
  assert.equal(etfNav(details, (id) => prices[id] ?? "0"), "350");

  // 유저에 바스켓 부여 후 ETF 5주 생성.
  const holder = "trader";
  state.positions.set(holder, new Map([["A", "10"], ["B", "15"]]));
  const created = createEtfShares(state, holder, details, "5");
  assert.deepEqual(created, { ok: true });
  assert.equal(getPosition(state, holder, "ETF1"), "5");
  assert.equal(getPosition(state, holder, "A"), "0"); // 2×5 차감
  assert.equal(getPosition(state, holder, "B"), "0"); // 3×5 차감

  // 바스켓 부족이면 거부.
  const denied = createEtfShares(state, holder, details, "1");
  assert.deepEqual(denied, { ok: false, reason: "insufficient_basket", securityId: "A" });

  // 상환 → 바스켓 복원.
  const redeemed = redeemEtfShares(state, holder, details, "5");
  assert.deepEqual(redeemed, { ok: true });
  assert.equal(getPosition(state, holder, "ETF1"), "0");
  assert.equal(getPosition(state, holder, "A"), "10");
  assert.equal(getPosition(state, holder, "B"), "15");
}

// --- ETF 지분 부족 상환 거부 ---
{
  const state = createLedger();
  const { details } = issueEtf(base("ETF2", "IDX2"), [{ securityId: "A", unitsPerShare: "1" }]);
  const r = redeemEtfShares(state, "nobody", details, "1");
  assert.deepEqual(r, { ok: false, reason: "insufficient_shares" });
}

console.log("issuance · equity/bond/ETF · coupon · NAV · create-redeem roundtrip passed");

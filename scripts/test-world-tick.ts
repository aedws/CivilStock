import assert from "node:assert";
import { createLedger, getCash, getPosition, setCash, setPosition } from "../src/lib/economy/ledger";
import { issueBond, issueEtf } from "../src/lib/economy/issuance";
import { runWorldTick, processBonds, type BondEntry } from "../src/lib/economy/worldTick";

const issuerBase = {
  id: "BND1",
  ticker: "N1-5Y",
  issuerUserId: "gov",
  nationId: "N1",
  exchangeId: "EX1",
  currency: "USD",
};

function setupBond() {
  const state = createLedger();
  const { security, details } = issueBond(
    state,
    issuerBase,
    { faceValue: "1000000", couponRate: "5", maturityTick: 8760, couponIntervalTicks: 4380 },
    "0", // 발행자 자기보유 0 — 전량 투자자에게 배분되었다고 가정
  );
  // 투자자 두 명이 채권을 보유(총 100좌 = alice 60 + bob 40).
  setPosition(state, "alice", "BND1", "60");
  setPosition(state, "bob", "BND1", "40");
  setCash(state, "gov", "USD", "100000000"); // 국고 $1,000,000
  return { state, entry: { security, details } as BondEntry };
}

// --- 쿠폰: 주기(4380틱) 도래 시 보유자에 지급, 발행자 차감 ---
{
  const { state, entry } = setupBond();
  // 반기 쿠폰/좌 = face 1,000,000 × 5% × (4380/8760) = 25,000 minor($250).
  const events = processBonds(state, [entry], { tick: 4380, ticksPerYear: 8760 });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "coupon");
  // alice 60 × 25,000 = 1,500,000 / bob 40 × 25,000 = 1,000,000.
  assert.equal(getCash(state, "alice", "USD"), "1500000");
  assert.equal(getCash(state, "bob", "USD"), "1000000");
  // 국고에서 총 2,500,000 차감.
  assert.equal(getCash(state, "gov", "USD"), "97500000");
}

// --- 비주기 틱에는 아무 일도 없다 ---
{
  const { state, entry } = setupBond();
  const events = processBonds(state, [entry], { tick: 4379, ticksPerYear: 8760 });
  assert.equal(events.length, 0);
  assert.equal(getCash(state, "gov", "USD"), "100000000");
}

// --- 만기: 원금 상환 + 상장폐지 + 포지션 소멸 ---
{
  const { state, entry } = setupBond();
  const events = processBonds(state, [entry], { tick: 8760, ticksPerYear: 8760 });
  assert.equal(events[0]!.kind, "maturity");
  // 원금/좌 = face 1,000,000. alice 60 → 60,000,000 / bob 40 → 40,000,000.
  assert.equal(getCash(state, "alice", "USD"), "60000000");
  assert.equal(getCash(state, "bob", "USD"), "40000000");
  assert.equal(getCash(state, "gov", "USD"), "0"); // 100,000,000 - 100,000,000
  assert.equal(getPosition(state, "alice", "BND1"), "0");
  assert.equal(entry.security.status, "delisted");
}

// --- 디폴트: 국고가 부족하면 default 이벤트, 미지급 ---
{
  const { state, entry } = setupBond();
  setCash(state, "gov", "USD", "1000000"); // 쿠폰 총액 2,500,000에 못 미침
  const events = processBonds(state, [entry], { tick: 4380, ticksPerYear: 8760 });
  assert.equal(events[0]!.kind, "default");
  assert.equal(getCash(state, "alice", "USD"), "0"); // 미지급
  assert.equal(getCash(state, "gov", "USD"), "1000000"); // 불변
}

// --- 통합 틱: 채권 쿠폰 + ETF NAV 스냅샷 동시 ---
{
  const { state, entry } = setupBond();
  const { security: etfSec, details: etfDetails } = issueEtf(
    { id: "ETF1", ticker: "IDX", issuerUserId: "pm", nationId: "N1", exchangeId: "EX1", currency: "USD" },
    [{ securityId: "A", unitsPerShare: "2" }, { securityId: "B", unitsPerShare: "3" }],
  );
  const prices: Record<string, string> = { A: "100", B: "50" };
  const events = runWorldTick(
    state,
    { bonds: [entry], etfs: [{ security: etfSec, details: etfDetails }], priceOf: (id) => prices[id] ?? "0" },
    { tick: 4380, ticksPerYear: 8760 },
  );
  const nav = events.find((e) => e.kind === "nav");
  assert.ok(nav && nav.kind === "nav" && nav.nav === "350"); // 100×2 + 50×3
  assert.ok(events.some((e) => e.kind === "coupon"));
}

console.log("worldTick · coupon · maturity · default · NAV snapshot passed");

import assert from "node:assert";
import { matchOrder, sortRestingBook } from "../src/lib/economy/orderBook";
import {
  createLedger,
  getCash,
  getPosition,
  settleFill,
  setCash,
  setPosition,
} from "../src/lib/economy/ledger";
import type { Order } from "../src/lib/economy/types";

function ask(id: string, owner: string, price: string, qty: string, ts: number): Order {
  return { id, securityId: "SEC", side: "sell", ownerId: owner, limitPrice: price, quantity: qty, ts };
}

// --- 매칭: 가격-시간 우선, 부분체결 ---
{
  // 매도장(메이커): $1.00, $1.00(늦음), $1.02. 가격 오름차순·시간 오름차순 정렬.
  const book = sortRestingBook("sell", [
    ask("a2", "S2", "100", "5", 20),
    ask("a1", "S1", "100", "3", 10),
    ask("a3", "S3", "102", "9", 5),
  ]);
  assert.deepEqual(book.map((o) => o.id), ["a1", "a2", "a3"]);

  // 매수 테이커: 한도 $1.01, 6주. a1(3) 전량 + a2(3/5) 부분체결. a3($1.02)은 한도 초과.
  const r = matchOrder(
    { id: "t1", ownerId: "B", side: "buy", limitPrice: "101", quantity: "6" },
    book,
  );
  assert.equal(r.fills.length, 2);
  assert.equal(r.fills[0]!.makerOrderId, "a1");
  assert.equal(r.fills[0]!.quantity, "3");
  assert.equal(r.fills[0]!.value, "300"); // 100 × 3
  assert.equal(r.fills[1]!.makerOrderId, "a2");
  assert.equal(r.fills[1]!.quantity, "3");
  assert.equal(r.remaining, "0");
  // 남은 장부: a2 잔량 2주 + a3 9주.
  assert.deepEqual(r.restingBook.map((o) => [o.id, o.quantity]), [["a2", "2"], ["a3", "9"]]);
}

// --- 정산: 현금·포지션 이동, 불변식 검증 ---
{
  const state = createLedger();
  setCash(state, "B", "USD", "1000"); // 매수자 $10.00
  setPosition(state, "S", "SEC", "10"); // 매도자 10주 보유

  const fill = {
    makerOrderId: "a1",
    makerId: "S",
    takerId: "B",
    takerSide: "buy" as const,
    price: "100",
    quantity: "4",
    value: "400",
  };
  const res = settleFill(state, fill, "USD", "B", "S", "SEC");
  assert.deepEqual(res, { ok: true });
  assert.equal(getCash(state, "B", "USD"), "600");
  assert.equal(getCash(state, "S", "USD"), "400");
  assert.equal(getPosition(state, "B", "SEC"), "4");
  assert.equal(getPosition(state, "S", "SEC"), "6");

  // 현금 부족 → 상태 불변.
  const poor = settleFill(state, { ...fill, value: "999999" }, "USD", "B", "S", "SEC");
  assert.deepEqual(poor, { ok: false, reason: "insufficient_cash" });
  assert.equal(getCash(state, "B", "USD"), "600");

  // 포지션 부족(공매도 금지) → 거부.
  const naked = settleFill(state, { ...fill, quantity: "100", value: "100" }, "USD", "B", "S", "SEC");
  assert.deepEqual(naked, { ok: false, reason: "insufficient_position" });
}

// --- 큰 수: 천문학적 국부 규모의 체결도 손실 없이 정산 ---
{
  const state = createLedger();
  const bigCash = "9999999999999999999999999999999999999999"; // 2^53 훨씬 초과
  setCash(state, "WHALE", "KRW", bigCash);
  setPosition(state, "ISSUER", "MEGA", "1000000");

  // 가격 1좌 = 1e18 최소단위, 500주 → value = 5e20.
  const fill = {
    makerOrderId: "m", makerId: "ISSUER", takerId: "WHALE", takerSide: "buy" as const,
    price: "1000000000000000000", quantity: "500", value: "500000000000000000000",
  };
  const res = settleFill(state, fill, "KRW", "WHALE", "ISSUER", "MEGA");
  assert.deepEqual(res, { ok: true });
  assert.equal(getCash(state, "WHALE", "KRW"), "9999999999999999999499999999999999999999");
  assert.equal(getCash(state, "ISSUER", "KRW"), "500000000000000000000");
  assert.equal(getPosition(state, "WHALE", "MEGA"), "500");
}

// --- 매칭 → 정산 통합: 소수 수량(6dp) 체결 ---
{
  const state = createLedger();
  setCash(state, "B", "USD", "100000");
  setPosition(state, "S", "ETF1", "2.5");

  const book = sortRestingBook("sell", [ask("q", "S", "250", "2.5", 1)]);
  const m = matchOrder(
    { id: "t", ownerId: "B", side: "buy", limitPrice: "250", quantity: "2.5" },
    book,
  );
  assert.equal(m.fills.length, 1);
  assert.equal(m.fills[0]!.quantity, "2.5");
  assert.equal(m.fills[0]!.value, "625"); // 250 × 2.5
  const s = settleFill(state, m.fills[0]!, "USD", "B", "S", "ETF1");
  assert.deepEqual(s, { ok: true });
  assert.equal(getPosition(state, "B", "ETF1"), "2.5");
  assert.equal(getPosition(state, "S", "ETF1"), "0");
  assert.equal(getCash(state, "B", "USD"), "99375");
}

console.log("economy · order-book matching · settlement · big-number invariants passed");

import assert from "node:assert";
import { routeBuy, routeSell } from "../src/lib/economy/router";
import { matchOrder, sortRestingBook } from "../src/lib/economy/orderBook";
import { exactPositionValue } from "../src/lib/number/exactAmount";
import type { AmmPool } from "../src/lib/economy/amm";
import type { Order } from "../src/lib/economy/types";

function pool(): AmmPool {
  // 현물가 100(=$1.00): reserveQuote 100000 minor, reserveBase 1000.
  return { securityId: "SEC", currency: "USD", reserveBase: "1000", reserveQuote: "100000", totalShares: "1000", feeBps: 0 };
}
function ask(id: string, price: string, qty: string, ts: number): Order {
  return { id, securityId: "SEC", side: "sell", ownerId: "M", limitPrice: price, quantity: qty, ts };
}
function bid(id: string, price: string, qty: string, ts: number): Order {
  return { id, securityId: "SEC", side: "buy", ownerId: "M", limitPrice: price, quantity: qty, ts };
}

// --- 매수: AMM이 CLOB보다 싸면 AMM부터 소진 ---
{
  const asks = [ask("a1", "101", "5", 1), ask("a2", "105", "5", 2)];
  // 3주만 필요 → AMM 현물가 100 < 101이라 전량 AMM.
  const r = routeBuy("3", null, asks, pool());
  assert.equal(r.filled, "3");
  assert.equal(r.remaining, "0");
  assert.ok(r.executions.every((e) => e.source === "amm"), "small buy should route entirely to cheaper AMM");
  // AMM 평균가는 101 미만이어야(그래서 CLOB보다 유리).
  assert.ok(BigInt(r.executions[0]!.price) < 101n);
  // CLOB 호가장은 그대로.
  assert.equal(r.restingBook.length, 2);
}

// --- 매수: 큰 주문은 AMM으로 101까지 담고 나머지는 CLOB 101 소진(분할) ---
{
  const asks = [ask("a1", "101", "5", 1), ask("a2", "105", "5", 2)];
  const r = routeBuy("8", null, asks, pool());
  assert.equal(r.filled, "8");
  const hasAmm = r.executions.some((e) => e.source === "amm");
  const clob = r.executions.filter((e) => e.source === "clob");
  assert.ok(hasAmm, "large buy should use AMM first");
  assert.ok(clob.length >= 1 && clob[0]!.price === "101", "then consume CLOB at 101");
  // 보존: 실행 value 합 == totalValue.
  const total = r.executions.reduce((acc, e) => acc + BigInt(e.value), 0n);
  assert.equal(total.toString(), r.totalValue);
  // 최선체결 검증: 같은 8주를 CLOB만으로 사면 더 비싸다(101×5 + 105×3).
  const clobOnly = BigInt(exactPositionValue("101", "5")) + BigInt(exactPositionValue("105", "3"));
  assert.ok(BigInt(r.totalValue) < clobOnly, `routed ${r.totalValue} should beat CLOB-only ${clobOnly}`);
}

// --- 매수: 한도가(limit)가 AMM/CLOB을 모두 제한 ---
{
  const asks = [ask("a1", "101", "5", 1)];
  // 한도 100.5 → CLOB 101은 초과라 스킵, AMM은 100.5까지만.
  const r = routeBuy("100", "100", asks, pool());
  assert.ok(r.executions.every((e) => e.source === "amm"));
  assert.ok(BigInt(r.remaining.replace(".", "")) > 0n || r.remaining !== "0", "limit should leave some unfilled");
  assert.equal(r.restingBook.length, 1, "over-limit CLOB ask stays");
}

// --- 매도: AMM이 CLOB 매수호가보다 비싸면 AMM부터 처분 ---
{
  const bids = [bid("b1", "99", "5", 1), bid("b2", "95", "5", 2)];
  // AMM 현물가 100 > 99 → 소량 매도는 AMM.
  const r = routeSell("3", null, bids, pool());
  assert.equal(r.filled, "3");
  assert.ok(r.executions.every((e) => e.source === "amm"), "small sell should route to richer AMM");
  // 최선체결: AMM 수취액이 CLOB 최우선호가(99×3)보다 많아야 한다.
  assert.ok(BigInt(r.totalValue) > BigInt(exactPositionValue("99", "3")), `AMM ${r.totalValue} should beat bid-only 297`);
}

// --- 순수 CLOB(풀 없음)에서도 라우터가 정상 동작 ---
{
  const asks = [ask("a1", "101", "5", 1)];
  const r = routeBuy("4", null, asks, null);
  assert.equal(r.filled, "4");
  assert.equal(r.executions.length, 1);
  assert.equal(r.executions[0]!.source, "clob");
  assert.equal(r.pool, null);
  // orderBook.matchOrder와 동일한 CLOB 체결가.
  const m = matchOrder({ id: "t", ownerId: "B", side: "buy", limitPrice: "101", quantity: "4" }, sortRestingBook("sell", asks));
  assert.equal(m.fills[0]!.price, r.executions[0]!.price);
}

console.log("router · CLOB+AMM best execution · split · limit · sell passed");

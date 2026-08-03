/**
 * 거래 액션 — 에스크로(A) 포함 주문/취소 + AMM 유동성 예치.
 *
 * 에스크로 모델: 지정가 주문의 **미체결 잔량**을 호가장에 남길 때 즉시 자산을 잠근다.
 *  - 매수 잔량: 현금(잔량×지정가)을 차감해 잠금. 취소 시 환불.
 *  - 매도 잔량: 주식(잔량)을 차감해 잠금. 취소 시 환불.
 * 그래서 "레스팅 주문 = 에스크로 기록"이 되고, 별도 테이블이 필요 없다. 이 주문이
 * 나중에 메이커로 체결될 때는 이미 잠긴 자산이 상대에게 넘어가므로 **메이커 측을
 * 다시 정산하지 않는다**(이중지출 방지).
 */
import { withTransaction } from "./db";
import { HttpError } from "./errors";
import * as repo from "./repo";
import { routeBuy, routeSell } from "../../src/lib/economy/router";
import { addLiquidity } from "../../src/lib/economy/amm";
import { quantityAdd } from "../../src/lib/economy/ledger";
import {
  exactAdd,
  exactCompare,
  exactPositionValue,
  exactSubtract,
  normalizeExactQuantity,
} from "../../src/lib/number/exactAmount";
import type { Side } from "../../src/lib/economy/types";

function negate(quantity: string): string {
  return `-${normalizeExactQuantity(quantity)}`;
}

export interface PlaceOrderInput {
  orderId: string;
  securityId: string;
  side: Side;
  ownerId: string;
  quantity: string;
  limitPrice: string | null;
}

export async function placeOrder(input: PlaceOrderInput) {
  return withTransaction(async (client) => {
    const sec = await repo.getSecurity(client, input.securityId);
    if (!sec) throw new HttpError(404, "security not found");
    if (sec.status !== "listed") throw new HttpError(409, "security not tradable");
    const currency = sec.currency;

    const book = await repo.loadOppositeBook(client, input.securityId, input.side);
    const poolState = await repo.loadPool(client, input.securityId);
    const originalIds = book.map((o) => o.id);
    const makerOwner = new Map(book.map((o) => [o.id, o.ownerId]));

    const result =
      input.side === "buy"
        ? routeBuy(input.quantity, input.limitPrice, book, poolState)
        : routeSell(input.quantity, input.limitPrice, book, poolState);

    const willRest = input.limitPrice !== null && exactCompare(result.remaining, "0") > 0;

    if (input.side === "buy") {
      const restEscrow = willRest ? exactPositionValue(input.limitPrice as string, result.remaining) : "0";
      const need = exactAdd(result.totalValue, restEscrow);
      const takerCash = await repo.getCash(client, input.ownerId, currency);
      if (exactCompare(takerCash, need) < 0) throw new HttpError(402, "insufficient cash (spend + escrow)");
      await repo.setCash(client, input.ownerId, currency, exactSubtract(takerCash, need));
      await repo.setPosition(client, input.ownerId, input.securityId,
        quantityAdd(await repo.getPosition(client, input.ownerId, input.securityId), result.filled));
      for (const exec of result.executions) {
        if (exec.source === "clob" && exec.makerOrderId) {
          const sellerId = makerOwner.get(exec.makerOrderId)!;
          // 메이커(매도자)의 주식은 호가 등록 때 이미 에스크로됨 → 포지션 재차감 안 함.
          await repo.setCash(client, sellerId, currency, exactAdd(await repo.getCash(client, sellerId, currency), exec.value));
          await repo.insertTrade(client, { securityId: input.securityId, price: exec.price, quantity: exec.quantity, value: exec.value, buyerId: input.ownerId, sellerId, source: "clob", takerSide: "buy" });
        } else {
          await repo.insertTrade(client, { securityId: input.securityId, price: exec.price, quantity: exec.quantity, value: exec.value, buyerId: input.ownerId, sellerId: null, source: "amm", takerSide: "buy" });
        }
      }
    } else {
      const restEscrow = willRest ? normalizeExactQuantity(result.remaining) : "0";
      const needShares = quantityAdd(result.filled, restEscrow);
      const takerPos = await repo.getPosition(client, input.ownerId, input.securityId);
      if (quantityLt(takerPos, needShares)) throw new HttpError(409, "insufficient position (delivered + escrow)");
      await repo.setPosition(client, input.ownerId, input.securityId, quantityAdd(takerPos, negate(needShares)));
      await repo.setCash(client, input.ownerId, currency, exactAdd(await repo.getCash(client, input.ownerId, currency), result.totalValue));
      for (const exec of result.executions) {
        if (exec.source === "clob" && exec.makerOrderId) {
          const buyerId = makerOwner.get(exec.makerOrderId)!;
          // 메이커(매수자)의 현금은 호가 등록 때 이미 에스크로됨 → 현금 재차감 안 함.
          await repo.setPosition(client, buyerId, input.securityId, quantityAdd(await repo.getPosition(client, buyerId, input.securityId), exec.quantity));
          await repo.insertTrade(client, { securityId: input.securityId, price: exec.price, quantity: exec.quantity, value: exec.value, buyerId, sellerId: input.ownerId, source: "clob", takerSide: "sell" });
        } else {
          await repo.insertTrade(client, { securityId: input.securityId, price: exec.price, quantity: exec.quantity, value: exec.value, buyerId: null, sellerId: input.ownerId, source: "amm", takerSide: "sell" });
        }
      }
    }

    await repo.reconcileBook(client, originalIds, result.restingBook);
    if (poolState && result.pool) await repo.upsertPool(client, result.pool);

    if (willRest) {
      await repo.insertResting(client, {
        id: input.orderId, securityId: input.securityId, side: input.side,
        ownerId: input.ownerId, limitPrice: input.limitPrice as string, quantity: result.remaining, ts: Date.now(),
      });
    }
    return result;
  });
}

/** 레스팅 주문 취소 → 에스크로 환불. */
export async function cancelOrder(input: { orderId: string; ownerId?: string }) {
  return withTransaction(async (client) => {
    const order = await repo.loadOrder(client, input.orderId);
    if (!order) throw new HttpError(404, "order not found");
    if (order.status !== "open") throw new HttpError(409, "order not open");
    if (input.ownerId && input.ownerId !== order.ownerId) throw new HttpError(403, "not order owner");
    const sec = await repo.getSecurity(client, order.securityId);
    if (!sec) throw new HttpError(404, "security not found");

    if (order.side === "buy") {
      const refund = exactPositionValue(order.limitPrice, order.quantity);
      await repo.setCash(client, order.ownerId, sec.currency, exactAdd(await repo.getCash(client, order.ownerId, sec.currency), refund));
    } else {
      await repo.setPosition(client, order.ownerId, order.securityId, quantityAdd(await repo.getPosition(client, order.ownerId, order.securityId), order.quantity));
    }
    await repo.setOrderStatus(client, input.orderId, "cancelled");
    return { cancelled: input.orderId };
  });
}

/** AMM 유동성 예치: 발행자/유저가 주식+현금을 풀에 넣고 LP 지분을 받는다. */
export async function provideLiquidity(input: { securityId: string; providerId: string; baseIn: string; quoteIn: string; feeBps?: number }) {
  return withTransaction(async (client) => {
    const sec = await repo.getSecurity(client, input.securityId);
    if (!sec) throw new HttpError(404, "security not found");
    const pool = (await repo.loadPool(client, input.securityId)) ?? {
      securityId: input.securityId, currency: sec.currency, reserveBase: "0", reserveQuote: "0", totalShares: "0", feeBps: input.feeBps ?? 30,
    };

    const providerPos = await repo.getPosition(client, input.providerId, input.securityId);
    if (quantityLt(providerPos, input.baseIn)) throw new HttpError(409, "insufficient shares for liquidity");
    const providerCash = await repo.getCash(client, input.providerId, sec.currency);
    if (exactCompare(providerCash, input.quoteIn) < 0) throw new HttpError(402, "insufficient cash for liquidity");

    const { sharesMinted, pool: next } = addLiquidity(pool, input.baseIn, input.quoteIn);
    await repo.setPosition(client, input.providerId, input.securityId, quantityAdd(providerPos, negate(input.baseIn)));
    await repo.setCash(client, input.providerId, sec.currency, exactSubtract(providerCash, input.quoteIn));
    await repo.upsertPool(client, next);
    await repo.addLpShares(client, input.securityId, input.providerId, sharesMinted, quantityAdd);
    return { sharesMinted, pool: next };
  });
}

// 수량 비교(6dp) — a < b?
function quantityLt(a: string, b: string): boolean {
  const scale = (s: string): bigint => {
    const neg = s.startsWith("-");
    const [w = "0", f = ""] = s.replace("-", "").split(".");
    const micro = BigInt(`${w}${f.padEnd(6, "0").slice(0, 6)}`);
    return neg ? -micro : micro;
  };
  return scale(normalizeExactQuantity(a)) < scale(normalizeExactQuantity(b));
}

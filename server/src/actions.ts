/**
 * 기업 재무 액션(2DStock 금융 시스템의 간소 이식) — 발행자가 조정한다.
 *  - 배당(dividend): 주당 배당금을 즉시 전 보유자에게 지급.
 *  - 액면분할(split): 발행주식·보유·풀을 정수배로 확대(가격은 자연히 1/ratio).
 * "쉽게" 원칙: 옵션·선물·공매도(마진 필요)는 제외, 즉시 반영되는 단순 액션만.
 */
import { withTransaction } from "./db";
import { HttpError } from "./errors";
import * as repo from "./repo";
import { quantityAdd } from "../../src/lib/economy/ledger";
import { exactAdd, exactCompare, exactPositionValue, exactSubtract } from "../../src/lib/number/exactAmount";

/** 배당 선언 = 주당 배당금을 현재 전 보유자에게 즉시 지급(발행자 현금에서). */
export async function declareDividend(input: { securityId: string; issuerId: string; perShare: string }) {
  return withTransaction(async (client) => {
    const sec = await repo.getSecurityFull(client, input.securityId);
    if (!sec) throw new HttpError(404, "security not found");
    if (sec.issuerUserId !== input.issuerId) throw new HttpError(403, "only the issuer can declare a dividend");
    if (exactCompare(input.perShare, "0") <= 0) throw new HttpError(400, "perShare must be positive");

    const holders = await repo.holdersOf(client, input.securityId, input.issuerId);
    let total = "0";
    const payouts = holders.map((h) => {
      const amount = exactPositionValue(input.perShare, h.quantity);
      total = exactAdd(total, amount);
      return { userId: h.userId, amount };
    });

    const issuerCash = await repo.getCash(client, input.issuerId, sec.currency);
    if (exactCompare(issuerCash, total) < 0) throw new HttpError(402, "insufficient cash for dividend");

    await repo.setCash(client, input.issuerId, sec.currency, exactSubtract(issuerCash, total));
    for (const p of payouts) {
      await repo.setCash(client, p.userId, sec.currency, exactAdd(await repo.getCash(client, p.userId, sec.currency), p.amount));
    }
    return { totalPaid: total, holders: payouts.length, currency: sec.currency };
  });
}

/**
 * 액면분할 N:1 (ratio = 정수 ≥ 2). 열린 주문은 에스크로 환불 후 취소하고(가격
 * 분수화 방지), 보유·발행주식수·AMM base 준비금을 ratio배로 확대한다.
 */
export async function splitShares(input: { securityId: string; issuerId: string; ratio: number }) {
  return withTransaction(async (client) => {
    const sec = await repo.getSecurityFull(client, input.securityId);
    if (!sec) throw new HttpError(404, "security not found");
    if (sec.issuerUserId !== input.issuerId) throw new HttpError(403, "only the issuer can split");
    if (!Number.isInteger(input.ratio) || input.ratio < 2) throw new HttpError(400, "ratio must be an integer >= 2");
    const ratio = input.ratio;

    // 열린 주문 취소 + 에스크로 환불.
    const open = await client.query(
      `select id, side, owner_id, limit_price::text as limit_price, quantity::text as quantity
         from orders where security_id = $1 and status = 'open' for update`,
      [input.securityId],
    );
    let cancelled = 0;
    for (const o of open.rows) {
      if (o.side === "buy") {
        const refund = exactPositionValue(o.limit_price, o.quantity);
        await repo.setCash(client, o.owner_id, sec.currency, exactAdd(await repo.getCash(client, o.owner_id, sec.currency), refund));
      } else {
        await repo.setPosition(client, o.owner_id, input.securityId, quantityAdd(await repo.getPosition(client, o.owner_id, input.securityId), o.quantity));
      }
      await repo.setOrderStatus(client, o.id, "cancelled");
      cancelled += 1;
    }

    // 확대(정수배라 numeric 곱은 정확).
    await client.query(`update positions set quantity = quantity * $2 where security_id = $1`, [input.securityId, ratio]);
    await client.query(`update equity_details set shares_outstanding = shares_outstanding * $2 where security_id = $1`, [input.securityId, ratio]);
    await client.query(`update amm_pools set reserve_base = reserve_base * $2 where security_id = $1`, [input.securityId, ratio]);
    return { ratio, cancelledOrders: cancelled };
  });
}

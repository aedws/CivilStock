/**
 * DB 접근 헬퍼 — 순수 코어 도메인 타입 ↔ Postgres 행 변환. 모든 함수는
 * 트랜잭션 Client를 받아 그 트랜잭션 안에서 읽고 쓴다.
 */
import type { Client } from "./db";
import type { AmmPool } from "../../src/lib/economy/amm";
import type { Order, Side } from "../../src/lib/economy/types";

/** 체결 대상 반대편 호가장을 잠그고 로드(FOR UPDATE). */
export async function loadOppositeBook(
  client: Client,
  securityId: string,
  takerSide: Side,
): Promise<Order[]> {
  const makerSide: Side = takerSide === "buy" ? "sell" : "buy";
  const { rows } = await client.query(
    `select id, owner_id, limit_price::text as limit_price, quantity::text as quantity, ts
       from orders
      where security_id = $1 and side = $2 and status = 'open'
      for update`,
    [securityId, makerSide],
  );
  return rows.map((r) => ({
    id: r.id as string,
    securityId,
    side: makerSide,
    ownerId: r.owner_id as string,
    limitPrice: r.limit_price as string,
    quantity: r.quantity as string,
    ts: Number(r.ts),
  }));
}

export async function loadPool(client: Client, securityId: string): Promise<AmmPool | null> {
  const { rows } = await client.query(
    `select currency, reserve_base::text as reserve_base, reserve_quote::text as reserve_quote,
            total_shares::text as total_shares, fee_bps
       from amm_pools where security_id = $1 for update`,
    [securityId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    securityId,
    currency: row.currency as string,
    reserveBase: row.reserve_base as string,
    reserveQuote: row.reserve_quote as string,
    totalShares: row.total_shares as string,
    feeBps: Number(row.fee_bps),
  };
}

export async function savePool(client: Client, poolState: AmmPool): Promise<void> {
  await client.query(
    `update amm_pools
        set reserve_base = $2, reserve_quote = $3, total_shares = $4
      where security_id = $1`,
    [poolState.securityId, poolState.reserveBase, poolState.reserveQuote, poolState.totalShares],
  );
}

export async function getCash(client: Client, userId: string, currency: string): Promise<string> {
  const { rows } = await client.query(
    `select balance::text as balance from cash_ledger where user_id = $1 and currency = $2 for update`,
    [userId, currency],
  );
  return (rows[0]?.balance as string | undefined) ?? "0";
}

export async function setCash(client: Client, userId: string, currency: string, amount: string): Promise<void> {
  await client.query(
    `insert into cash_ledger (user_id, currency, balance) values ($1, $2, $3)
       on conflict (user_id, currency) do update set balance = excluded.balance`,
    [userId, currency, amount],
  );
}

export async function getPosition(client: Client, userId: string, securityId: string): Promise<string> {
  const { rows } = await client.query(
    `select quantity::text as quantity from positions where user_id = $1 and security_id = $2 for update`,
    [userId, securityId],
  );
  return (rows[0]?.quantity as string | undefined) ?? "0";
}

export async function setPosition(client: Client, userId: string, securityId: string, quantity: string): Promise<void> {
  await client.query(
    `insert into positions (user_id, security_id, quantity) values ($1, $2, $3)
       on conflict (user_id, security_id) do update set quantity = excluded.quantity`,
    [userId, securityId, quantity],
  );
}

/** 라우팅 후 살아남은 호가는 잔량 갱신, 소진된 호가는 filled 처리. */
export async function reconcileBook(
  client: Client,
  originalIds: string[],
  survivors: Order[],
): Promise<void> {
  const survivorById = new Map(survivors.map((o) => [o.id, o.quantity]));
  for (const id of originalIds) {
    const remaining = survivorById.get(id);
    if (remaining === undefined) {
      await client.query(`update orders set quantity = 0, status = 'filled' where id = $1`, [id]);
    } else {
      await client.query(`update orders set quantity = $2 where id = $1`, [id, remaining]);
    }
  }
}

export async function insertResting(client: Client, order: Order, status = "open"): Promise<void> {
  await client.query(
    `insert into orders (id, security_id, side, owner_id, limit_price, quantity, ts, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [order.id, order.securityId, order.side, order.ownerId, order.limitPrice, order.quantity, order.ts, status],
  );
}

export async function insertTrade(
  client: Client,
  t: {
    securityId: string;
    price: string;
    quantity: string;
    value: string;
    buyerId: string | null;
    sellerId: string | null;
    source: "clob" | "amm";
    takerSide: Side;
  },
): Promise<void> {
  await client.query(
    `insert into trades (security_id, price, quantity, value, buyer_id, seller_id, source, taker_side)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [t.securityId, t.price, t.quantity, t.value, t.buyerId, t.sellerId, t.source, t.takerSide],
  );
}

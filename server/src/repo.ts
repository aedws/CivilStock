/**
 * DB 접근 헬퍼 — 순수 코어 도메인 타입 ↔ Postgres 행 변환. 모든 함수는
 * 트랜잭션 Client를 받아 그 트랜잭션 안에서 읽고 쓴다.
 */
import type { Client } from "./db";
import type { AmmPool } from "../../src/lib/economy/amm";
import type { Order, Side } from "../../src/lib/economy/types";

// ---- 증권 ----

export async function getSecurity(
  client: Client,
  id: string,
): Promise<{ currency: string; status: string } | null> {
  const { rows } = await client.query(
    `select currency, status from securities where id = $1 for update`,
    [id],
  );
  const row = rows[0];
  return row ? { currency: row.currency, status: row.status } : null;
}

export async function getSecurityFull(
  client: Client,
  id: string,
): Promise<{ issuerUserId: string | null; currency: string; status: string; type: string } | null> {
  const { rows } = await client.query(
    `select issuer_user_id, currency, status, type from securities where id = $1 for update`,
    [id],
  );
  const row = rows[0];
  return row ? { issuerUserId: row.issuer_user_id, currency: row.currency, status: row.status, type: row.type } : null;
}

/** 특정 증권을 양(+) 보유한 유저 목록(배당·쿠폰 대상). excludeUserId는 제외(발행자 자기지분). */
export async function holdersOf(
  client: Client,
  securityId: string,
  excludeUserId?: string,
): Promise<Array<{ userId: string; quantity: string }>> {
  const { rows } = await client.query(
    `select user_id, quantity::text as quantity from positions where security_id = $1 and quantity > 0`,
    [securityId],
  );
  return rows
    .filter((r) => r.user_id !== excludeUserId)
    .map((r) => ({ userId: r.user_id, quantity: r.quantity }));
}

export async function insertSecurity(
  client: Client,
  s: {
    id: string; type: string; ticker: string; issuerUserId: string;
    nationId: string | null; exchangeId: string | null; currency: string;
  },
): Promise<void> {
  await client.query(
    `insert into securities (id, type, ticker, issuer_user_id, nation_id, exchange_id, currency, status)
       values ($1,$2,$3,$4,$5,$6,$7,'listed')`,
    [s.id, s.type, s.ticker, s.issuerUserId, s.nationId, s.exchangeId, s.currency],
  );
}

export async function listSecurities(client: Client): Promise<Array<Record<string, unknown>>> {
  const { rows } = await client.query(
    `select id, type, ticker, issuer_user_id, currency, status from securities order by created_at`,
  );
  return rows;
}

// ---- 국가 ----

export async function insertNation(
  client: Client,
  n: { id: string; name: string; currency: string; ownerId: string },
): Promise<void> {
  await client.query(
    `insert into nations (id, name, currency, owner_user_id) values ($1,$2,$3,$4) on conflict (id) do nothing`,
    [n.id, n.name, n.currency, n.ownerId],
  );
}

export async function listNations(client: Client): Promise<Array<Record<string, unknown>>> {
  const { rows } = await client.query(
    `select n.id, n.name, n.currency, n.owner_user_id, count(s.id)::int as company_count
       from nations n left join securities s on s.nation_id = n.id
      group by n.id order by n.created_at`,
  );
  return rows;
}

export async function getNation(client: Client, id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await client.query(`select id, name, currency, owner_user_id from nations where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listSecuritiesByNation(client: Client, nationId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await client.query(
    `select id, type, ticker, issuer_user_id, currency, status from securities where nation_id = $1 order by created_at`,
    [nationId],
  );
  return rows;
}

// ---- 영토(육각 타일) ----

/** axial 이웃 6개. */
export function axialNeighbors(q: number, r: number): Array<[number, number]> {
  return [[q + 1, r], [q - 1, r], [q, r + 1], [q, r - 1], [q + 1, r - 1], [q - 1, r + 1]];
}

export async function getTerritory(client: Client, q: number, r: number): Promise<{ nationId: string | null } | null> {
  const { rows } = await client.query(`select nation_id from territories where q = $1 and r = $2 for update`, [q, r]);
  return rows[0] ? { nationId: rows[0].nation_id } : null;
}

export async function claimTerritory(client: Client, q: number, r: number, nationId: string): Promise<void> {
  await client.query(
    `insert into territories (q, r, nation_id) values ($1,$2,$3)
       on conflict (q, r) do update set nation_id = excluded.nation_id, claimed_at = now()`,
    [q, r, nationId],
  );
}

export async function listTerritories(client: Client): Promise<Array<Record<string, unknown>>> {
  const { rows } = await client.query(
    `select t.q, t.r, t.nation_id, n.name as nation_name, n.owner_user_id
       from territories t join nations n on n.id = t.nation_id`,
  );
  return rows;
}

/** nationId가 (q,r)의 6이웃 중 하나라도 이미 점유하고 있는가(확장 인접성). */
export async function nationOwnsAdjacent(client: Client, q: number, r: number, nationId: string): Promise<boolean> {
  const nb = axialNeighbors(q, r);
  const params: unknown[] = [nationId];
  const tuples = nb.map((n) => { params.push(n[0], n[1]); return `($${params.length - 1},$${params.length})`; });
  const { rows } = await client.query(
    `select 1 from territories where nation_id = $1 and (q, r) in (${tuples.join(",")}) limit 1`,
    params,
  );
  return rows.length > 0;
}

// ---- 계정: 유저 / 현금 / 포지션 ----

export async function upsertUser(client: Client, id: string, handle: string | null): Promise<void> {
  await client.query(
    `insert into users (id, handle) values ($1, $2) on conflict (id) do nothing`,
    [id, handle],
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

export async function getAccount(
  client: Client,
  userId: string,
): Promise<{ cash: Array<Record<string, unknown>>; positions: Array<Record<string, unknown>> }> {
  const cash = await client.query(
    `select currency, balance::text as balance from cash_ledger where user_id = $1`,
    [userId],
  );
  const positions = await client.query(
    `select security_id, quantity::text as quantity from positions where user_id = $1 and quantity <> 0`,
    [userId],
  );
  return { cash: cash.rows, positions: positions.rows };
}

// ---- 호가장(CLOB) ----

export async function loadOppositeBook(client: Client, securityId: string, takerSide: Side): Promise<Order[]> {
  const makerSide: Side = takerSide === "buy" ? "sell" : "buy";
  const { rows } = await client.query(
    `select id, owner_id, limit_price::text as limit_price, quantity::text as quantity, ts
       from orders where security_id = $1 and side = $2 and status = 'open' for update`,
    [securityId, makerSide],
  );
  return rows.map((r) => ({
    id: r.id, securityId, side: makerSide, ownerId: r.owner_id,
    limitPrice: r.limit_price, quantity: r.quantity, ts: Number(r.ts),
  }));
}

export async function loadOrder(
  client: Client,
  id: string,
): Promise<{ securityId: string; side: Side; ownerId: string; limitPrice: string; quantity: string; status: string } | null> {
  const { rows } = await client.query(
    `select security_id, side, owner_id, limit_price::text as limit_price, quantity::text as quantity, status
       from orders where id = $1 for update`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return { securityId: r.security_id, side: r.side, ownerId: r.owner_id, limitPrice: r.limit_price, quantity: r.quantity, status: r.status };
}

export async function reconcileBook(client: Client, originalIds: string[], survivors: Order[]): Promise<void> {
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
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [order.id, order.securityId, order.side, order.ownerId, order.limitPrice, order.quantity, order.ts, status],
  );
}

export async function setOrderStatus(client: Client, id: string, status: string): Promise<void> {
  await client.query(`update orders set status = $2 where id = $1`, [id, status]);
}

export async function topOfBook(client: Client, securityId: string, side: Side, limit = 10): Promise<Array<Record<string, unknown>>> {
  const order = side === "buy" ? "desc" : "asc";
  const { rows } = await client.query(
    `select id, owner_id, limit_price::text as price, quantity::text as quantity
       from orders where security_id = $1 and side = $2 and status = 'open'
      order by limit_price ${order}, ts asc limit $3`,
    [securityId, side, limit],
  );
  return rows;
}

export async function insertTrade(
  client: Client,
  t: { securityId: string; price: string; quantity: string; value: string; buyerId: string | null; sellerId: string | null; source: "clob" | "amm"; takerSide: Side; tick?: number | null },
): Promise<void> {
  await client.query(
    `insert into trades (security_id, price, quantity, value, buyer_id, seller_id, source, taker_side, tick)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [t.securityId, t.price, t.quantity, t.value, t.buyerId, t.sellerId, t.source, t.takerSide, t.tick ?? null],
  );
}

export async function recentTrades(client: Client, securityId: string, limit = 20): Promise<Array<Record<string, unknown>>> {
  const { rows } = await client.query(
    `select price::text as price, quantity::text as quantity, source, taker_side, created_at
       from trades where security_id = $1 order by id desc limit $2`,
    [securityId, limit],
  );
  return rows;
}

// ---- AMM ----

export async function loadPool(client: Client, securityId: string): Promise<AmmPool | null> {
  const { rows } = await client.query(
    `select currency, reserve_base::text as reserve_base, reserve_quote::text as reserve_quote,
            total_shares::text as total_shares, fee_bps
       from amm_pools where security_id = $1 for update`,
    [securityId],
  );
  const row = rows[0];
  if (!row) return null;
  return { securityId, currency: row.currency, reserveBase: row.reserve_base, reserveQuote: row.reserve_quote, totalShares: row.total_shares, feeBps: Number(row.fee_bps) };
}

export async function upsertPool(client: Client, poolState: AmmPool): Promise<void> {
  await client.query(
    `insert into amm_pools (security_id, currency, reserve_base, reserve_quote, total_shares, fee_bps)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (security_id) do update
         set reserve_base = excluded.reserve_base, reserve_quote = excluded.reserve_quote,
             total_shares = excluded.total_shares`,
    [poolState.securityId, poolState.currency, poolState.reserveBase, poolState.reserveQuote, poolState.totalShares, poolState.feeBps],
  );
}

export async function addLpShares(client: Client, securityId: string, userId: string, minted: string, quantityAdd: (a: string, b: string) => string): Promise<void> {
  const { rows } = await client.query(
    `select shares::text as shares from amm_lp_positions where security_id = $1 and user_id = $2 for update`,
    [securityId, userId],
  );
  const current = (rows[0]?.shares as string | undefined) ?? "0";
  await client.query(
    `insert into amm_lp_positions (security_id, user_id, shares) values ($1,$2,$3)
       on conflict (security_id, user_id) do update set shares = excluded.shares`,
    [securityId, userId, quantityAdd(current, minted)],
  );
}

// ---- world (틱 시계) ----

export async function ensureWorld(client: Client, epochMs: number, tickSeconds: number): Promise<{ epochMs: number; tickSeconds: number; lastProcessedTick: number }> {
  await client.query(
    `insert into world (id, epoch_ms, tick_seconds) values (1, $1, $2) on conflict (id) do nothing`,
    [epochMs, tickSeconds],
  );
  const { rows } = await client.query(`select epoch_ms, tick_seconds, last_processed_tick from world where id = 1 for update`);
  const r = rows[0];
  return { epochMs: Number(r.epoch_ms), tickSeconds: Number(r.tick_seconds), lastProcessedTick: Number(r.last_processed_tick) };
}

export async function setLastProcessedTick(client: Client, tick: number): Promise<void> {
  await client.query(`update world set last_processed_tick = $1 where id = 1`, [tick]);
}

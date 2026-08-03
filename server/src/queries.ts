/** 조회 액션 — UI가 시장·계정을 읽는다(읽기 전용, 트랜잭션 불필요). */
import { pool } from "./db";
import * as repo from "./repo";
import { spotPrice, type AmmPool } from "../../src/lib/economy/amm";

export async function listSecurities() {
  const client = await pool.connect();
  try {
    return await repo.listSecurities(client);
  } finally {
    client.release();
  }
}

export async function getAccount(userId: string) {
  const client = await pool.connect();
  try {
    const cash = await client.query(
      `select currency, balance::text as balance from cash_ledger where user_id = $1`,
      [userId],
    );
    const pos = await client.query(
      `select p.security_id, p.quantity::text as quantity, s.ticker, s.currency
         from positions p join securities s on s.id = p.security_id
        where p.user_id = $1 and p.quantity <> 0`,
      [userId],
    );
    const positions = [];
    for (const p of pos.rows) {
      // 현재가: 최신 시세 이력 → 없으면 AMM 현물가.
      const pt = await client.query(`select price::text as price from price_ticks where security_id = $1 order by id desc limit 1`, [p.security_id]);
      let price = (pt.rows[0]?.price as string | undefined) ?? null;
      if (price == null) {
        const pl = await client.query(`select reserve_base::text as rb, reserve_quote::text as rq from amm_pools where security_id = $1`, [p.security_id]);
        if (pl.rows[0]) { const b = Number(pl.rows[0].rb), q = Number(pl.rows[0].rq); if (b > 0) price = String(Math.round(q / b)); }
      }
      // 평단가: 유저 체결 이력을 시간순 재생(가중평균).
      const tr = await client.query(
        `select price::text as price, quantity::text as quantity, buyer_id, seller_id
           from trades where security_id = $1 and (buyer_id = $2 or seller_id = $2) order by id`,
        [p.security_id, userId],
      );
      let tq = 0, tc = 0;
      for (const t of tr.rows) {
        const pr = Number(t.price), q = Number(t.quantity);
        if (t.buyer_id === userId) { tc += pr * q; tq += q; }
        else if (t.seller_id === userId) { const avg = tq > 0 ? tc / tq : 0; tc = Math.max(0, tc - avg * q); tq = Math.max(0, tq - q); }
      }
      const avgCost = tq > 0 ? Math.round(tc / tq) : 0;
      positions.push({ security_id: p.security_id, ticker: p.ticker, currency: p.currency, quantity: p.quantity, price, avg_cost: String(avgCost) });
    }
    return { cash: cash.rows, positions };
  } finally {
    client.release();
  }
}

export async function getMarket(securityId: string) {
  const client = await pool.connect();
  try {
    const poolState = await repo.loadPool(client, securityId);
    const bids = await repo.topOfBook(client, securityId, "buy");
    const asks = await repo.topOfBook(client, securityId, "sell");
    const trades = await repo.recentTrades(client, securityId);
    const ammSpot = poolState ? spotPrice(poolState) : null;
    const eq = await client.query(`select shares_outstanding::text as s from equity_details where security_id = $1`, [securityId]);
    const sharesOutstanding = (eq.rows[0]?.s as string | undefined) ?? null;
    const history = await repo.listPriceHistory(client, securityId, 150);
    return { pool: poolState as AmmPool | null, ammSpot, sharesOutstanding, bids, asks, trades, history };
  } finally {
    client.release();
  }
}

export async function listNations() {
  const client = await pool.connect();
  try {
    return await repo.listNations(client);
  } finally {
    client.release();
  }
}

export async function getMap() {
  const client = await pool.connect();
  try {
    const territories = await repo.listTerritories(client);
    const nations = await repo.listNations(client);
    return { cols: 14, rows: 9, territories, nations };
  } finally {
    client.release();
  }
}

export async function getNationDetail(id: string) {
  const client = await pool.connect();
  try {
    const nation = await repo.getNation(client, id);
    if (!nation) return { nation: null, securities: [] };
    const securities = await repo.listSecuritiesByNation(client, id);
    return { nation, securities };
  } finally {
    client.release();
  }
}

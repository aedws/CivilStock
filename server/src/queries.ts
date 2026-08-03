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
    return await repo.getAccount(client, userId);
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

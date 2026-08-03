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
    return { pool: poolState as AmmPool | null, ammSpot, bids, asks, trades };
  } finally {
    client.release();
  }
}

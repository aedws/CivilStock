/**
 * worldTick 자동화(C) — 서버가 기원점(epoch) 기준 경과 시간으로 현재 tick을
 * 산출하고, 마지막 처리 tick 이후 밀린 틱을 따라잡아 처리한다. Cloud Scheduler는
 * body 없이 /tick을 주기적으로 두드리기만 하면 된다. tick_log로 멱등.
 */
import { withTransaction } from "./db";
import * as repo from "./repo";
import { config } from "./config";
import { processBonds, type BondEntry, type TickEvent } from "../../src/lib/economy/worldTick";
import { createLedger, setCash as memSetCash, setPosition as memSetPosition } from "../../src/lib/economy/ledger";
import type { Client } from "./db";

export async function getWorld() {
  return withTransaction(async (client) => {
    const world = await repo.ensureWorld(client, Date.now(), config.tickSeconds);
    const currentTick = Math.floor((Date.now() - world.epochMs) / (world.tickSeconds * 1000));
    return { ...world, currentTick };
  });
}

/** 밀린 틱을 현재까지 따라잡아 처리한다(최대 maxCatchupTicks). */
export async function runDueTicks() {
  return withTransaction(async (client) => {
    const world = await repo.ensureWorld(client, Date.now(), config.tickSeconds);
    const currentTick = Math.floor((Date.now() - world.epochMs) / (world.tickSeconds * 1000));
    const from = world.lastProcessedTick + 1;
    const to = Math.min(currentTick, world.lastProcessedTick + config.maxCatchupTicks);

    const events: TickEvent[] = [];
    let processed = world.lastProcessedTick;
    for (let tick = from; tick <= to; tick += 1) {
      const claim = await client.query(
        `insert into tick_log (tick) values ($1) on conflict (tick) do nothing returning tick`,
        [tick],
      );
      if (claim.rowCount !== 0) {
        const tickEvents = await processTick(client, tick);
        await client.query(`update tick_log set events = $2 where tick = $1`, [tick, JSON.stringify(tickEvents)]);
        events.push(...tickEvents);
      }
      processed = tick;
    }
    if (processed > world.lastProcessedTick) await repo.setLastProcessedTick(client, processed);
    return { currentTick, processedFrom: from <= to ? from : null, processedTo: processed, events };
  });
}

/** NPC(system 발행) 종목 시세를 소폭 랜덤워크시켜 시장을 살아 움직이게 한다. */
async function driftNpcMarkets(client: Client): Promise<void> {
  const { rows } = await client.query(
    `select p.security_id, p.reserve_base::text as rb, p.reserve_quote::text as rq
       from amm_pools p join securities s on s.id = p.security_id
      where s.issuer_user_id is null and s.status = 'listed'`,
  );
  for (const r of rows) {
    const base = Number(r.rb);
    const quote = Number(r.rq);
    if (!(base > 0) || !(quote > 0)) continue;
    const factor = 1 + (Math.random() - 0.5) * 0.06; // ±3%
    const newQuote = Math.max(1, Math.round(quote * factor));
    await client.query(`update amm_pools set reserve_quote = $2 where security_id = $1`, [r.security_id, String(newQuote)]);
    const spot = Math.max(1, Math.round(newQuote / base));
    await repo.insertPriceTick(client, r.security_id, String(spot));
  }
}

/** 한 틱의 채권 쿠폰·만기·디폴트 처리 + NPC 시세 드리프트. */
async function processTick(client: Client, tick: number): Promise<TickEvent[]> {
  await driftNpcMarkets(client);
  const bres = await client.query(
    `select s.id, s.ticker, s.issuer_user_id, s.nation_id, s.exchange_id, s.currency, s.status,
            b.face_value::text as face_value, b.coupon_rate::text as coupon_rate,
            b.maturity_tick as maturity_tick, b.coupon_interval_ticks as coupon_interval_ticks
       from securities s join bond_details b on b.security_id = s.id
      where s.status = 'listed' and s.type = 'bond'`,
  );
  if (bres.rows.length === 0) return [];

  const bonds: BondEntry[] = bres.rows.map((r) => ({
    security: { id: r.id, type: "bond", ticker: r.ticker, issuerUserId: r.issuer_user_id, nationId: r.nation_id, exchangeId: r.exchange_id, currency: r.currency, status: r.status },
    details: { securityId: r.id, faceValue: r.face_value, couponRate: r.coupon_rate, maturityTick: Number(r.maturity_tick), couponIntervalTicks: Number(r.coupon_interval_ticks) },
  }));

  const state = createLedger();
  const cashPairs = new Set<string>();
  for (const b of bonds) {
    const holders = await client.query(`select user_id, quantity::text as quantity from positions where security_id = $1 and quantity > 0`, [b.security.id]);
    for (const h of holders.rows) {
      memSetPosition(state, h.user_id, b.security.id, h.quantity);
      cashPairs.add(`${h.user_id}|${b.security.currency}`);
    }
    if (b.security.issuerUserId) cashPairs.add(`${b.security.issuerUserId}|${b.security.currency}`);
  }
  for (const pair of cashPairs) {
    const [userId, currency] = pair.split("|") as [string, string];
    memSetCash(state, userId, currency, await repo.getCash(client, userId, currency));
  }

  const events = processBonds(state, bonds, { tick, ticksPerYear: config.ticksPerYear });

  for (const [userId, byCurrency] of state.cash) {
    for (const [currency, balance] of byCurrency) await repo.setCash(client, userId, currency, balance);
  }
  for (const [userId, bySecurity] of state.positions) {
    for (const [securityId, quantity] of bySecurity) await repo.setPosition(client, userId, securityId, quantity);
  }
  for (const b of bonds) {
    await client.query(`update securities set status = $2 where id = $1`, [b.security.id, b.security.status]);
  }
  return events;
}

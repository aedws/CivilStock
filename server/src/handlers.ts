/**
 * 권위 액션 핸들러 — 순수 코어(라우터/원장/worldTick)를 Postgres 트랜잭션으로 감싼다.
 *
 * 패턴(대표: placeOrder): 트랜잭션에서 관련 상태를 FOR UPDATE로 잠그고 로드 →
 * 순수 코어로 결과 계산 → 결과를 DB에 영속화 → 커밋. 다른 액션(발행·ETF 생성 등)도
 * 동일 레시피를 따른다.
 */
import { withTransaction } from "./db";
import {
  getCash,
  getPosition,
  insertResting,
  insertTrade,
  loadOppositeBook,
  loadPool,
  reconcileBook,
  savePool,
  setCash,
  setPosition,
} from "./repo";
import { routeBuy, routeSell, type RouteResult } from "../../src/lib/economy/router";
import { processBonds, type BondEntry, type TickEvent } from "../../src/lib/economy/worldTick";
import {
  createLedger,
  quantityAdd,
  setCash as memSetCash,
  setPosition as memSetPosition,
} from "../../src/lib/economy/ledger";
import {
  exactAdd,
  exactCompare,
  exactSubtract,
  normalizeExactQuantity,
} from "../../src/lib/number/exactAmount";
import type { Side } from "../../src/lib/economy/types";
import { config } from "./config";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

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

/** 주문 접수: CLOB+AMM 최선체결 후 원장·호가장·풀·체결기록을 원자 반영. */
export async function placeOrder(input: PlaceOrderInput): Promise<RouteResult> {
  return withTransaction(async (client) => {
    const secRes = await client.query(
      `select currency, status from securities where id = $1 for update`,
      [input.securityId],
    );
    const sec = secRes.rows[0];
    if (!sec) throw new HttpError(404, "security not found");
    if (sec.status !== "listed") throw new HttpError(409, "security not tradable");
    const currency = sec.currency as string;

    const book = await loadOppositeBook(client, input.securityId, input.side);
    const poolState = await loadPool(client, input.securityId);
    const originalIds = book.map((o) => o.id);
    const makerOwner = new Map(book.map((o) => [o.id, o.ownerId]));

    const result =
      input.side === "buy"
        ? routeBuy(input.quantity, input.limitPrice, book, poolState)
        : routeSell(input.quantity, input.limitPrice, book, poolState);

    if (input.side === "buy") {
      const takerCash = await getCash(client, input.ownerId, currency);
      if (exactCompare(takerCash, result.totalValue) < 0) {
        throw new HttpError(402, "insufficient cash");
      }
      await setCash(client, input.ownerId, currency, exactSubtract(takerCash, result.totalValue));
      await setPosition(
        client,
        input.ownerId,
        input.securityId,
        quantityAdd(await getPosition(client, input.ownerId, input.securityId), result.filled),
      );
      for (const exec of result.executions) {
        if (exec.source === "clob" && exec.makerOrderId) {
          const sellerId = makerOwner.get(exec.makerOrderId)!;
          await setCash(client, sellerId, currency, exactAdd(await getCash(client, sellerId, currency), exec.value));
          await setPosition(
            client,
            sellerId,
            input.securityId,
            quantityAdd(await getPosition(client, sellerId, input.securityId), negate(exec.quantity)),
          );
          await insertTrade(client, { securityId: input.securityId, price: exec.price, quantity: exec.quantity, value: exec.value, buyerId: input.ownerId, sellerId, source: "clob", takerSide: "buy" });
        } else {
          await insertTrade(client, { securityId: input.securityId, price: exec.price, quantity: exec.quantity, value: exec.value, buyerId: input.ownerId, sellerId: null, source: "amm", takerSide: "buy" });
        }
      }
    } else {
      const takerPosition = await getPosition(client, input.ownerId, input.securityId);
      if (exactCompare(takerPosition, result.filled) < 0) {
        throw new HttpError(409, "insufficient position (no naked short in skeleton)");
      }
      await setPosition(client, input.ownerId, input.securityId, quantityAdd(takerPosition, negate(result.filled)));
      await setCash(client, input.ownerId, currency, exactAdd(await getCash(client, input.ownerId, currency), result.totalValue));
      for (const exec of result.executions) {
        if (exec.source === "clob" && exec.makerOrderId) {
          const buyerId = makerOwner.get(exec.makerOrderId)!;
          await setCash(client, buyerId, currency, exactSubtract(await getCash(client, buyerId, currency), exec.value));
          await setPosition(
            client,
            buyerId,
            input.securityId,
            quantityAdd(await getPosition(client, buyerId, input.securityId), exec.quantity),
          );
          await insertTrade(client, { securityId: input.securityId, price: exec.price, quantity: exec.quantity, value: exec.value, buyerId, sellerId: input.ownerId, source: "clob", takerSide: "sell" });
        } else {
          await insertTrade(client, { securityId: input.securityId, price: exec.price, quantity: exec.quantity, value: exec.value, buyerId: null, sellerId: input.ownerId, source: "amm", takerSide: "sell" });
        }
      }
    }

    await reconcileBook(client, originalIds, result.restingBook);
    if (poolState && result.pool) await savePool(client, result.pool);

    // 지정가 잔량은 테이커가 메이커가 되어 호가장에 남긴다(시장가는 소멸).
    // NOTE(escrow): 실서비스는 지정가 접수 시점에 현금(매수)/주식(매도)을 에스크로해야
    // 이중지출을 막는다. 스켈레톤은 즉시 체결분만 정산하고 잔량 에스크로는 TODO.
    if (input.limitPrice !== null && exactCompare(result.remaining, "0") > 0) {
      await insertResting(client, {
        id: input.orderId,
        securityId: input.securityId,
        side: input.side,
        ownerId: input.ownerId,
        limitPrice: input.limitPrice,
        quantity: result.remaining,
        ts: Date.now(),
      });
    }

    return result;
  });
}

/** worldTick: 멱등 처리(같은 틱 재호출 무시) + 채권 쿠폰·만기·디폴트. */
export async function runTick(tick: number): Promise<{ status: string; tick: number; events?: TickEvent[] }> {
  return withTransaction(async (client) => {
    const claim = await client.query(
      `insert into tick_log (tick) values ($1) on conflict (tick) do nothing returning tick`,
      [tick],
    );
    if (claim.rowCount === 0) return { status: "already_processed", tick };

    const bres = await client.query(
      `select s.id, s.ticker, s.issuer_user_id, s.nation_id, s.exchange_id, s.currency, s.status,
              b.face_value::text as face_value, b.coupon_rate::text as coupon_rate,
              b.maturity_tick as maturity_tick, b.coupon_interval_ticks as coupon_interval_ticks
         from securities s
         join bond_details b on b.security_id = s.id
        where s.status = 'listed' and s.type = 'bond'`,
    );

    const bonds: BondEntry[] = bres.rows.map((r) => ({
      security: {
        id: r.id, type: "bond", ticker: r.ticker, issuerUserId: r.issuer_user_id,
        nationId: r.nation_id, exchangeId: r.exchange_id, currency: r.currency, status: r.status,
      },
      details: {
        securityId: r.id, faceValue: r.face_value, couponRate: r.coupon_rate,
        maturityTick: Number(r.maturity_tick), couponIntervalTicks: Number(r.coupon_interval_ticks),
      },
    }));

    // 관련 유저(발행자+보유자)의 현금·포지션을 메모리 원장으로 로드.
    const state = createLedger();
    const cashPairs = new Set<string>();
    for (const b of bonds) {
      const holders = await client.query(
        `select user_id, quantity::text as quantity from positions where security_id = $1 and quantity > 0`,
        [b.security.id],
      );
      for (const h of holders.rows) {
        memSetPosition(state, h.user_id, b.security.id, h.quantity);
        cashPairs.add(`${h.user_id}|${b.security.currency}`);
      }
      if (b.security.issuerUserId) cashPairs.add(`${b.security.issuerUserId}|${b.security.currency}`);
    }
    for (const pair of cashPairs) {
      const [userId, currency] = pair.split("|") as [string, string];
      const cash = await getCash(client, userId, currency);
      memSetCash(state, userId, currency, cash);
    }

    const events = processBonds(state, bonds, { tick, ticksPerYear: config.ticksPerYear });

    // 메모리 원장 → DB 영속화.
    for (const [userId, byCurrency] of state.cash) {
      for (const [currency, balance] of byCurrency) {
        await setCash(client, userId, currency, balance);
      }
    }
    for (const [userId, bySecurity] of state.positions) {
      for (const [securityId, quantity] of bySecurity) {
        await setPosition(client, userId, securityId, quantity);
      }
    }
    // 상태 변경(만기 상장폐지 등) 반영.
    for (const b of bonds) {
      await client.query(`update securities set status = $2 where id = $1`, [b.security.id, b.security.status]);
    }
    await client.query(`update tick_log set events = $2 where tick = $1`, [tick, JSON.stringify(events)]);

    return { status: "processed", tick, events };
  });
}

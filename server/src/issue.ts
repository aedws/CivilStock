/**
 * 발행 액션(B) — 유저가 계정을 만들고 주식·채권·ETF를 직접 발행한다.
 * 발행 = 상품 레코드 생성 + 발행자 포지션 크레딧. 판매·유동성은 거래 액션이 담당.
 */
import { withTransaction } from "./db";
import { HttpError } from "./errors";
import * as repo from "./repo";
import { quantityAdd } from "../../src/lib/economy/ledger";
import { normalizeExactQuantity } from "../../src/lib/number/exactAmount";

/** 계정 생성(+테스트용 초기 현금 지급 옵션). */
export async function createAccount(input: { userId: string; handle?: string; grantCash?: string; currency?: string }) {
  return withTransaction(async (client) => {
    await repo.upsertUser(client, input.userId, input.handle ?? null);
    if (input.grantCash && input.currency) {
      const cur = await repo.getCash(client, input.userId, input.currency);
      await repo.setCash(client, input.userId, input.currency, addAmount(cur, input.grantCash));
    }
    return { userId: input.userId };
  });
}

function addAmount(a: string, b: string): string {
  return (BigInt(a || "0") + BigInt(b || "0")).toString();
}

interface IssueBase {
  id: string; ticker: string; issuerUserId: string;
  nationId?: string | null; exchangeId?: string | null; currency: string;
}

/** 주식 발행(IPO): 발행자에게 총 발행주식 크레딧. */
export async function issueEquity(input: IssueBase & { sharesOutstanding: string }) {
  return withTransaction(async (client) => {
    await ensureIssuer(client, input.issuerUserId);
    await repo.insertSecurity(client, { ...base(input, "equity") });
    await client.query(`insert into equity_details (security_id, shares_outstanding) values ($1, $2)`, [input.id, normalizeExactQuantity(input.sharesOutstanding)]);
    await repo.setPosition(client, input.issuerUserId, input.id,
      quantityAdd(await repo.getPosition(client, input.issuerUserId, input.id), input.sharesOutstanding));
    return { securityId: input.id, sharesOutstanding: normalizeExactQuantity(input.sharesOutstanding) };
  });
}

/** 채권 발행: 발행자에게 총 발행좌수 크레딧. */
export async function issueBond(input: IssueBase & { faceValue: string; couponRate: string; maturityTick: number; couponIntervalTicks: number; unitsIssued: string }) {
  return withTransaction(async (client) => {
    await ensureIssuer(client, input.issuerUserId);
    await repo.insertSecurity(client, { ...base(input, "bond") });
    await client.query(
      `insert into bond_details (security_id, face_value, coupon_rate, maturity_tick, coupon_interval_ticks) values ($1,$2,$3,$4,$5)`,
      [input.id, input.faceValue, input.couponRate, input.maturityTick, input.couponIntervalTicks],
    );
    await repo.setPosition(client, input.issuerUserId, input.id,
      quantityAdd(await repo.getPosition(client, input.issuerUserId, input.id), input.unitsIssued));
    return { securityId: input.id };
  });
}

/** ETF 발행: 구성종목·비중 정의(생성/상환은 별도). */
export async function issueEtf(input: IssueBase & { constituents: Array<{ securityId: string; unitsPerShare: string }> }) {
  return withTransaction(async (client) => {
    await ensureIssuer(client, input.issuerUserId);
    await repo.insertSecurity(client, { ...base(input, "etf") });
    await client.query(`insert into etf_details (security_id, constituents) values ($1, $2)`, [input.id, JSON.stringify(input.constituents)]);
    return { securityId: input.id };
  });
}

function base(input: IssueBase, type: string) {
  return { id: input.id, type, ticker: input.ticker, issuerUserId: input.issuerUserId, nationId: input.nationId ?? null, exchangeId: input.exchangeId ?? null, currency: input.currency };
}

async function ensureIssuer(client: Parameters<typeof repo.upsertUser>[0], userId: string): Promise<void> {
  await repo.upsertUser(client, userId, null);
}

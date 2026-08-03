/**
 * 국가 레이어 + 세계 지도(영토). 유저가 빈 육각 타일에 건국하고, 인접 타일로
 * 영토를 확장한다. 국가 설립 = 국가 + 수도 타일 + 건국자 계정·초기 국고.
 */
import { withTransaction } from "./db";
import type { Client } from "./db";
import { HttpError } from "./errors";
import * as repo from "./repo";

/**
 * 신생국 기본 상장사 세트 — 건국 즉시 살아있는 증시를 만든다. 유저가 회사 발행·
 * 유동성 예치를 손수 하지 않아도 바로 매매할 수 있게 하는 진입장벽 완화 장치.
 * 각 종목은 NPC(system) 발행 + AMM 풀 시드로 즉시 거래 가능. spot = quote/base.
 */
const SEED_COMPANIES = [
  { suffix: "agri", name: "농산", shares: "1000000", base: "2000", quote: "200000" }, // $1.00
  { suffix: "steel", name: "강철", shares: "800000", base: "1500", quote: "375000" }, // $2.50
  { suffix: "power", name: "전력", shares: "600000", base: "1000", quote: "500000" }, // $5.00
  { suffix: "chip", name: "반도체", shares: "500000", base: "800", quote: "960000" }, // $12.00
  { suffix: "bank", name: "은행", shares: "2000000", base: "3000", quote: "240000" }, // $0.80
  { suffix: "ship", name: "해운", shares: "1500000", base: "4000", quote: "140000" }, // $0.35
] as const;

async function bootstrapMarket(client: Client, nationId: string, currency: string): Promise<number> {
  for (const c of SEED_COMPANIES) {
    const id = `${nationId}_${c.suffix}`;
    await client.query(
      `insert into securities (id, type, ticker, issuer_user_id, nation_id, currency, status)
         values ($1, 'equity', $2, null, $3, $4, 'listed') on conflict (id) do nothing`,
      [id, c.name, nationId, currency],
    );
    await client.query(
      `insert into equity_details (security_id, shares_outstanding) values ($1, $2) on conflict (security_id) do nothing`,
      [id, c.shares],
    );
    await client.query(
      `insert into amm_pools (security_id, currency, reserve_base, reserve_quote, total_shares, fee_bps)
         values ($1, $2, $3, $4, $3, 30) on conflict (security_id) do nothing`,
      [id, currency, c.base, c.quote],
    );
  }
  return SEED_COMPANIES.length;
}

export async function foundNation(input: {
  id: string; name: string; currency: string; ownerId: string;
  grantCash?: string; capitalQ?: number; capitalR?: number;
}) {
  return withTransaction(async (client) => {
    if (!input.name.trim()) throw new HttpError(400, "nation name required");
    if (await repo.getNation(client, input.id)) throw new HttpError(409, "nation id already exists");

    const hasCapital = Number.isInteger(input.capitalQ) && Number.isInteger(input.capitalR);
    if (hasCapital) {
      const tile = await repo.getTerritory(client, input.capitalQ!, input.capitalR!);
      if (tile && tile.nationId) throw new HttpError(409, "tile already occupied");
    }

    await repo.upsertUser(client, input.ownerId, null);
    await repo.insertNation(client, input);
    if (input.grantCash) {
      const cur = await repo.getCash(client, input.ownerId, input.currency);
      await repo.setCash(client, input.ownerId, input.currency, (BigInt(cur || "0") + BigInt(input.grantCash)).toString());
    }
    if (hasCapital) await repo.claimTerritory(client, input.capitalQ!, input.capitalR!, input.id);
    const seededCompanies = await bootstrapMarket(client, input.id, input.currency);
    return { nationId: input.id, name: input.name, currency: input.currency, seededCompanies, capital: hasCapital ? { q: input.capitalQ, r: input.capitalR } : null };
  });
}

/** 영토 확장: 자기 국가에 인접한 빈 타일을 점유한다. */
export async function claimTile(input: { q: number; r: number; nationId: string; ownerId: string }) {
  return withTransaction(async (client) => {
    if (!Number.isInteger(input.q) || !Number.isInteger(input.r)) throw new HttpError(400, "invalid tile");
    const nation = await repo.getNation(client, input.nationId);
    if (!nation) throw new HttpError(404, "nation not found");
    if (nation.owner_user_id !== input.ownerId) throw new HttpError(403, "not the nation's ruler");
    const tile = await repo.getTerritory(client, input.q, input.r);
    if (tile && tile.nationId) throw new HttpError(409, "tile already occupied");
    if (!(await repo.nationOwnsAdjacent(client, input.q, input.r, input.nationId))) {
      throw new HttpError(400, "tile is not adjacent to your territory");
    }
    await repo.claimTerritory(client, input.q, input.r, input.nationId);
    return { q: input.q, r: input.r, nationId: input.nationId };
  });
}

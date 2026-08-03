/**
 * 국가 레이어 + 세계 지도(영토). 유저가 빈 육각 타일에 건국하고, 인접 타일로
 * 영토를 확장한다. 국가 설립 = 국가 + 수도 타일 + 건국자 계정·초기 국고.
 */
import { withTransaction } from "./db";
import { HttpError } from "./errors";
import * as repo from "./repo";

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
    return { nationId: input.id, name: input.name, currency: input.currency, capital: hasCapital ? { q: input.capitalQ, r: input.capitalR } : null };
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

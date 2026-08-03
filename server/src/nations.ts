/**
 * 국가 레이어 — 게임의 홈. 유저가 국가를 세우고, 그 안에서 경제(증시)를 굴린다.
 * 국가 설립 = 국가 엔티티 생성 + 건국자 계정·초기 국고(현금) 지급으로 바로 시작 가능.
 */
import { withTransaction } from "./db";
import { HttpError } from "./errors";
import * as repo from "./repo";

export async function foundNation(input: { id: string; name: string; currency: string; ownerId: string; grantCash?: string }) {
  return withTransaction(async (client) => {
    if (!input.name.trim()) throw new HttpError(400, "nation name required");
    const existing = await repo.getNation(client, input.id);
    if (existing) throw new HttpError(409, "nation id already exists");
    await repo.upsertUser(client, input.ownerId, null);
    await repo.insertNation(client, input);
    if (input.grantCash) {
      const cur = await repo.getCash(client, input.ownerId, input.currency);
      await repo.setCash(client, input.ownerId, input.currency, (BigInt(cur || "0") + BigInt(input.grantCash)).toString());
    }
    return { nationId: input.id, name: input.name, currency: input.currency };
  });
}

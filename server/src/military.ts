/**
 * 전쟁 페이즈 — 군대 모집(경제→군사) + 인접 적 타일 공격/점령. 지도와 직결.
 *
 * 규칙(간단·명확):
 *  - 모집: 병력 1당 현금 COST_PER_UNIT(=$100). 통치자 현금에서 지불, 국가 병력 증가.
 *  - 공격: 인접 적 타일에 병력 C를 투입(영구 소모). 방어력 = 수비 보너스 + 적 총병력.
 *    C > 방어력이면 타일 점령 + 적 병력 큰 손실, 아니면 격퇴 + 적 소량 손실.
 *  전쟁은 병력을 태우므로 남발 불가 — 경제로 군대를 키운 만큼만 정복할 수 있다.
 */
import { withTransaction } from "./db";
import { HttpError } from "./errors";
import * as repo from "./repo";
import { exactCompare, exactSubtract } from "../../src/lib/number/exactAmount";

const COST_PER_UNIT = 10_000n; // 병력 1당 $100 (정수 최소단위)
const TILE_GARRISON = 10n; // 타일 기본 수비 보너스(홈 어드밴티지)

export async function recruit(input: { nationId: string; ownerId: string; units: number }) {
  return withTransaction(async (client) => {
    const nation = await repo.getNation(client, input.nationId);
    if (!nation) throw new HttpError(404, "nation not found");
    if (nation.owner_user_id !== input.ownerId) throw new HttpError(403, "not the nation's ruler");
    if (!Number.isInteger(input.units) || input.units <= 0) throw new HttpError(400, "units must be a positive integer");

    const cost = BigInt(input.units) * COST_PER_UNIT;
    const currency = nation.currency as string;
    const cash = await repo.getCash(client, input.ownerId, currency);
    if (exactCompare(cash, cost.toString()) < 0) throw new HttpError(402, "insufficient treasury to recruit");

    await repo.setCash(client, input.ownerId, currency, exactSubtract(cash, cost.toString()));
    const army = await repo.getArmy(client, input.nationId);
    const next = army + BigInt(input.units);
    await repo.setArmy(client, input.nationId, next);
    return { nationId: input.nationId, army: next.toString(), spent: cost.toString() };
  });
}

export async function attack(input: { nationId: string; ownerId: string; q: number; r: number; commit: number }) {
  return withTransaction(async (client) => {
    const attacker = await repo.getNation(client, input.nationId);
    if (!attacker) throw new HttpError(404, "nation not found");
    if (attacker.owner_user_id !== input.ownerId) throw new HttpError(403, "not the nation's ruler");
    if (!Number.isInteger(input.commit) || input.commit <= 0) throw new HttpError(400, "commit must be a positive integer");

    const tile = await repo.getTerritory(client, input.q, input.r);
    if (!tile || !tile.nationId) throw new HttpError(400, "tile is empty (nothing to attack)");
    if (tile.nationId === input.nationId) throw new HttpError(400, "cannot attack your own tile");
    if (!(await repo.nationOwnsAdjacent(client, input.q, input.r, input.nationId))) {
      throw new HttpError(400, "tile is not adjacent to your territory");
    }

    const commit = BigInt(input.commit);
    const attArmy = await repo.getArmy(client, input.nationId);
    if (attArmy < commit) throw new HttpError(400, "not enough army for this assault");
    const defNationId = tile.nationId;
    const defArmy = await repo.getArmy(client, defNationId);
    const defense = TILE_GARRISON + defArmy;

    // 투입 병력은 전투로 영구 소모.
    await repo.setArmy(client, input.nationId, attArmy - commit);

    let result: "captured" | "repelled";
    let defNext: bigint;
    if (commit > defense) {
      result = "captured";
      defNext = defArmy - commit; if (defNext < 0n) defNext = 0n;
      await repo.claimTerritory(client, input.q, input.r, input.nationId);
    } else {
      result = "repelled";
      defNext = defArmy - commit / 2n; if (defNext < 0n) defNext = 0n;
    }
    await repo.setArmy(client, defNationId, defNext);

    return {
      result, tile: { q: input.q, r: input.r },
      defense: defense.toString(),
      attackerArmy: (attArmy - commit).toString(),
      defenderArmy: defNext.toString(),
      defenderNationId: defNationId,
    };
  });
}

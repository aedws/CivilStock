import pg from "pg";
import { config } from "./config";

// numeric를 JS 문자열로 받는다(정밀도 보존, exactAmount 규율과 일치).
// pg 타입 OID 1700 = numeric. 파서를 항등으로 두면 문자열 그대로 반환.
pg.types.setTypeParser(1700, (value) => value);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

export type Client = pg.PoolClient;

/** BEGIN/COMMIT/ROLLBACK로 감싼 트랜잭션. 서버 권위 상태 변경은 전부 이 안에서. */
export async function withTransaction<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

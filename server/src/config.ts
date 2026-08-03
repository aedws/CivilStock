/** 환경변수 설정. Cloud Run은 PORT를 주입하고, 비밀값은 Secret Manager로 주입. */
export const config = {
  port: Number(process.env.PORT ?? 8080),
  /** Postgres 연결 문자열. Neon(권장)·Cloud SQL·로컬 무엇이든 동일 드라이버. */
  databaseUrl: process.env.DATABASE_URL ?? "",
  /** 커넥션 풀 최대치. Neon은 pooled 엔드포인트(PgBouncer)를 쓰고 인스턴스당 작게. */
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 5),
  /** TLS 인증서 검증을 끌지 여부(기본 검증 on — Neon은 공인 인증서라 그대로 둠). */
  dbSslNoVerify: process.env.PGSSL_NO_VERIFY === "1",
  /** /tick 호출 인증용 공유 비밀(Cloud Scheduler 헤더와 대조). */
  tickSecret: process.env.TICK_SECRET ?? "",
  /** 1년 = 몇 틱인가(쿠폰 연율 환산). 현실 1시간=게임 1일 가정 시 24*365. */
  ticksPerYear: Number(process.env.TICKS_PER_YEAR ?? 8760),
};

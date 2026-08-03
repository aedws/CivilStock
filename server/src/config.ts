/** 환경변수 설정. Cloud Run은 PORT를 주입하고, 나머지는 Secret Manager로 주입. */
export const config = {
  port: Number(process.env.PORT ?? 8080),
  /** Cloud SQL 연결 문자열. Cloud Run에서는 소켓 경로 또는 프라이빗 IP. */
  databaseUrl: process.env.DATABASE_URL ?? "",
  /** /tick 호출 인증용 공유 비밀(Cloud Scheduler 헤더와 대조). */
  tickSecret: process.env.TICK_SECRET ?? "",
  /** 1년 = 몇 틱인가(쿠폰 연율 환산). 현실 1시간=게임 1일 가정 시 24*365. */
  ticksPerYear: Number(process.env.TICKS_PER_YEAR ?? 8760),
};

# CivilStock 서버 아키텍처

> 순수 코어(`src/lib`)가 비즈니스 규칙을, 서버(`server/`)가 트랜잭션·영속화 경계를
> 담당한다. 배포 절차는 [`server/DEPLOY.md`](../server/DEPLOY.md).

## 구성

```
[웹앱]  ──HTTPS──▶  Cloud Run: 권위 API 서버 (server/src)
                      │  트랜잭션마다: 상태 로드 → 순수 코어 호출 → 영속화
                      ▼
                   Cloud SQL (Postgres, server/schema.sql)  ← 단일 진실원본
[Cloud Scheduler] ──POST /tick (TICK_SECRET)──▶ 서버 runTick (멱등)
```

## 핵심 설계

- **순수 코어 재사용**: 서버는 `routeBuy/routeSell`(라우터), `processBonds`(worldTick),
  원장 규칙을 그대로 호출한다. 규칙은 한 곳(`src/lib`)에만 있고 클라이언트·서버·
  테스트가 공유한다.
- **트랜잭션 경계**: 모든 권위 액션은 `withTransaction`으로 감싸 FOR UPDATE로 행을
  잠그고, 순수 코어로 결과를 계산한 뒤 원자적으로 커밋한다. 부분 실패 없음.
- **큰 수 규율 유지**: Postgres `numeric`을 문자열로 왕복(`pg.types.setTypeParser`)해
  exactAmount 정수 문자열 규율을 DB 경계에서도 깨지 않는다.
- **멱등 틱**: `tick_log`에 처리한 틱을 기록하고 `on conflict do nothing`으로 중복
  처리(이중 쿠폰 지급 등)를 막는다.

## 엔드포인트 (스켈레톤)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/healthz` | 헬스체크 |
| POST | `/orders` | 주문 접수 → CLOB+AMM 최선체결·정산·호가장/풀 갱신 |
| POST | `/tick` | worldTick(Scheduler 전용, `x-tick-secret` 인증) |

`/orders`가 "상태 로드 → 순수 코어 → 영속화"의 대표 구현이다. 발행(회사·ETF·채권),
ETF 생성/상환, AMM 유동성 예치 등 나머지 액션도 같은 레시피로 추가한다.

## 알려진 TODO (스켈레톤 → 실서비스)

- **에스크로**: 지정가 접수 시점에 현금(매수)/주식(매도)을 잠가야 이중지출을 막는다.
  현재는 즉시 체결분만 정산하고 잔량 호가는 미에스크로.
- **증거금·청산**: 공매도·선물은 담보 계정 + 마크투마켓 + 강제청산 필요(다음 슬라이스).
- **tick 계산**: 현재 body의 tick을 신뢰. 서버가 "기원점 기준 경과 시간"으로 산출하도록 확장.
- **인증/레이트리밋**: `/orders`에 유저 인증(Identity Platform)·rate limit 추가.
- **실시간 구독**: 클라이언트로의 호가·체결 팬아웃(SSE/WebSocket + Redis).

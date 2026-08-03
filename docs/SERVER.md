# CivilStock 서버 아키텍처

> 순수 코어(`src/lib`)가 비즈니스 규칙을, 서버(`server/`)가 트랜잭션·영속화 경계를
> 담당한다. 배포 절차는 [`server/DEPLOY.md`](../server/DEPLOY.md).

## 구성

```
[웹앱]  ──HTTPS──▶  Cloud Run: 권위 API 서버 (server/src)
                      │  트랜잭션마다: 상태 로드 → 순수 코어 호출 → 영속화
                      ▼
                   Neon (서버리스 Postgres, server/schema.sql)  ← 단일 진실원본
[Cloud Scheduler] ──POST /tick (TICK_SECRET)──▶ 서버 runTick (멱등)
```

DB는 Neon(무료·서버리스), 컴퓨팅은 Cloud Run. 표준 Postgres라 Cloud SQL로의
이전은 dump/restore로 언제든 가능(락인 없음). 연동은 [`../server/NEON.md`](../server/NEON.md).

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

## 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/` | 웹 콘솔 UI(`public/index.html`) — 브라우저로 직접 조작 |
| GET | `/healthz` | 헬스체크 |
| GET | `/world` | 세계 시계(epoch·tickSeconds·currentTick·lastProcessedTick) |
| GET | `/securities` | 상장 종목 목록 |
| GET | `/account?userId=` | 계정 현금·포지션 |
| GET | `/market?securityId=` | AMM 풀·현물가·상위 호가·최근 체결 |
| POST | `/accounts` | 계정 생성(+테스트 현금 지급) |
| POST | `/issue/equity` `\|` `/issue/bond` `\|` `/issue/etf` | **발행(B)** — 유저 발행권 |
| POST | `/pools/liquidity` | AMM 유동성 예치(시장 조성) |
| POST | `/orders` | 주문 접수 → CLOB+AMM 최선체결·정산·**에스크로(A)** |
| POST | `/orders/cancel` | 레스팅 주문 취소 → 에스크로 환불 |
| POST | `/tick` | **자동 틱(C)** — 경과 시간으로 밀린 틱 따라잡기(`x-tick-secret`) |

`/orders`가 "상태 로드 → 순수 코어 → 영속화"의 대표 구현이다.

## 구현 완료

- **에스크로(A)**: 지정가 잔량을 접수 시 잠금(매수=현금, 매도=주식). "레스팅 주문 =
  에스크로 기록"이라 별도 테이블 불필요. 메이커 체결 시 재정산 안 함(이중지출 방지),
  취소 시 환불. *로컬 Postgres 시나리오로 부분체결·환불·무이중차감 검증.*
- **발행(B)**: 유저가 계정·주식·채권·ETF를 직접 발행. 운영자 승인 게이트 없음.
- **자동 틱(C)**: `world` 테이블의 epoch 기준으로 서버가 현재 tick을 산출하고 밀린
  틱을 따라잡는다. Scheduler는 body 없이 `/tick`만 두드리면 됨. tick_log로 멱등.

## 남은 TODO (실서비스)

- **증거금·청산**: 공매도·선물은 담보 계정 + 마크투마켓 + 강제청산 필요(다음 슬라이스).
- **인증/레이트리밋**: 유저 인증(Identity Platform)·rate limit. 현재 UI는 데모용.
- **실시간 구독**: 클라이언트로의 호가·체결 팬아웃(SSE/WebSocket + Redis).

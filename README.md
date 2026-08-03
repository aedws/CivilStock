# CivilStock

유저가 직접 **국가를 세우고**, **경제·전쟁·외교**를 자유롭게 벌이는 오픈 웹앱 게임.
2DStock의 아쉬웠던 점(유저 간 실질 상호작용 부재, 클라이언트 권위, 리셋 세계)을
개선한 **서버 권위형 지속 세계** 게임을 지향한다.

- 환경: **Google Cloud Run** (권위 서버 · Cloud Scheduler 틱) + **Neon** (서버리스 Postgres)
- 세계 모델: **6개월 시즌 소프트 리셋** / 국가는 **1인국 + 멀티** 병행
- 설계: [`docs/DESIGN.md`](docs/DESIGN.md) · 경제: [`docs/ECONOMY.md`](docs/ECONOMY.md) · 서버: [`docs/SERVER.md`](docs/SERVER.md)

## 오너가 할 일 (로컬에서 서버 돌려보기 — 전부 $0)

코드·스키마는 준비됐다. 아래 1~4는 **오너만 할 수 있는** 작업이다.

1. **Neon 프로젝트 생성** — [neon.tech](https://neon.tech) 가입 → New Project
   (리전은 도쿄 `ap-northeast-1` 권장). 자세히: [`server/NEON.md`](server/NEON.md).
2. **스키마 + 시드 적용** — Neon **SQL Editor**에 아래 두 파일 내용을 순서대로 붙여 실행:
   - `server/schema.sql` (테이블 생성)
   - `server/seed.sql` (스모크 테스트용 데모 데이터)
3. **연결 문자열 복사** — 대시보드 **Connection Details → Pooled connection**
   (`...-pooler...?sslmode=require`).
4. **로컬 실행 + 스모크 테스트**:
   ```bash
   cd server && npm install
   DATABASE_URL='<붙여넣기: pooled 연결 문자열>' TICK_SECRET='dev-secret' npm start
   ```
   다른 터미널에서:
   ```bash
   curl -s localhost:8080/healthz
   # AMM에서 ACME 5주 매수 (bob) → executions에 amm 체결이 찍혀야 한다
   curl -s -X POST localhost:8080/orders -H 'content-type: application/json' \
     -d '{"orderId":"o1","securityId":"sec_acme","side":"buy","ownerId":"u_bob","quantity":"5"}'
   # worldTick 1회
   curl -s -X POST localhost:8080/tick -H 'x-tick-secret: dev-secret' \
     -H 'content-type: application/json' -d '{"tick":1}'
   ```

> **보안**: 위 `DATABASE_URL`은 비밀번호가 든 **라이브 자격증명**이다. 채팅에
> 붙여넣지 말고 로컬 셸/`.env`에만 두자. 공유가 필요하면 Neon **dev 브랜치**를 따서
> 그 자격증명만 쓰고 나중에 폐기하는 걸 권장.

GCP(Cloud Run) 배포는 로컬 확인 후 [`server/DEPLOY.md`](server/DEPLOY.md)로 진행한다.

## 개발 (순수 코어)

```bash
npm install
npm test        # exact-amount·economy·amm·router·issuance·world-tick 전 스위트
npm run typecheck
```

## 큰 수 처리 (이식 완료)

국가 재정·GDP·통화 발행량은 2^53를 쉽게 넘기고 JSON/일부 저장 경로는 BigInt를
직렬화하지 못한다. 그래서 **정수 문자열로 저장하고 연산 순간에만 BigInt로 변환**하는
2DStock 검증 모듈을 이식했다. 클라이언트(표시)와 Cloud Run 권위 서버(연산)가 동일
모듈을 공유한다.

- 모듈: `src/lib/number/exactAmount.ts`
- 테스트: `npm run test:exact-amount`
- 타입체크: `npm run typecheck`

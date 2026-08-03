# Neon Postgres 연동

DB는 **Neon**(서버리스 Postgres)을 쓴다. 컴퓨팅은 Cloud Run(GCP), DB만 Neon.
표준 Postgres라 `server/schema.sql`·서버 코드는 **그대로** 쓰고, 바꾸는 건
`DATABASE_URL` 하나뿐이다. Cloud SQL로 옮기고 싶어지면 dump/restore 한 번이면 된다.

## 1. Neon 프로젝트 생성 (오너)

- [ ] https://neon.tech 가입(무료 티어) → **New Project**.
- [ ] 리전은 사용자와 가까운 곳(예: AWS `ap-northeast-1` 도쿄 — 서울에서 가장 가까움).
- [ ] 데이터베이스 이름: `civilstock`(기본 `neondb`도 무방).

## 2. 연결 문자열 확보

Neon 대시보드 **Connection Details**에서 두 종류가 나온다:

- **Pooled connection**(호스트에 `-pooler` 포함) — **Cloud Run은 이걸 쓴다.**
  인스턴스가 여러 개 떠도 PgBouncer가 커넥션을 다중화해준다.
- Direct connection — 마이그레이션/psql 같은 단발 작업용.

형식 예:
```
postgres://USER:PASSWORD@ep-xxxx-pooler.ap-northeast-1.aws.neon.tech/civilstock?sslmode=require
```

> 서버는 `sslmode=require`를 자동 감지해 TLS를 켠다(`db.ts`의 `resolveSsl`).
> Neon은 공인 인증서라 인증서 검증을 그대로 둔다.

## 3. 스키마 적용

Neon **SQL Editor**에 `server/schema.sql` 내용을 붙여 실행하거나, 로컬에서:
```bash
psql "postgres://USER:PASSWORD@ep-xxxx.ap-northeast-1.aws.neon.tech/civilstock?sslmode=require" \
  -f server/schema.sql
```
(마이그레이션은 pooled가 아닌 **direct** 연결 권장.)

## 4. 서버에 주입

**로컬 개발:**
```bash
cd server
DATABASE_URL='postgres://...-pooler.../civilstock?sslmode=require' \
TICK_SECRET='dev-secret' \
npm start
# 다른 터미널: curl localhost:8080/healthz  → {"ok":true}
```

**Cloud Run 배포:** `DATABASE_URL`을 Secret Manager에 넣고 주입(자세한 건 DEPLOY.md).
```bash
printf 'postgres://...-pooler.../civilstock?sslmode=require' \
  | gcloud secrets create DATABASE_URL --data-file=-
```
→ Cloud SQL 관련 플래그(`--add-cloudsql-instances`)는 **불필요**. Neon은 일반
인터넷 TCP로 붙는다.

## 5. Neon 브랜칭 활용 (이번 프로젝트의 "새로운 것")

Neon은 DB를 **git처럼 브랜치**할 수 있다(copy-on-write, 즉시 생성).

- **개발/프리뷰 브랜치**: `main` 데이터에서 브랜치를 떠서 파괴적 테스트 → 버리면 끝.
- **시즌 리셋(§DESIGN 6개월 시즌)**: 새 시즌 시작 시 새 브랜치로 깨끗한 판을 열고,
  지난 시즌은 브랜치로 아카이브해 레거시/명예 정산 후 삭제하는 운영이 가능.
- CLI: `neonctl branches create --name dev` 등.

## 무료 티어 메모

- 스토리지 0.5GB / 자동 스케일다운(유휴 시 컴퓨트 0). 200명 규모 데이터는 한동안
  수십 MB라 여유. 체결(`trades`)만 커지면 주기적 아카이브/파티셔닝으로 관리.
- 유휴 후 첫 쿼리에 콜드스타트(수백 ms) 가능 — 틱 기반 게임엔 무해.

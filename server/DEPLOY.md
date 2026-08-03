# CivilStock 서버 배포 — 오너 체크리스트

서버 골격(스키마·API·틱)은 코드로 준비돼 있다. 아래는 **오너(계정 소유자)만 할 수
있는** GCP 작업이다. `PROJECT_ID`, `REGION`(예: `asia-northeast3`=서울) 등을 자신의
값으로 바꿔 실행한다.

## 0. 선행

- [ ] GCP 프로젝트 생성 + **결제 계정 연결**(Cloud SQL·Cloud Run은 결제 필요).
- [ ] `gcloud` CLI 설치 후 `gcloud auth login`, `gcloud config set project PROJECT_ID`.
- [ ] API 활성화:
  ```bash
  gcloud services enable run.googleapis.com sqladmin.googleapis.com \
    cloudscheduler.googleapis.com secretmanager.googleapis.com \
    artifactregistry.googleapis.com cloudbuild.googleapis.com
  ```

## 1. Cloud SQL (Postgres) 생성 + 스키마 적용

- [ ] 인스턴스 생성:
  ```bash
  gcloud sql instances create civilstock-db \
    --database-version=POSTGRES_16 --tier=db-g1-small --region=REGION
  gcloud sql databases create civilstock --instance=civilstock-db
  gcloud sql users set-password postgres --instance=civilstock-db --password='STRONG_PW'
  ```
- [ ] 스키마 적용(로컬에서 `psql` 또는 Cloud SQL Studio):
  ```bash
  psql "host=... dbname=civilstock user=postgres" -f server/schema.sql
  ```

## 2. 비밀값 등록 (Secret Manager)

- [ ] `DATABASE_URL`, `TICK_SECRET` 등록:
  ```bash
  # 예: Cloud SQL 커넥터 소켓 경로 사용
  printf 'postgres://postgres:STRONG_PW@/civilstock?host=/cloudsql/PROJECT_ID:REGION:civilstock-db' \
    | gcloud secrets create DATABASE_URL --data-file=-
  openssl rand -hex 32 | gcloud secrets create TICK_SECRET --data-file=-
  ```

## 3. 컨테이너 빌드 + Cloud Run 배포

- [ ] 빌드(빌드 컨텍스트 = 리포 루트, Dockerfile은 server/):
  ```bash
  gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT_ID/civilstock/server \
    --file server/Dockerfile .
  ```
- [ ] 배포(Cloud SQL 연결 + 비밀 주입):
  ```bash
  gcloud run deploy civilstock-server \
    --image REGION-docker.pkg.dev/PROJECT_ID/civilstock/server \
    --region REGION --allow-unauthenticated \
    --add-cloudsql-instances PROJECT_ID:REGION:civilstock-db \
    --set-secrets DATABASE_URL=DATABASE_URL:latest,TICK_SECRET=TICK_SECRET:latest \
    --set-env-vars TICKS_PER_YEAR=8760
  ```
- [ ] 헬스체크: `curl https://<run-url>/healthz` → `{"ok":true}`.

## 4. worldTick 스케줄러 (Cloud Scheduler)

- [ ] 정기 틱 호출(예: 1시간마다 tick 증가). tick 번호는 서버가 시간 기반으로
  계산하도록 바꾸는 게 이상적이지만, 스켈레톤은 body의 tick을 그대로 처리한다:
  ```bash
  gcloud scheduler jobs create http civilstock-tick \
    --schedule="0 * * * *" --uri="https://<run-url>/tick" --http-method=POST \
    --headers="x-tick-secret=$(gcloud secrets versions access latest --secret=TICK_SECRET),content-type=application/json" \
    --message-body='{"tick":1}' --location REGION
  ```
  > 멱등: 같은 tick 재호출은 `already_processed`로 무시된다. 실제 운영에선
  > tick을 "서버 시작 기준 경과 시간"으로 계산하도록 `runTick` 진입부를 확장할 것.

## 5. 확인

- [ ] 유저·증권을 심고(seed) `POST /orders`로 매매가 도는지 확인.
- [ ] Cloud Run 로그(`gcloud run services logs read civilstock-server`)에서 오류 확인.

---

## 지금 당장 오너가 결정/제공해야 하는 것 (요약)

1. **GCP 프로젝트 + 결제** — 이게 없으면 아무것도 못 띄운다.
2. **REGION** 선택(서울 `asia-northeast3` 권장).
3. **DB 비밀번호·TICK_SECRET** 등 비밀값.
4. (선택) 커스텀 도메인.

코드·스키마·배포 명령은 준비돼 있으니, 위 1~4만 정해주면 배포까지 함께 진행할 수 있다.

# CivilStock 서버 배포 — 오너 체크리스트

서버 골격(스키마·API·틱)은 코드로 준비돼 있다. **DB는 Neon**(무료·서버리스
Postgres)을 쓰고, 컴퓨팅만 Cloud Run(GCP)에 올린다. Neon을 싱가포르에 뒀으므로
`REGION`도 **`asia-southeast1`(싱가포르)** 권장 — DB와 co-locate해 쿼리 왕복을
same-region으로. `PROJECT_ID` 등은 자신의 값으로 바꿔 실행한다.

## 0. 선행

- [ ] GCP 프로젝트 생성 + 결제 계정 연결(Cloud Run은 무료 티어 내 $0이지만 결제
  계정 등록은 필요).
- [ ] `gcloud` CLI 설치 후 `gcloud auth login`, `gcloud config set project PROJECT_ID`.
- [ ] API 활성화(Cloud SQL API 불필요):
  ```bash
  gcloud services enable run.googleapis.com \
    cloudscheduler.googleapis.com secretmanager.googleapis.com \
    artifactregistry.googleapis.com cloudbuild.googleapis.com
  ```

## 1. DB: Neon (Postgres)

- [ ] **Neon 프로젝트 생성 + 스키마 적용 + `DATABASE_URL` 확보** → [`NEON.md`](./NEON.md).
  Cloud SQL 인스턴스는 만들지 않는다(상시 과금 없음).

## 2. 비밀값 등록 (Secret Manager)

- [ ] `DATABASE_URL`(Neon **pooled** 연결 문자열), `TICK_SECRET` 등록:
  ```bash
  printf 'postgres://USER:PW@ep-xxxx-pooler.ap-southeast-1.aws.neon.tech/civilstock?sslmode=require' \
    | gcloud secrets create DATABASE_URL --data-file=-
  openssl rand -hex 32 | gcloud secrets create TICK_SECRET --data-file=-
  ```

## 3. 빌드 + 배포 (한 줄 — cloudbuild.yaml이 빌드→푸시→배포까지)

```bash
gcloud builds submit --config cloudbuild.yaml .
```
- [ ] 헬스체크: `curl https://<run-url>/healthz` → `{"ok":true}`.

## 3-b. 자동 배포 (권장 — 한 번만 설정하면 이후 손 안 댐)

푸시될 때마다 자동으로 빌드+배포되게 한다.

- [ ] **IAM(1회)** — 빌드 SA가 Cloud Run에 배포하도록 권한 부여:
  ```bash
  PN=$(gcloud projects describe civilstock --format='value(projectNumber)')
  gcloud projects add-iam-policy-binding civilstock \
    --member="serviceAccount:${PN}-compute@developer.gserviceaccount.com" --role=roles/run.admin
  gcloud projects add-iam-policy-binding civilstock \
    --member="serviceAccount:${PN}-compute@developer.gserviceaccount.com" --role=roles/iam.serviceAccountUser
  ```
- [ ] **트리거(1회)** — Cloud Run 콘솔 → 서비스 `civilstock-server` → **연속 배포 설정**
  → GitHub 연결 → 리포 `aedws/CivilStock` + 브랜치 → 빌드 형식 **Cloud Build 구성 파일**
  → 경로 `/cloudbuild.yaml` → 저장. 이후 해당 브랜치 푸시마다 자동 배포(진행: Cloud Build → 기록).

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

## 지금 당장 오너가 제공해야 하는 것 (요약)

1. **Neon 프로젝트 생성 → pooled `DATABASE_URL`** ([`NEON.md`](./NEON.md)). — $0.
2. **GCP 프로젝트 + 결제 계정 등록**(Cloud Run 무료 티어 내 $0, 등록만 필요).
3. **REGION** 선택(Neon과 co-locate하도록 싱가포르 `asia-southeast1` 권장).
4. **TICK_SECRET**(`openssl rand -hex 32`).

Cloud SQL을 안 쓰므로 상시 과금이 없다. 위 1~4만 주면 배포까지 함께 진행할 수 있다.

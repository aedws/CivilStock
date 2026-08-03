# CivilStock

유저가 직접 **국가를 세우고**, **경제·전쟁·외교**를 자유롭게 벌이는 오픈 웹앱 게임.
2DStock의 아쉬웠던 점(유저 간 실질 상호작용 부재, 클라이언트 권위, 리셋 세계)을
개선한 **서버 권위형 지속 세계** 게임을 지향한다.

- 환경: **Google Cloud Run** (권위 서버 · Cloud Scheduler 틱) + **Neon** (서버리스 Postgres)
- 세계 모델: **6개월 시즌 소프트 리셋** / 국가는 **1인국 + 멀티** 병행
- 설계 제안: [`docs/DESIGN.md`](docs/DESIGN.md)

## 큰 수 처리 (이식 완료)

국가 재정·GDP·통화 발행량은 2^53를 쉽게 넘기고 JSON/일부 저장 경로는 BigInt를
직렬화하지 못한다. 그래서 **정수 문자열로 저장하고 연산 순간에만 BigInt로 변환**하는
2DStock 검증 모듈을 이식했다. 클라이언트(표시)와 Cloud Run 권위 서버(연산)가 동일
모듈을 공유한다.

- 모듈: `src/lib/number/exactAmount.ts`
- 테스트: `npm run test:exact-amount`
- 타입체크: `npm run typecheck`

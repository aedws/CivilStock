# 루트 Dockerfile — Cloud Run "저장소에 연결"(연속 배포) wizard의 Dockerfile 모드용.
# 빌드 컨텍스트 = 리포 루트. server/Dockerfile과 내용 동일(순수 코어 src + server 동봉).
FROM node:22-slim

WORKDIR /app

# 서버 의존성 설치.
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev

# 소스: 서버 + 순수 코어.
COPY server ./server
COPY src ./src

WORKDIR /app/server
ENV NODE_ENV=production
# Cloud Run은 $PORT를 주입한다(기본 8080).
CMD ["npm", "start"]

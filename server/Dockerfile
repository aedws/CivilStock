# CivilStock 권위 서버 — Cloud Run 컨테이너.
# 순수 코어(../src/lib)를 함께 담기 위해 빌드 컨텍스트는 리포 루트를 쓴다:
#   docker build -f server/Dockerfile -t civilstock-server .
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

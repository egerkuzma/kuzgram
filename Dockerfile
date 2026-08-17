# Сборка зависимостей отдельным слоем: better-sqlite3 — нативный модуль,
# и если готовой сборки под платформу нет, ему нужны компилятор и python.
# В финальный образ этот инструментарий не переезжает.
FROM node:22-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- рабочий образ ---
FROM node:22-bookworm-slim

ENV NODE_ENV=production
# База живёт на томе, а не внутри образа: пересборка не должна стирать переписку
ENV KUZGRAM_DB=/data/kuzgram.db

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js db.js auth.js push.js ./
COPY bin ./bin
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data /app

USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/vapid-public-key').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]

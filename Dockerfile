# 评论服务（Node + SQLite）。源码是 TypeScript，靠 Node 的类型剥离直接运行，所以要 Node ≥ 22.18。
FROM node:24-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune
COPY src ./src
COPY bin ./bin
COPY schema.sql ./schema.sql
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production NODE_NO_WARNINGS=1 PORT=8787 DB_PATH=/data/comments.db
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- "http://127.0.0.1:$PORT/health" >/dev/null || exit 1
CMD ["node", "bin/mori-comments.mjs"]

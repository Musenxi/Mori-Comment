# MORI Comment

[MORI](https://github.com/Musenxi/Astro-Theme-Mori) 博客的自建评论服务：文末评论、划词引用评论、阅读量、在线访客。Hono 写一份，同时跑在 Node（SQLite）和 Cloudflare Workers（D1）上。

站点这边在 `mori.config.ts` 里写 `comments: { provider: 'mori', endpoint: '评论服务的地址' }`，管理在 [Studio](https://github.com/Musenxi/Mori-Studio) 的“评论”页；防垃圾规则（屏蔽词、IP 段、网址、昵称）在 Studio 的“设定 → 评论”里填，存在评论服务的数据库里。

## Node + SQLite

要 Node ≥ 22.18（TypeScript 靠 Node 的类型剥离直接运行）。

```bash
pnpm install
ADMIN_TOKEN=… SALT=… ALLOW_ORIGIN=https://你的站点 node bin/mori-comments.mjs
```

```
PORT=8787                 端口
DB_PATH=./comments.db     数据库文件
ADMIN_TOKEN=…             管理令牌（Studio 里填它）；不设，审核、隐藏、删除的接口就是关的
SALT=…                    随机字符串，给读者标识做哈希（阅读量去重用）
ALLOW_ORIGIN=…            站点地址（跨域时）
TURNSTILE_SECRET=…        可选：人机验证
AUTO_APPROVE=returning    returning（通过过的人直接发）/ all / none
```

Docker：`docker build -t mori-comments .`；和站点、Caddy 一起部署见主题的 [deploy/](https://github.com/Musenxi/Astro-Theme-Mori/tree/main/deploy)。

## Cloudflare Workers + D1

见 `wrangler.example.toml` 顶部的四步。

## 升级

Node + SQLite 版启动时自动给旧库补上头像、网址、邮箱、IP、博主标记这几列和阅读量的表。D1 上已经建好的库要手动执行：`wrangler d1 execute <库名> --file=migrations-001-profile.sql`（加头像、网址两列，只执行一次）、`--file=migrations-002-ip.sql`（加邮箱、IP 两列）、`--file=migrations-003-author.sql`（加博主标记），各执行一次，再执行一次 `--file=schema.sql`（建阅读量、设置的表，可以重复执行）。新建的库只用 `schema.sql`。

## 开发

```bash
pnpm dev     # 管理令牌 dev-token，数据库在 .data/
pnpm test
pnpm check
```

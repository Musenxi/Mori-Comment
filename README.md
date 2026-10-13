# Mori Comment

[Mori](https://github.com/Musenxi/Astro-Theme-Mori) 博客的自建评论服务：文末评论、划词引用评论、阅读量、在线访客。Hono 写一份，同时跑在 Node（SQLite）和 Cloudflare Workers（D1）上。

站点这边在 `mori.config.ts` 里写 `comments: { provider: 'mori', endpoint: '评论服务的地址' }`，管理在 [Studio](https://github.com/Musenxi/Mori-Studio) 的“评论”页；防垃圾规则（屏蔽词、IP 段、网址、昵称）在 Studio 的“设定 → 评论”里填，存在评论服务的数据库里；命中的评论进垃圾箱。

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

## 邮件提醒

在 Studio 的“设定 → 评论 → 邮件提醒”里填，存在评论服务的数据库里。有新评论时提醒博主（垃圾箱里的不提醒），有人回复时提醒被回复的读者。发信方式三选一：

- SMTP：QQ 邮箱、163、Gmail 等的 SMTP 服务器和授权码。465 端口直接 TLS，其他端口用 STARTTLS。只有 Node 版能用。
- Resend：API Key，发信域名要先在 Resend 验证。
- Cloudflare Email Service：Workers 版绑上 `send_email`（见 `wrangler.example.toml`）就不用填别的；Node 版填账号 ID 和 API 令牌，走它的 REST 接口。发信域名要先接入 Email Service。

## 管理接口

Studio（以及以后桌面版里的 MCP 工具）通过这组接口管理评论。都在 `/admin/` 下，请求头带 `Authorization: Bearer <ADMIN_TOKEN>`；令牌不对是 401，服务没设令牌是 503。出错时返回 `{ "error": "原因" }`。

| 接口 | 说明 |
| --- | --- |
| `GET /admin/info` | `{ service, version, api, runtime, features, autoApprove }`。`api` 是接口版本（现在是 1），删字段、改含义时才加一；新加的能力看 `features`：`mail`（能用的发信方式）、`online`、`turnstile`、`cursor`、`since`。也用来测试令牌 |
| `GET /admin/comments` | 列表，新的在前。参数：`status`（pending / approved / hidden / spam，不给是垃圾箱以外的全部）、`entry`（`posts/xxx`）、`since`（毫秒时间戳，只要之后的）、`before`（翻页游标）、`limit`（1–500，默认 100）。返回 `{ comments, next }`，`next` 不是 null 就把它当 `before` 取下一页 |
| `POST /admin/comments` | 以博主身份发评论：`{ entry, body, name, email?, url?, parentId?, title? }`。回复待审的评论时，那条一起通过 |
| `PATCH /admin/comments/:id` | 改状态：`{ status }` |
| `DELETE /admin/comments/:id` | 删除，回复一起删 |
| `DELETE /admin/spam` | 清空垃圾箱：`{ ok, removed }` |
| `GET /admin/stats` | 各状态数量 `{ pending, approved, hidden, spam }`；带 `?since=` 多一个 `since`：之后读者发的评论数（垃圾、博主自己发的不算） |
| `GET /admin/traffic` | `{ views, online, entries: [{ entry, views }] }` |
| `GET` / `PUT /admin/settings` | 防垃圾规则 `{ spam }` |
| `GET` / `PUT /admin/mail` | 邮件提醒 `{ mail }`；密码、Key 只进不出，留空表示不改 |
| `POST /admin/mail/test` | 给博主的邮箱发一封测试信 |

评论对象：`{ id, entry, parentId, body, name, avatar, url, author, createdAt, status, email, ip, block, start, end, quote, prefix, suffix }`（后六个是引用评论的位置和引文，普通评论是 null）。

## Cloudflare Workers + D1

见 `wrangler.example.toml` 顶部的四步。

## 升级

拉新代码、重新启动（Node）或 `wrangler deploy`（Workers）就行。服务启动时会对比库里记的表结构版本（`settings` 表里的 `schema_version`），落后了就自动升级：建缺的表和索引、补缺的列、重建旧的状态约束，评论数据都保留。SQLite 和 D1 都一样，不用手动执行 SQL。

Studio 的“设定 → 更新”可以查有没有新版本（读的是 GitHub 上的 `package.json`）。

## 开发

```bash
pnpm dev     # 管理令牌 dev-token，数据库在 .data/
pnpm test
pnpm schema # 改了 schema.sql 之后，重新生成 src/schema.ts
pnpm check
```

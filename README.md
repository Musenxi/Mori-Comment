# Mori Comment

[Mori](https://github.com/Musenxi/Astro-Theme-Mori) 博客的自建评论服务。

- 文末评论、划词引用评论、楼中楼回复
- 阅读量、在线访客（WebSocket 实时）
- 审核、防垃圾规则、垃圾箱
- 邮件提醒：SMTP、Resend、Cloudflare Email Service
- 同一份代码跑在 Node（SQLite）和 Cloudflare Workers（D1）上，表结构自动升级

管理界面在 [Mori Studio](https://github.com/Musenxi/Mori-Studio)。

## 部署

### Docker

```bash
docker run -d --name mori-comments --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -v mori-comments:/data \
  -e ADMIN_TOKEN=换成一长串随机字符 -e ALLOW_ORIGIN=https://blog.example.com \
  ghcr.io/musenxi/mori-comment:latest
```

或者克隆仓库，用自带的 `docker-compose.yml`：

```bash
cp .env.example .env
docker compose up -d
```

数据在卷里的 `/data/comments.db`。前面放一个反向代理（Caddy、Nginx）提供 HTTPS；和站点、Caddy 一起部署见主题的 [deploy/](https://github.com/Musenxi/Astro-Theme-Mori/tree/main/deploy)。

### Node

需要 Node ≥ 22.18。

```bash
pnpm install --prod
cp .env.example .env
pnpm start
```

启动时会读当前目录的 `.env`。

### Cloudflare Workers + D1

```bash
pnpm install
cp wrangler.example.toml wrangler.toml
npx wrangler d1 create mori-comments   # 把 database_id 填进 wrangler.toml
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

部署前改 `wrangler.toml` 里的 `ALLOW_ORIGIN`。Workers 版不支持 SMTP。

## 配置

| 变量 | 默认 | |
| --- | --- | --- |
| `ADMIN_TOKEN` | — | 管理令牌，在 Studio 里填它。不设则管理接口关闭 |
| `ALLOW_ORIGIN` | — | 站点地址，多个用逗号分隔；`*` 为不限 |
| `PORT` | `8787` | 仅 Node |
| `DB_PATH` | `./comments.db` | 仅 Node；Docker 里是 `/data/comments.db` |
| `AUTO_APPROVE` | `returning` | `returning` 通过过的人直接发 / `all` / `none` |
| `TURNSTILE_SECRET` | — | Cloudflare Turnstile 人机验证 |
| `SALT` | 自动生成 | 读者标识的哈希盐，不设则首次启动时生成并存入数据库 |

防垃圾规则、邮件提醒在 Studio 的“设定 → 评论”里配置，存在数据库里。

## 接入站点

```ts
// mori.config.ts
comments: { provider: 'mori', endpoint: 'https://comments.example.com' }
```

## 升级与备份

- 升级：Docker `docker compose pull && docker compose up -d`；Node 拉代码后重启；Workers 重新 `wrangler deploy`。启动时按 `settings.schema_version` 自动升级表结构，数据保留。
- 备份：Node / Docker 备份 SQLite 文件（连同 `-wal`）；D1 用 `wrangler d1 export`。

## 邮件提醒

新评论提醒博主（垃圾箱里的除外），回复提醒被回复的读者。

| 方式 | 说明 |
| --- | --- |
| SMTP | 465 端口用 TLS，其他端口用 STARTTLS。仅 Node |
| Resend | 填 API Key；发信域名需先在 Resend 验证 |
| Cloudflare Email Service | Workers 版绑定 `send_email`（见 `wrangler.example.toml`）即可；Node 版填账号 ID 和 API 令牌。发信域名需先接入 |

邮件里的表情（`:[包名_表情名]`）：发信时从「站点地址」取 `/emoji.json`（Mori 主题构建时自动生成，内容是 `{ "包名_表情名": 图片地址 }`），有清单就换成图片，取不到就原样写成文字。清单缓存 10 分钟，所以站点要在「设定 → 评论 → 邮件提醒」里填了站点地址。

## 公开接口

| 接口 | 说明 |
| --- | --- |
| `GET /comments?entry=posts/xxx` | 已通过的评论。参数 `page`（默认 1，超出末页取末页）、`limit`（1–50，默认 20）。顶层评论新的在前、按顶层评论分页，这一页每条顶层评论的回复（从早到晚）跟在后面。返回 `{ comments, total, page, pages, limit }`，`total` 是这篇文章全部评论数（含回复） |
| `GET /comments?entry=posts/xxx&annotations=1` | 这篇文章全部引用评论（block 不为空）和它们的回复，不分页。返回 `{ comments, total }` |
| `POST /comments` | 提交评论、引用评论、回复 |

## 管理接口

都在 `/admin/` 下，请求头带 `Authorization: Bearer <ADMIN_TOKEN>`。令牌不对返回 401，服务没设令牌返回 503；出错时返回 `{ "error": "原因" }`。

| 接口 | 说明 |
| --- | --- |
| `GET /admin/info` | `{ service, version, api, schema, runtime, features, autoApprove }`。`api` 只在不兼容的改动时加一；新能力看 `features`。也用来测令牌 |
| `GET /admin/comments` | 新的在前。参数 `status`（pending / approved / hidden / spam，不给是垃圾箱以外的全部）、`entry`、`since`（毫秒时间戳）、`before`（游标）、`limit`（1–500，默认 100）。返回 `{ comments, next }` |
| `POST /admin/comments` | 以博主身份发评论：`{ entry, body, name, email?, url?, parentId?, title? }`。回复待审评论时一并通过 |
| `PATCH /admin/comments/:id` | `{ status }` |
| `DELETE /admin/comments/:id` | 连同回复一起删除 |
| `DELETE /admin/spam` | 清空垃圾箱，返回 `{ ok, removed }` |
| `GET /admin/stats` | `{ pending, approved, hidden, spam }`；带 `?since=` 时多一个 `since`（之后读者发的评论数） |
| `GET /admin/traffic` | `{ views, likes, online, entries: [{ entry, views, likes }] }` |
| `GET` / `PUT /admin/settings` | 防垃圾规则 `{ spam }` |
| `GET` / `PUT /admin/mail` | 邮件提醒 `{ mail }`；密码、Key 只写不读，留空表示不改 |
| `POST /admin/mail/test` | 给博主发测试信 |

评论对象：`{ id, entry, parentId, body, name, avatar, url, author, createdAt, status, email, ip, block, start, end, quote, prefix, suffix }`，后六项是引用评论的位置和引文。

## 开发

```bash
pnpm dev      # 令牌 dev-token，数据库在 .data/
pnpm test
pnpm check
pnpm schema   # 改了 schema.sql 后重新生成 src/schema.ts
```

## License

MIT

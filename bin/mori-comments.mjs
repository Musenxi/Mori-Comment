#!/usr/bin/env node
/**
 * VPS 上运行评论服务（Node + SQLite）。配置用环境变量，当前目录有 .env 就先读它（见 .env.example）：
 *   PORT=8787  DB_PATH=./comments.db  ADMIN_TOKEN=…  ALLOW_ORIGIN=https://你的站点
 *   TURNSTILE_SECRET=…（可选）  SALT=…（可选，不设就自动生成存进库里）  AUTO_APPROVE=returning|all|none
 * 注意：源码是 TypeScript，靠 Node 的类型剥离直接运行（Node ≥ 22.18）；发布到 npm 时会先编译。
 */
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const { startNode } = await import('../src/node.ts');

const env = process.env;
if (!env.ADMIN_TOKEN) console.warn('提示：没有设置 ADMIN_TOKEN，管理接口（审核、隐藏、删除）是关闭的。');
const port = Number(env.PORT || 8787), dbPath = env.DB_PATH || './comments.db';
const { server } = await startNode({
  dbPath, port,
  adminToken: env.ADMIN_TOKEN || undefined, turnstileSecret: env.TURNSTILE_SECRET || undefined,
  allowOrigin: env.ALLOW_ORIGIN || undefined, salt: env.SALT || undefined,
  autoApprove: env.AUTO_APPROVE || undefined,
});
console.log(`Mori 评论服务已启动：端口 ${port}，数据库 ${dbPath}`);

// docker stop 发的是 SIGTERM
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });

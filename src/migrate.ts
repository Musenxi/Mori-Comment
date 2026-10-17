import { SCHEMA } from './schema.ts';

/**
 * 表结构的版本：改了 schema.sql 就加一（再跑 pnpm schema）。
 * 库里的版本在 settings 表（schema_version）；服务启动时和代码里的不一样，就把库升到最新：
 * 建缺的表和索引、补缺的列、旧的状态约束重建，数据都保留。SQLite 和 D1 走同一套，不用再手动执行 migrations-*.sql。
 */
export const SCHEMA_VERSION = 6;

/** 两种存储各自实现：查询，和“一批语句一起提交（要么都成功，要么都不动）” */
export interface Sql {
  all(sql: string): Promise<any[]>;
  batch(statements: string[]): Promise<void>;
}

/** 去掉注释，按分号拆成一条一条语句（schema.sql 的字符串里没有分号） */
export function statements(sql: string) {
  return sql.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);
}

/** 库里现在的表结构版本；还没记过（老库、新库）是 0 */
export async function currentVersion(db: Sql) {
  try { return Number((await db.all(`SELECT value FROM settings WHERE key = 'schema_version'`))[0]?.value ?? 0); } catch { return 0; }
}

export async function migrate(db: Sql) {
  if ((await currentVersion(db)) === SCHEMA_VERSION) return;
  // comments 表和 schema.sql 里的不一样（少列、状态里没有 spam）：按新结构重建，数据搬过去（CREATE TABLE IF NOT EXISTS 不会改已经存在的表）
  const old = (await db.all(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'comments'`))[0]?.sql as string | undefined;
  if (old) {
    const ddl = SCHEMA.match(/CREATE TABLE IF NOT EXISTS comments \(([\s\S]*?)\n\);/)![1];
    const have = new Set((await db.all('PRAGMA table_info(comments)')).map((c) => c.name));
    const want = [...ddl.matchAll(/^\s+"?(\w+)"?\s+(?:INTEGER|TEXT)/gm)].map((m) => m[1]);
    if (!old.includes("'spam'") || want.some((c) => !have.has(c))) {
      const cols = want.filter((c) => have.has(c)).map((c) => `"${c}"`).join(', ');
      await db.batch([
        'PRAGMA defer_foreign_keys = true',
        // parent_id 先指向新表自己：指向旧表的话，删旧表时外键会报错；改名后 SQLite 会跟着改成 comments
        `CREATE TABLE comments_new (${ddl.replace('REFERENCES comments(', 'REFERENCES comments_new(')}\n)`,
        `INSERT INTO comments_new (${cols}) SELECT ${cols} FROM comments`,
        'DROP TABLE comments',
        'ALTER TABLE comments_new RENAME TO comments',
      ]);
    }
  }
  await db.batch([...statements(SCHEMA), `INSERT INTO settings (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`]);
}

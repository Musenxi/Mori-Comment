import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { d1Store } from '../src/d1.ts';
import { SCHEMA } from '../src/schema.ts';
import { SCHEMA_VERSION, currentVersion } from '../src/migrate.ts';

/** 用 SQLite 冒充 D1（外键开着，batch 是一个事务）。库是空的或者是老版本的，由调用方准备 */
function fakeD1(db: DatabaseSync) {
  db.exec('PRAGMA foreign_keys = ON');
  const stmt = (sql: string, a: any[] = []) => ({
    all: async () => ({ results: db.prepare(sql).all(...a) as any[] }),
    first: async () => (db.prepare(sql).get(...a) as any) ?? null,
    run: async () => { const r = db.prepare(sql).run(...a); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return {
    prepare: (sql: string) => ({ bind: (...a: any[]) => Object.assign(stmt(sql, a), { sql, a }) }),
    async batch(list: any[]) {
      db.exec('BEGIN');
      try { for (const s of list) db.prepare(s.sql).run(...s.a); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

test('schema.ts 和 schema.sql 一致（改了 schema.sql 要跑 pnpm schema）', () => {
  assert.equal(SCHEMA, readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
});

test('D1：空库自己建表，记下表结构版本，重复启动不出错', async () => {
  const db = new DatabaseSync(':memory:');
  const store = d1Store(fakeD1(db));
  assert.equal(await currentVersion({ all: async (s) => db.prepare(s).all() as any[], batch: async () => {} }), 0);
  await store.init();
  await store.init();
  assert.equal(await store.getSetting('schema_version'), String(SCHEMA_VERSION));
  assert.deepEqual(await store.countByStatus(), { pending: 0, approved: 0, hidden: 0, spam: 0 });
});

test('D1：只有头两版结构的老库升级后评论都在，能进垃圾箱，回复关系不丢', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL, block TEXT, start INTEGER, "end" INTEGER, quote TEXT, prefix TEXT, suffix TEXT, body TEXT NOT NULL, name TEXT NOT NULL, email_hash TEXT, ip_hash TEXT, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'hidden')), parent_id INTEGER REFERENCES comments(id));
    INSERT INTO comments (entry, body, name, created_at, status) VALUES ('posts/a', '旧评论', '老朋友', 1, 'approved');
    INSERT INTO comments (entry, body, name, created_at, status, parent_id) VALUES ('posts/a', '回复', '另一位', 2, 'approved', 1);`);
  const store = d1Store(fakeD1(db));
  await store.init();
  const rows = await store.listApproved('posts/a');
  assert.deepEqual(rows.map((r) => [r.body, r.parentId]), [['旧评论', null], ['回复', 1]]);
  assert.equal(await store.setStatus(rows[0].id, 'spam'), true);
  const cols = (db.prepare('PRAGMA table_info(comments)').all() as any[]).map((c) => c.name);
  assert.ok(cols.includes('author') && cols.includes('ip') && !cols.includes('email_hash'));
  assert.equal(await store.getSetting('schema_version'), String(SCHEMA_VERSION));
});

test('版本一致就什么都不做；落后了才重新检查', async () => {
  const db = new DatabaseSync(':memory:');
  const store = d1Store(fakeD1(db));
  await store.init();
  db.exec('DROP INDEX idx_comments_entry'); // 版本对得上，不会再去补
  await store.init();
  assert.equal((db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'idx_comments_entry'`).get() as any).n, 0);
  await store.setSetting('schema_version', '1');
  await store.init();
  assert.equal((db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'idx_comments_entry'`).get() as any).n, 1);
});

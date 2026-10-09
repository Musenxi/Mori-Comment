import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQL, fromDb, insertArgs, statusCounts, type Store, type Status } from './store.ts';

/** Node + SQLite（Node 内置的 node:sqlite，不需要编译原生模块） */
export function sqliteStore(path: string): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const all = (sql: string, ...args: any[]) => db.prepare(sql).all(...args) as any[];
  const one = (sql: string, ...args: any[]) => db.prepare(sql).get(...args) as any;
  return {
    async init() {
      const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
      // 老数据库：表结构和 schema.sql 不一样（少列、状态里没有 spam）就按新结构重建（CREATE TABLE IF NOT EXISTS 不会改已经存在的表）
      const old = one(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'comments'`)?.sql as string | undefined;
      if (old) {
        const ddl = schema.match(/CREATE TABLE IF NOT EXISTS comments \(([\s\S]*?)\n\);/)![1];
        const have = new Set(all('PRAGMA table_info(comments)').map((c) => c.name));
        const want = [...ddl.matchAll(/^\s+"?(\w+)"?\s+(?:INTEGER|TEXT)/gm)].map((m) => m[1]);
        if (!old.includes("'spam'") || want.some((c) => !have.has(c))) {
          const cols = want.filter((c) => have.has(c)).map((c) => `"${c}"`).join(', ');
          db.exec('PRAGMA foreign_keys = OFF');
          try {
            db.exec(`BEGIN; CREATE TABLE comments_new (${ddl}\n); INSERT INTO comments_new (${cols}) SELECT ${cols} FROM comments; DROP TABLE comments; ALTER TABLE comments_new RENAME TO comments; COMMIT;`);
          } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
        }
      }
      db.exec(schema);
    },
    async insert(c) { return Number(db.prepare(SQL.insert).run(...insertArgs(c)).lastInsertRowid); },
    async get(id) { const r = one(SQL.get, id); return r ? fromDb(r) : null; },
    async listApproved(entry) { return all(SQL.listApproved, entry).map(fromDb); },
    async listAdmin(status, limit, entry) { return all(SQL.listAdmin, status ?? null, status ?? null, entry ?? null, entry ?? null, limit).map(fromDb); },
    async countByStatus() { return statusCounts(all(SQL.count)); },
    async setStatus(id, status: Status) { return Number(db.prepare(SQL.setStatus).run(status, id).changes) > 0; },
    async clearSpam() { return Number(db.prepare(SQL.clearSpam).run().changes); },
    async remove(id) { return Number(db.prepare(SQL.remove).run(id, id).changes) > 0; },
    async countRecentByIp(ip, since) { return one(SQL.countRecentByIp, ip, since).n; },
    async hasApprovedBefore(email, name, ip) {
      if (email) return !!one(SQL.approvedByEmail, email);
      return ip ? !!one(SQL.approvedByNameIp, name, ip) : false;
    },
    async getSetting(key) { return one(SQL.getSetting, key)?.value ?? null; },
    async setSetting(key, value) { db.prepare(SQL.setSetting).run(key, value); },
    async lastView(visitor, entry) { return one(SQL.lastView, visitor, entry)?.at ?? null; },
    async addView(visitor, entry, at) { db.prepare(SQL.markView).run(visitor, entry, at); db.prepare(SQL.addView).run(entry); },
    async pruneViews(before) { db.prepare(SQL.pruneViews).run(before); },
    async viewsOf(entry) { return one(SQL.viewsOf, entry)?.count ?? 0; },
    async totalViews() { return one(SQL.totalViews).n; },
    async listViews() { return all(SQL.listViews).map((r) => ({ entry: r.entry, views: r.views })); },
  };
}

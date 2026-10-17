import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrate.ts';
import { SQL, fromDb, listAdminArgs, insertArgs, statusCounts, type Store, type Status } from './store.ts';

/** Node + SQLite（Node 内置的 node:sqlite，不需要编译原生模块） */
export function sqliteStore(path: string): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const all = (sql: string, ...args: any[]) => db.prepare(sql).all(...args) as any[];
  const one = (sql: string, ...args: any[]) => db.prepare(sql).get(...args) as any;
  return {
    async init() {
      await migrate({
        all: async (sql) => all(sql),
        // 重建表要先关外键（事务里改不了这个开关）
        async batch(stmts) {
          db.exec('PRAGMA foreign_keys = OFF');
          try {
            db.exec(`BEGIN; ${stmts.join(';\n')}; COMMIT`);
          } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
        },
      });
    },
    async insert(c) { return Number(db.prepare(SQL.insert).run(...insertArgs(c)).lastInsertRowid); },
    async get(id) { const r = one(SQL.get, id); return r ? fromDb(r) : null; },
    async listApproved(entry) { return all(SQL.listApproved, entry).map(fromDb); },
    async pageTop(entry, limit, offset) { return all(SQL.pageTop, entry, limit, offset).map(fromDb); },
    async repliesOf(ids) { return ids.length ? all(SQL.repliesOf(ids.length), ...ids).map(fromDb) : []; },
    async countApproved(entry) { const r = one(SQL.countApproved, entry); return { top: Number(r.top), all: Number(r.all) }; },
    async listAnnotated(entry) { return all(SQL.listAnnotated, entry).map(fromDb); },
    async listAdmin(q) { return all(SQL.listAdmin, ...listAdminArgs(q)).map(fromDb); },
    async countSince(since) { return one(SQL.countSince, since).n; },
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
    async likesOf(entry) { return one(SQL.likesOf, entry).n; },
    async liked(visitor, entry) { return !!one(SQL.liked, entry, visitor); },
    async setLike(visitor, entry, on, at) { if (on) db.prepare(SQL.like).run(entry, visitor, at); else db.prepare(SQL.unlike).run(entry, visitor); },
    async totalLikes() { return one(SQL.totalLikes).n; },
    async listLikes() { return all(SQL.listLikes).map((r) => ({ entry: r.entry, likes: r.likes })); },
  };
}

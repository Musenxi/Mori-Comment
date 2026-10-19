import { migrate } from './migrate.ts';
import { SQL, fromDb, listAdminArgs, insertArgs, statusCounts, type Store, type Status } from './store.ts';

/** Cloudflare D1。表由服务自己建、自己升级（见 migrate.ts），不用手动执行 schema.sql */
type D1Stmt = { all(): Promise<{ results: any[] }>; first(): Promise<any>; run(): Promise<{ meta: { changes: number; last_row_id: number } }> };
export interface D1Like {
  prepare(sql: string): { bind(...args: any[]): D1Stmt };
  /** 几条语句一起提交（一次往返，在同一个事务里） */
  batch?(stmts: D1Stmt[]): Promise<unknown>;
}

export function d1Store(db: D1Like): Store {
  const all = async (sql: string, ...a: any[]) => (await db.prepare(sql).bind(...a).all()).results;
  const one = (sql: string, ...a: any[]) => db.prepare(sql).bind(...a).first();
  const run = (sql: string, ...a: any[]) => db.prepare(sql).bind(...a).run();
  return {
    async init() {
      await migrate({
        all: (sql) => all(sql),
        // batch 是一个事务；没有 batch（测试里的替身）就一条一条执行
        async batch(stmts) {
          const list = stmts.map((s) => db.prepare(s).bind());
          if (db.batch) await db.batch(list); else for (const s of list) await s.run();
        },
      });
    },
    async insert(c) { return (await run(SQL.insert, ...insertArgs(c))).meta.last_row_id; },
    async get(id) { const r = await one(SQL.get, id); return r ? fromDb(r) : null; },
    async listApproved(entry) { return (await all(SQL.listApproved, entry)).map(fromDb); },
    async pageTop(entry, limit, offset) { return (await all(SQL.pageTop, entry, limit, offset)).map(fromDb); },
    async repliesOf(ids) { return ids.length ? (await all(SQL.repliesOf(ids.length), ...ids)).map(fromDb) : []; },
    async countApproved(entry) { const r = await one(SQL.countApproved, entry); return { top: Number(r.top), all: Number(r.all) }; },
    async listAnnotated(entry) { return (await all(SQL.listAnnotated, entry)).map(fromDb); },
    async listAdmin(q) { return (await all(SQL.listAdmin, ...listAdminArgs(q))).map(fromDb); },
    async countSince(since) { return (await one(SQL.countSince, since)).n; },
    async countByStatus() { return statusCounts(await all(SQL.count)); },
    async setStatus(id, status: Status) { return (await run(SQL.setStatus, status, id)).meta.changes > 0; },
    async setBody(id, body: string) { return (await run(SQL.setBody, body, id)).meta.changes > 0; },
    async clearSpam() { return (await run(SQL.clearSpam)).meta.changes; },
    async remove(id) { return (await run(SQL.remove, id, id)).meta.changes > 0; },
    async countRecentByIp(ip, since) { return (await one(SQL.countRecentByIp, ip, since)).n; },
    async hasApprovedBefore(email, name, ip) {
      if (email) return !!(await one(SQL.approvedByEmail, email));
      return ip ? !!(await one(SQL.approvedByNameIp, name, ip)) : false;
    },
    async getSetting(key) { return (await one(SQL.getSetting, key))?.value ?? null; },
    async setSetting(key, value) { await run(SQL.setSetting, key, value); },
    async lastView(visitor, entry) { return (await one(SQL.lastView, visitor, entry))?.at ?? null; },
    async addView(visitor, entry, at) {
      const mark = db.prepare(SQL.markView).bind(visitor, entry, at), add = db.prepare(SQL.addView).bind(entry);
      if (db.batch) await db.batch([mark, add]); else { await mark.run(); await add.run(); }
    },
    async pruneViews(before) { await run(SQL.pruneViews, before); },
    async viewsOf(entry) { return (await one(SQL.viewsOf, entry))?.count ?? 0; },
    async totalViews() { return (await one(SQL.totalViews)).n; },
    async listViews() { return (await all(SQL.listViews)).map((r) => ({ entry: r.entry, views: r.views })); },
    async likesOf(entry) { return (await one(SQL.likesOf, entry)).n; },
    async liked(visitor, entry) { return !!(await one(SQL.liked, entry, visitor)); },
    async setLike(visitor, entry, on, at) { if (on) await run(SQL.like, entry, visitor, at); else await run(SQL.unlike, entry, visitor); },
    async totalLikes() { return (await one(SQL.totalLikes)).n; },
    async listLikes() { return (await all(SQL.listLikes)).map((r) => ({ entry: r.entry, likes: r.likes })); },
  };
}

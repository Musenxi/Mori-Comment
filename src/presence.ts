/**
 * 在线访客（Node 版，放在内存里）：页面连上 /online/ws 就算在线，断开就不算。
 * 同一位读者开几个页面只算一个；只看的连接（Studio 仪表盘）不算。
 * 连接可以报自己在读哪一页（连接时的 ?page=，换页时发 {"page": "/posts/x/"}）。
 * 人数或各页的人数一变就推给所有连接：{"online": n, "pages": [["/posts/x/", 2], …]}（人多的在前）；
 * 只看的连接另外收到全站阅读量、点赞数的变化：{"views": n}、{"likes": n}
 * Cloudflare Workers 上同样的事由 Durable Object 做，见 presence-do.ts。
 */
export interface Peer { send(msg: string): void }

/** 一个连接：读者标识的哈希（null 是只看人数的连接）和它在读的页面 */
export interface Seat { visitor: string | null; page: string | null }

/** 推出去的页面最多几个 */
const MAX_PAGES = 30;

/** 页面只收站内路径：去掉查询和锚点，不能有空白、引号、尖括号 */
export function cleanPage(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const p = s.split(/[?#]/)[0];
  return p.length <= 300 && /^\/[^\s<>"'`\\]*$/.test(p) ? p : null;
}

/** 从连接里数出人数和各页的人数（同一位读者在同一页开几个只算一个） */
export function tally(seats: Iterable<Seat>) {
  const all = new Set<string>(), byPage = new Map<string, Set<string>>();
  for (const { visitor, page } of seats) {
    if (!visitor) continue;
    all.add(visitor);
    if (page) (byPage.get(page) ?? byPage.set(page, new Set()).get(page)!).add(visitor);
  }
  const pages = [...byPage].map(([p, s]): [string, number] => [p, s.size])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_PAGES);
  return { online: all.size, pages };
}

export class Presence {
  private peers = new Map<Peer, Seat>();
  private last = '';

  count() { return this.snapshot().online; }
  snapshot() { return tally(this.peers.values()); }

  join(peer: Peer, visitor: string | null, page: string | null = null) {
    this.peers.set(peer, { visitor, page: visitor ? page : null });
    if (!this.changed()) send(peer, this.last); // 没变就只告诉新来的
  }

  /** 读者换了页 */
  move(peer: Peer, page: string | null) {
    const seat = this.peers.get(peer);
    if (!seat?.visitor || seat.page === page) return;
    seat.page = page;
    this.changed();
  }

  /** 推给只看的连接 */
  toWatchers(data: Record<string, number>) {
    const msg = JSON.stringify(data);
    for (const [p, v] of this.peers) if (v.visitor === null) send(p, msg);
  }

  leave(peer: Peer) {
    if (this.peers.delete(peer)) this.changed();
  }

  /** 人数或各页变了就推给所有连接；返回有没有推 */
  private changed() {
    const msg = JSON.stringify(this.snapshot());
    if (msg === this.last) return false;
    this.last = msg;
    for (const p of this.peers.keys()) send(p, msg);
    return true;
  }
}

const send = (p: Peer, msg: string) => { try { p.send(msg); } catch { /* 连接已经断了，等 close 事件 */ } };

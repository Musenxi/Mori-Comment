/**
 * Mori 自建评论的 HTTP 接口（spec §5.1）。Hono 写一份，Node 和 Cloudflare Workers 共用；
 * 存储通过 Store 接口注入（SQLite / D1）。
 *
 *   GET    /comments?entry=posts/xxx         某篇文章下已通过的评论（含划词引用评论）
 *   POST   /comments                         提交评论 / 引用评论 / 回复
 *   POST   /views     {entry, visitor}       记一次阅读，返回这一篇的阅读量
 *   GET    /views?entry=posts/xxx            某篇的阅读量
 *   GET    /likes?entry=posts/xxx&visitor=…  某篇的点赞数，这位读者赞过没有：{likes, liked}
 *   POST   /likes     {entry, visitor, liked} 点赞（liked: true）或取消（false），返回同上
 *   GET    /online                           在线人数
 *   GET    /online/ws?visitor=…&page=/x/     WebSocket：连着就算在线，换页时发 {"page": "/y/"}；
 *                                            人数或各页人数一变就推 {"online": n, "pages": [["/x/", n], …]}；
 *                                            ?watch=1 只看、不算在线（Studio 仪表盘），另外每记一次阅读推 {"views": 全站阅读量}，点赞变了推 {"likes": 全站点赞数}
 *                                            （升级请求不经过这里：Node 见 node.ts，Workers 见 worker.ts）
 *   /admin/*                                 管理接口，只接受管理令牌（Authorization: Bearer <token>），见 README 的“管理接口”
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { md5 } from './md5.ts';
import { NO_RULES, blocked, cleanRules, type SpamRules } from './spam.ts';
import { authorMail, cleanMail, publicMail, readMail, replyMail, testMail, type MailComment, type SendMail } from './mail.ts';
import type { Store, CommentRow, Status } from './store.ts';
import pkg from '../package.json' with { type: 'json' };

/** 管理接口的版本：删字段、改含义时加一；只加字段、加接口不变（客户端看 /admin/info 的 features） */
export const API_VERSION = 1;

export interface AppOptions {
  store: Store;
  /** 管理令牌。不设置就关闭全部管理接口 */
  adminToken?: string;
  /** Cloudflare Turnstile 的密钥；不设置就不验证（本地开发） */
  turnstileSecret?: string;
  /** 允许跨域的站点：'*' 或逗号分隔的来源，如 https://example.com */
  allowOrigin?: string;
  /** 给读者标识（阅读量去重用）做哈希用的盐 */
  salt?: string;
  /** 新评论要不要先审：returning（默认）＝第一次留言的人先审后发，以前通过过的直接发；all 全部直接发；none 全部先审 */
  autoApprove?: 'returning' | 'all' | 'none';
  /** 在线人数从哪里来（Node 是内存里的 Presence，Workers 是 Durable Object）；不给就是 null */
  online?: () => Promise<number | null>;
  /** 记了一次阅读之后调用，参数是全站阅读量（推给只看的连接） */
  onView?: (total: number) => void | Promise<void>;
  /** 点赞数变了之后调用，参数是全站点赞数 */
  onLike?: (total: number) => void | Promise<void>;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** 发一封邮件（Node 和 Workers 各自实现，见 node.ts、worker.ts）；不给就不发提醒 */
  sendMail?: SendMail;
  /** 跑在哪里（/admin/info 里给出） */
  runtime?: 'node' | 'workers';
  /** 这个运行环境能用的发信方式 */
  mailProviders?: Array<'smtp' | 'resend' | 'cloudflare'>;
}

export const LIMITS = { name: 40, email: 120, url: 200, body: 4000, quote: 600, context: 200, perMinute: 3, perDay: 20 };
const ENTRY = /^(posts|pages)\/[A-Za-z0-9][A-Za-z0-9_-]*$/;
const BLOCK = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** 浏览器里随机生成、存在 localStorage 里的读者 id */
const VISITOR = /^[A-Za-z0-9_-]{16,64}$/;
/** 同一位读者多久之内重复打开同一篇只算一次阅读 */
export const VIEW_WINDOW = 30 * 60_000;
const BOT = /bot|spider|crawl|slurp|preview|headless|lighthouse|monitor|curl|wget|python|java\/|go-http/i;
export const isBot = (ua: string | null | undefined) => BOT.test(ua ?? '');

/** 读者标识只存加盐哈希；页面没带 id（禁用了 localStorage）就用 IP + UA 凑一个 */
export const visitorKey = (salt: string, id: unknown, ip: string, ua: string) =>
  sha256(`${salt}|visitor|${typeof id === 'string' && VISITOR.test(id) ? id : `${ip}|${ua}`}`);

/** 来源在不在允许的站点里（allowOrigin 同 AppOptions） */
export const originAllowed = (allowOrigin: string | undefined, origin: string | null | undefined) => {
  const list = (allowOrigin ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes('*') || (!!origin && list.includes(origin));
};

/** 对外的字段：不含邮箱、IP、状态这些内部信息。avatar 是头像哈希（Gravatar 那种），url 是读者留的网址，author 是博主发的 */
export const publicOf = (c: CommentRow) => ({
  id: c.id, block: c.block, start: c.start, end: c.end, quote: c.quote, prefix: c.prefix, suffix: c.suffix,
  body: c.body, name: c.name, avatar: c.avatarHash, url: c.url, author: c.author, createdAt: c.createdAt, parentId: c.parentId,
});

/** 读者留的网址：只收 http / https，去掉首尾空白；没写返回 ''，写了但不合法返回 null */
export function cleanUrl(v: unknown): string | null {
  const raw = clip(v, LIMITS.url);
  if (!raw) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`); // 只写了 example.com 也行，补上 https
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.') ? u.href : null;
  } catch { return null; }
}

async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 恒定时间比较（避免通过响应时间猜令牌） */
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** 回完请求再做的事：Workers 里交给 waitUntil（不然请求一结束就被掐掉），Node 里直接在后台跑 */
function later(c: any, p: Promise<unknown>) {
  const q = p.catch((e) => console.error(e));
  try { c.executionCtx.waitUntil(q); } catch { /* Node 没有 executionCtx */ }
}

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1_000_000;
/** 时间戳参数：非负整数，否则当作没给 */
const timeParam = (v: string | undefined) => (v && /^\d{1,15}$/.test(v) ? Number(v) : undefined);
/** 翻页游标：上一页最后一条的 `创建时间.id` */
const cursorOf = (c: CommentRow) => `${c.createdAt}.${c.id}`;
const parseCursor = (v: string | undefined) => {
  const m = /^(\d{1,15})\.(\d{1,9})$/.exec(v ?? '');
  return m ? { createdAt: Number(m[1]), id: Number(m[2]) } : undefined;
};

/** 没配 SALT 就用库里存的；第一次运行时随机生成一个存起来 */
export async function resolveSalt(store: Store, salt?: string) {
  if (salt) return salt;
  const saved = await store.getSetting('salt');
  if (saved) return saved;
  const fresh = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await store.setSetting('salt', fresh);
  return fresh;
}

export function createApp(opts: AppOptions) {
  const { store } = opts;
  const now = opts.now ?? Date.now;
  const salt = opts.salt ?? 'mori';
  const doFetch = opts.fetchImpl ?? fetch;
  const app = new Hono();

  const anyOrigin = originAllowed(opts.allowOrigin, null); // 只有设成 * 时，没有来源也算允许
  app.use('*', cors({
    origin: (o) => (anyOrigin ? '*' : originAllowed(opts.allowOrigin, o) ? o : ''),
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }));

  app.get('/health', (c) => c.json({ ok: true }));

  /* ───────────── 公开接口 ───────────── */

  app.get('/comments', async (c) => {
    const entry = c.req.query('entry') ?? '';
    if (!ENTRY.test(entry)) return c.json({ error: 'entry 不合法' }, 400);
    return c.json({ comments: (await store.listApproved(entry)).map(publicOf) });
  });

  app.post('/comments', async (c) => {
    let b: any;
    try { b = await c.req.json(); } catch { return c.json({ error: '请求不是 JSON' }, 400); }

    // 蜜罐：真人看不到这个字段；机器人往里填了，就假装成功但不存
    if (typeof b.website === 'string' && b.website !== '') return c.json({ status: 'pending' }, 201);

    const entry = clip(b.entry, 200), body = clip(b.body, LIMITS.body), name = clip(b.name, LIMITS.name), email = clip(b.email, LIMITS.email);
    const url = cleanUrl(b.url);
    if (!ENTRY.test(entry)) return c.json({ error: 'entry 不合法' }, 400);
    if (!body) return c.json({ error: '评论不能是空的' }, 400);
    if (!name) return c.json({ error: '请留个名字' }, 400);
    if (!email) return c.json({ error: '请留个邮箱' }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: '邮箱格式不对' }, 400);
    if (url === null) return c.json({ error: '网址格式不对' }, 400);

    // 引用评论：钉在哪个块的哪一段字上；块 id 加起止位置，加被选中的原文和前后文（文章改了以后靠它们重新找）
    let anchor: { block: string; start: number; end: number; quote: string; prefix: string; suffix: string } | null = null;
    if (b.block != null) {
      const quote = clip(b.quote, LIMITS.quote);
      if (typeof b.block !== 'string' || !BLOCK.test(b.block) || !isInt(b.start) || !isInt(b.end) || b.end <= b.start || !quote) return c.json({ error: '引用评论的位置不合法' }, 400);
      anchor = { block: b.block, start: b.start, end: b.end, quote, prefix: clip(b.prefix, LIMITS.context), suffix: clip(b.suffix, LIMITS.context) };
    }

    // 回复：只能回复同一篇里已通过的评论；回复回复的，挂到最上面那条下面（只有一层）
    let parentId: number | null = null, target: CommentRow | null = null;
    if (b.parentId != null) {
      const p = isInt(b.parentId) ? await store.get(b.parentId) : null;
      if (!p || p.entry !== entry || p.status !== 'approved') return c.json({ error: '要回复的评论不存在' }, 400);
      parentId = p.parentId ?? p.id;
      target = p;
    }

    // 人机验证
    if (opts.turnstileSecret) {
      const ok = await verifyTurnstile(doFetch, opts.turnstileSecret, clip(b.turnstile, 2048), ipOf(c));
      if (!ok) return c.json({ error: '人机验证没通过，请刷新页面再试' }, 403);
    }

    // 限流：按 IP 数最近一分钟和一天里发了几条
    const ip = ipOf(c) || null;
    const t = now();
    if (ip) {
      if ((await store.countRecentByIp(ip, t - 60_000)) >= LIMITS.perMinute) return c.json({ error: '发得太快了，过一会儿再试' }, 429);
      if ((await store.countRecentByIp(ip, t - 86_400_000)) >= LIMITS.perDay) return c.json({ error: '今天发得够多了，明天再来' }, 429);
    }

    const mail = email.toLowerCase();
    const avatarHash = md5(mail);
    const mode = opts.autoApprove ?? 'returning';
    // 防垃圾：命中屏蔽词、IP 段、网址、昵称的进垃圾箱；对读者只说“等审核”，不让人知道被拦了
    const spam = blocked(await spamRules(), { body, name, url: url || '', ip });
    const status: Status = spam ? 'spam' : mode === 'all' ? 'approved' : mode === 'none' ? 'pending' : (await store.hasApprovedBefore(mail, name, ip)) ? 'approved' : 'pending';

    const id = await store.insert({
      entry, block: anchor?.block ?? null, start: anchor?.start ?? null, end: anchor?.end ?? null,
      quote: anchor?.quote ?? null, prefix: anchor?.prefix ?? null, suffix: anchor?.suffix ?? null,
      body, name, email: mail, avatarHash, url: url || null, ip, author: false, createdAt: t, status, parentId,
    });
    const saved = (await store.get(id))!;
    // 邮件提醒：博主（垃圾箱里的不提醒）；读者（回复直接通过时，提醒被回复的那位）
    if (!spam) later(c, notify(saved, clip(b.title, 200) || undefined, status === 'approved' ? target : null, true));
    return c.json({ status: spam ? 'pending' : status, comment: status === 'approved' ? publicOf(saved) : undefined }, 201);
  });

  /* ───────────── 阅读量、在线访客 ─────────────
     页面用不带 Content-Type 的 fetch 发（浏览器当作 text/plain，跨域不用预检），所以这里自己解析正文 */

  const bodyOf = async (c: any) => { try { return JSON.parse(await c.req.text()); } catch { return null; } };
  const online = async () => (opts.online ? opts.online().catch(() => null) : null);

  app.post('/views', async (c) => {
    const b = await bodyOf(c);
    const entry = typeof b?.entry === 'string' ? b.entry : '';
    if (!ENTRY.test(entry)) return c.json({ error: 'entry 不合法' }, 400);
    if (!isBot(c.req.header('user-agent'))) {
      const visitor = await visitorKey(salt, b.visitor, ipOf(c), c.req.header('user-agent') ?? ''), t = now();
      const last = await store.lastView(visitor, entry);
      if (last === null || last <= t - VIEW_WINDOW) {
        await store.addView(visitor, entry, t);
        await store.pruneViews(t - VIEW_WINDOW);
        if (opts.onView) await Promise.resolve(opts.onView(await store.totalViews())).catch(() => {});
      }
    }
    return c.json({ views: await store.viewsOf(entry) });
  });

  app.get('/views', async (c) => {
    const entry = c.req.query('entry') ?? '';
    if (!ENTRY.test(entry)) return c.json({ error: 'entry 不合法' }, 400);
    return c.json({ views: await store.viewsOf(entry) });
  });

  const likesOf = async (visitor: string, entry: string) => ({ likes: await store.likesOf(entry), liked: await store.liked(visitor, entry) });

  app.get('/likes', async (c) => {
    const entry = c.req.query('entry') ?? '';
    if (!ENTRY.test(entry)) return c.json({ error: 'entry 不合法' }, 400);
    return c.json(await likesOf(await visitorKey(salt, c.req.query('visitor'), ipOf(c), c.req.header('user-agent') ?? ''), entry));
  });

  app.post('/likes', async (c) => {
    const b = await bodyOf(c);
    const entry = typeof b?.entry === 'string' ? b.entry : '';
    if (!ENTRY.test(entry) || typeof b.liked !== 'boolean') return c.json({ error: '参数不对' }, 400);
    const visitor = await visitorKey(salt, b.visitor, ipOf(c), c.req.header('user-agent') ?? '');
    if (!isBot(c.req.header('user-agent')) && (await store.liked(visitor, entry)) !== b.liked) {
      await store.setLike(visitor, entry, b.liked, now());
      if (opts.onLike) await Promise.resolve(opts.onLike(await store.totalLikes())).catch(() => {});
    }
    return c.json(await likesOf(visitor, entry));
  });

  app.get('/online', async (c) => c.json({ online: await online() }));

  /* ───────────── 管理接口 ───────────── */

  const spamRules = async (): Promise<SpamRules> => {
    try { return cleanRules(JSON.parse((await store.getSetting('spam')) ?? 'null')); } catch { return NO_RULES; }
  };

  const mailSettings = async () => readMail(await store.getSetting('mail'));

  /**
   * 发提醒：toAuthor 时给博主发“有新评论”（博主自己发的不算）；target 是被回复的那条，给它的作者发“有人回复”
   * （没留邮箱、是博主自己、或者自己回复自己就不发）。出错只记日志，不影响评论本身
   */
  async function notify(c: CommentRow, title: string | undefined, target: CommentRow | null, toAuthor: boolean) {
    if (!opts.sendMail) return;
    const m = await mailSettings();
    if (m.provider === 'off') return;
    const mc: MailComment = { id: c.id, entry: c.entry, name: c.name, email: c.email, url: c.url, ip: c.ip, body: c.body, status: c.status };
    const jobs: Promise<void>[] = [];
    if (toAuthor && m.notifyAuthor && m.to && !c.author) jobs.push(opts.sendMail(m, authorMail(m, mc, title)));
    if (m.notifyReply && target?.email && !target.author && target.email !== c.email) jobs.push(opts.sendMail(m, replyMail(m, target.email, target, mc, title)));
    for (const r of await Promise.allSettled(jobs)) if (r.status === 'rejected') console.error(`邮件提醒发送失败：${(r.reason as Error)?.message ?? r.reason}`);
  }

  const admin = new Hono();
  admin.use('*', async (c, next) => {
    if (!opts.adminToken) return c.json({ error: '管理接口没有开启（没设置管理令牌）' }, 503);
    const h = c.req.header('authorization') ?? '';
    if (!h.startsWith('Bearer ') || !safeEqual(h.slice(7), opts.adminToken)) return c.json({ error: '没有权限' }, 401);
    await next();
  });
  /** 服务的版本和能力：客户端（Studio）据此判断能用哪些功能；顺便验证令牌 */
  admin.get('/info', async (c) => c.json({
    service: 'mori-comments', version: pkg.version, api: API_VERSION, schema: Number(await opts.store.getSetting('schema_version')) || 0, runtime: opts.runtime ?? null,
    features: {
      mail: opts.sendMail ? (opts.mailProviders ?? []) : [],
      online: !!opts.online, turnstile: !!opts.turnstileSecret, cursor: true, since: true, likes: true,
    },
    autoApprove: opts.autoApprove ?? 'returning',
  }));
  admin.get('/comments', async (c) => {
    const s = c.req.query('status');
    const status = s === 'pending' || s === 'approved' || s === 'hidden' || s === 'spam' ? s : undefined;
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit')) || 100));
    const entry = c.req.query('entry');
    // 多取一条，看还有没有下一页
    const rows = await store.listAdmin({ status, limit: limit + 1, entry: entry && ENTRY.test(entry) ? entry : undefined, since: timeParam(c.req.query('since')), before: parseCursor(c.req.query('before')) });
    const page = rows.slice(0, limit);
    // 管理列表多带 status、邮箱、IP，其余同对外字段
    return c.json({
      comments: page.map((r) => ({ ...publicOf(r), entry: r.entry, status: r.status, email: r.email, ip: r.ip })),
      next: rows.length > limit ? cursorOf(page[page.length - 1]) : null,
    });
  });
  /** 博主发评论（Studio 里用）：直接通过，带“博主”标记，不限流。回复待审的评论时，那条一起通过 */
  admin.post('/comments', async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b !== 'object') return c.json({ error: '请求格式不对' }, 400);
    const entry = clip(b.entry, 200), body = clip(b.body, LIMITS.body), name = clip(b.name, LIMITS.name), mail = clip(b.email, LIMITS.email).toLowerCase();
    const url = cleanUrl(b.url);
    if (!ENTRY.test(entry)) return c.json({ error: 'entry 不合法' }, 400);
    if (!body) return c.json({ error: '评论不能是空的' }, 400);
    if (!name) return c.json({ error: '没有作者名字' }, 400);
    if (url === null) return c.json({ error: '网址格式不对' }, 400);
    let parentId: number | null = null, target: CommentRow | null = null;
    if (b.parentId != null) {
      const p = isInt(b.parentId) ? await store.get(b.parentId) : null;
      if (!p || p.entry !== entry) return c.json({ error: '要回复的评论不存在' }, 400);
      if (p.status === 'pending') await store.setStatus(p.id, 'approved');
      parentId = p.parentId ?? p.id;
      target = p;
    }
    const id = await store.insert({
      entry, block: null, start: null, end: null, quote: null, prefix: null, suffix: null,
      body, name, email: mail || null, avatarHash: mail ? md5(mail) : null, url: url || null, ip: null, author: true, createdAt: now(), status: 'approved', parentId,
    });
    const saved = (await store.get(id))!;
    later(c, notify(saved, clip(b.title, 200) || undefined, target, false));
    return c.json({ comment: publicOf(saved) }, 201);
  });
  /** 邮件提醒的设置：密码、Key 只进不出；留空表示不改 */
  admin.get('/mail', async (c) => c.json({ mail: publicMail(await mailSettings()) }));
  admin.put('/mail', async (c) => {
    const b = await c.req.json().catch(() => null);
    let m;
    try { m = cleanMail(b?.mail, await mailSettings()); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
    await store.setSetting('mail', JSON.stringify(m));
    return c.json({ mail: publicMail(m) });
  });
  /** 按已保存的设置给博主的邮箱发一封测试信，失败就把原因带回去 */
  admin.post('/mail/test', async (c) => {
    const m = await mailSettings();
    if (m.provider === 'off') return c.json({ error: '邮件提醒没有打开' }, 400);
    if (!m.to) return c.json({ error: '还没有填收件邮箱' }, 400);
    if (!opts.sendMail) return c.json({ error: '这个评论服务不能发邮件' }, 501);
    try { await opts.sendMail(m, testMail(m)); } catch (e) { return c.json({ error: `发送失败：${(e as Error).message}` }, 502); }
    return c.json({ ok: true });
  });
  /** 管理设置：防垃圾规则 */
  admin.get('/settings', async (c) => c.json({ spam: await spamRules() }));
  admin.put('/settings', async (c) => {
    const b = await c.req.json().catch(() => null);
    let spam: SpamRules;
    try { spam = cleanRules(b?.spam); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
    await store.setSetting('spam', JSON.stringify(spam));
    return c.json({ spam });
  });
  /** 各状态数量；带 ?since= 时多一个 since：那之后读者发的评论数（Studio 的“未读”） */
  admin.get('/stats', async (c) => {
    const since = timeParam(c.req.query('since'));
    return c.json({ ...(await store.countByStatus()), ...(since === undefined ? {} : { since: await store.countSince(since) }) });
  });
  admin.get('/traffic', async (c) => {
    // 每篇的阅读量和点赞数：有人赞、还没人读过（数据是旧的）的也列上
    const likes = new Map((await store.listLikes()).map((e) => [e.entry, e.likes]));
    const entries = (await store.listViews()).map((e) => ({ ...e, likes: likes.get(e.entry) ?? 0 }));
    for (const [entry, n] of likes) if (!entries.some((e) => e.entry === entry)) entries.push({ entry, views: 0, likes: n });
    return c.json({ views: entries.reduce((a, e) => a + e.views, 0), likes: entries.reduce((a, e) => a + e.likes, 0), online: await online(), entries });
  });
  admin.patch('/comments/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const { status } = await c.req.json().catch(() => ({}));
    if (!Number.isInteger(id) || !['pending', 'approved', 'hidden', 'spam'].includes(status)) return c.json({ error: '参数不对' }, 400);
    const before = Number.isInteger(id) ? await store.get(id) : null;
    if (!before || !(await store.setStatus(id, status))) return c.json({ error: '没有这条评论' }, 404);
    // 待审的回复被通过了：这时才提醒被回复的读者（只知道挂在哪一条下面）
    if (before.status === 'pending' && status === 'approved' && before.parentId) later(c, notify({ ...before, status }, undefined, await store.get(before.parentId), false));
    return c.json({ ok: true });
  });
  admin.delete('/comments/:id', async (c) => {
    const id = Number(c.req.param('id'));
    return Number.isInteger(id) && (await store.remove(id)) ? c.json({ ok: true }) : c.json({ error: '没有这条评论' }, 404);
  });
  admin.delete('/spam', async (c) => c.json({ ok: true, removed: await store.clearSpam() }));
  app.route('/admin', admin);

  return app;
}

/** 客户端 IP：Cloudflare 和常见反向代理的头，其次是 Node 的连接地址 */
function ipOf(c: any): string {
  return ipFrom((k) => c.req.header(k), c.env?.incoming?.socket?.remoteAddress);
}
export const ipFrom = (header: (k: string) => string | null | undefined, remote?: string) =>
  header('cf-connecting-ip') ?? header('x-forwarded-for')?.split(',')[0].trim() ?? remote ?? '';

async function verifyTurnstile(doFetch: typeof fetch, secret: string, token: string, ip: string) {
  if (!token) return false;
  try {
    const form = new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) });
    const r = await doFetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    return !!((await r.json()) as any).success;
  } catch { return false; }
}

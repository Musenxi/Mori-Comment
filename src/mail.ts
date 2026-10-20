/**
 * 邮件提醒（Studio 的“设定 → 评论 → 邮件提醒”里填，存在 settings 表的 mail 里）：
 *  - 有新评论时提醒博主（垃圾箱里的不提醒）
 *  - 有人回复时提醒被回复的读者
 * 发信方式：SMTP（只有 Node 版能用）、Resend（HTTP）、Cloudflare Email Service（Workers 里用 send_email 绑定，别处用 REST 接口）。
 * 密码、API Key 这些只进不出：读设置时只告诉有没有填。
 */
import { parseComment, type MdNode } from './comment-md.mjs';
export type Provider = 'off' | 'smtp' | 'resend' | 'cloudflare';

export interface MailSettings {
  provider: Provider;
  fromName: string;
  fromEmail: string;
  /** 博主收提醒的邮箱 */
  to: string;
  /** 有新评论时提醒博主 */
  notifyAuthor: boolean;
  /** 有人回复时提醒读者 */
  notifyReply: boolean;
  /** 站点地址，邮件里的文章链接用；空的就不带链接 */
  site: string;
  /** 主题色（#rrggbb），邮件里的链接用；Studio 保存时从站点配置带过来 */
  accent: string;
  smtp: { host: string; port: number; user: string; pass: string };
  resend: { apiKey: string };
  cloudflare: { accountId: string; apiToken: string };
}

export const NO_MAIL: MailSettings = {
  provider: 'off', fromName: '', fromEmail: '', to: '', notifyAuthor: true, notifyReply: true, site: '', accent: '',
  smtp: { host: '', port: 465, user: '', pass: '' }, resend: { apiKey: '' }, cloudflare: { accountId: '', apiToken: '' },
};

export interface Mail { to: string; subject: string; text: string; html: string }
/** 真正发一封信；各个运行环境自己实现（见 node.ts、worker.ts），失败就抛错 */
export type SendMail = (settings: MailSettings, mail: Mail) => Promise<void>;

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** 读出来的旧设置（坏了就当没有） */
export function readMail(json: string | null): MailSettings {
  try { const v = JSON.parse(json ?? 'null'); return v ? { ...NO_MAIL, ...v, smtp: { ...NO_MAIL.smtp, ...v.smtp }, resend: { ...NO_MAIL.resend, ...v.resend }, cloudflare: { ...NO_MAIL.cloudflare, ...v.cloudflare } } : NO_MAIL; } catch { return NO_MAIL; }
}

/** 整理 Studio 送来的设置；密码、Key 留空表示不改（沿用 prev 里的）。写错了抛出原因 */
export function cleanMail(v: any, prev: MailSettings): MailSettings {
  const provider: Provider = ['off', 'smtp', 'resend', 'cloudflare'].includes(v?.provider) ? v.provider : 'off';
  const keep = (x: unknown, old: string) => str(x, 500) || old;
  const m: MailSettings = {
    provider,
    fromName: str(v?.fromName, 80),
    fromEmail: str(v?.fromEmail, 120),
    to: str(v?.to, 120),
    notifyAuthor: v?.notifyAuthor !== false,
    notifyReply: v?.notifyReply !== false,
    site: str(v?.site, 200).replace(/\/+$/, ''),
    accent: /^#[0-9a-f]{6}$/i.test(str(v?.accent)) ? str(v?.accent).toLowerCase() : prev.accent,
    smtp: { host: str(v?.smtp?.host, 200), port: Number(v?.smtp?.port) || 465, user: str(v?.smtp?.user, 200), pass: keep(v?.smtp?.pass, prev.smtp.pass) },
    resend: { apiKey: keep(v?.resend?.apiKey, prev.resend.apiKey) },
    cloudflare: { accountId: str(v?.cloudflare?.accountId, 64), apiToken: keep(v?.cloudflare?.apiToken, prev.cloudflare.apiToken) },
  };
  if (m.site && !/^https?:\/\/[^\s]+$/i.test(m.site)) throw new Error('站点地址要以 http:// 或 https:// 开头');
  if (provider === 'off') return m;
  if (!EMAIL.test(m.fromEmail)) throw new Error('发件邮箱格式不对');
  if (m.to && !EMAIL.test(m.to)) throw new Error('收件邮箱格式不对');
  if (provider === 'smtp' && (!m.smtp.host || !m.smtp.user || !m.smtp.pass)) throw new Error('SMTP 要填服务器、用户名和密码');
  if (provider === 'smtp' && !(m.smtp.port > 0 && m.smtp.port < 65536)) throw new Error('SMTP 端口不对');
  if (provider === 'resend' && !m.resend.apiKey) throw new Error('Resend 要填 API Key');
  return m;
}

/** 给 Studio 看的设置：密码、Key 换成“有没有填” */
export function publicMail(m: MailSettings) {
  return {
    ...m,
    smtp: { ...m.smtp, pass: '', hasPass: !!m.smtp.pass },
    resend: { apiKey: '', hasKey: !!m.resend.apiKey },
    cloudflare: { ...m.cloudflare, apiToken: '', hasToken: !!m.cloudflare.apiToken },
  };
}

/* ───────────── 信的内容 ─────────────
   邮件客户端只认得老式 HTML：表格排版、全部行内样式。白底、灰黑字，链接用主题色。 */

const C = { paper: '#ffffff', line: '#dcdcdc', ink: '#111111', soft: '#666666', muted: '#8c8c8c', code: '#f4f4f4' };
const SANS = `-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Arial,sans-serif`;
const MONO = `Menlo,Consolas,'SF Mono',monospace`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/* ───────────── 表情：站点构建时导出 /emoji.json（{ "包名_表情名": 图片地址 }），邮件里按它换成图片 ───────────── */

const EMOJI_TTL = 10 * 60_000, EMOJI_RETRY = 60_000;
const emojiCache = new Map<string, { at: number; ttl: number; map: Record<string, string> }>();

/** 取站点的表情清单并缓存（10 分钟）。站点没开、没有这个文件、超时都当没有，邮件里表情照原样写成文字；返回这次的结果，force 时不看缓存 */
export async function loadEmoji(site: string, fetcher: typeof fetch = fetch, force = false): Promise<{ ok: boolean; count: number; error?: string }> {
  if (!site) return { ok: false, count: 0, error: '没有填站点地址' };
  const hit = emojiCache.get(site);
  if (!force && hit && Date.now() - hit.at < hit.ttl) return { ok: !!Object.keys(hit.map).length, count: Object.keys(hit.map).length };
  let map: Record<string, string> = {}, error: string | undefined;
  try {
    const r = await fetcher(`${site}/emoji.json`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) error = `${site}/emoji.json 返回 ${r.status}`;
    else {
      const j = (await r.json()) as unknown;
      if (j && typeof j === 'object' && !Array.isArray(j)) for (const [k, v] of Object.entries(j)) if (typeof v === 'string') map[k] = v;
      if (!Object.keys(map).length) error = '清单是空的或格式不对';
    }
  } catch (e) { map = {}; error = (e as Error).message || String(e); }
  if (error) console.warn(`表情清单没取到：${error}`);
  emojiCache.set(site, { at: Date.now(), ttl: Object.keys(map).length ? EMOJI_TTL : EMOJI_RETRY, map });
  return { ok: !error, count: Object.keys(map).length, error };
}

/** 清单里挑一个表情给测试邮件用 */
export const sampleEmoji = (site: string) => { const k = Object.keys(emojiCache.get(site)?.map ?? {}); return k.find((x) => x.endsWith('_1huaji')) ?? k[0]; };

/** 清单给的地址：绝对的 http / https 照用，站内路径接在站点地址后面；别的一律不要 */
const emojiUrl = (m: MailSettings, name: string) => {
  const u = emojiCache.get(m.site)?.map[name];
  if (!u) return undefined;
  const enc = (x: string) => { try { return encodeURI(decodeURI(x)); } catch { return encodeURI(x); } };
  const abs = /^https?:\/\//i.test(u) ? u : u.startsWith('/') ? `${m.site}${enc(u)}` : '';
  return /^https?:\/\/[^\s]+$/i.test(abs) ? abs : undefined;
};

/** 测试用：直接放一份清单 */
export const setEmoji = (site: string, map: Record<string, string>) => { emojiCache.set(site, { at: Date.now(), ttl: EMOJI_TTL, map }); };

const accentOf = (m: MailSettings) => (/^#[0-9a-f]{6}$/i.test(m.accent) ? m.accent : '#002fa7');
/** 文章在 /posts/…/，独立页面（entry 是 pages/…）直接在 /…/ */
const link = (m: MailSettings, entry: string, id?: number) => (m.site ? `${m.site}/${entry.replace(/^pages\//, '')}/${id ? `#c${id}` : ''}` : '');
const page = (title: string | undefined, entry: string) => (title ? `《${title}》` : entry);

/** 评论正文：Markdown 节点 → 带行内样式的 HTML（文字全部转义，链接只有 http / https） */
function md(m: MailSettings, nodes: MdNode[]): string {
  const a = accentOf(m);
  const kids = (n: MdNode) => md(m, n.children ?? []);
  const items = (n: MdNode) => (n.items ?? []).map((it) => `<li style="margin:2px 0">${md(m, it)}</li>`).join('');
  return nodes.map((n, i) => {
    const top = i ? 'margin:12px 0 0' : 'margin:0';
    switch (n.type) {
      case 'text': return esc(n.text ?? '');
      case 'br': return '<br>';
      case 'emoji': {
        const u = emojiUrl(m, n.name ?? '');
        return u ? `<img src="${esc(u)}" alt="${esc(`:[${n.name}]`)}" title="${esc(n.name ?? '')}" height="36" style="height:36px;width:auto;vertical-align:middle;border:0;margin:0 2px">` : esc(`:[${n.name}]`);
      }
      case 'b': return `<strong style="font-weight:600">${kids(n)}</strong>`;
      case 'i': return `<em>${kids(n)}</em>`;
      case 'del': return `<del style="color:${C.muted}">${kids(n)}</del>`;
      case 'code': return `<code style="font-family:${MONO};font-size:13px;line-height:1.5;background:${C.code};padding:1px 5px;border-radius:3px">${esc(n.text ?? '')}</code>`;
      case 'a': return `<a href="${esc(n.href ?? '')}" style="color:${a};text-decoration:none">${kids(n)}</a>`;
      case 'pre': return `<pre style="${top};padding:10px 14px;background:${C.code};border-radius:6px;font-family:${MONO};font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-all">${esc(n.text ?? '')}</pre>`;
      case 'quote': return `<blockquote style="${top};padding:0 0 0 12px;border-left:2px solid ${C.line};color:${C.soft}">${kids(n)}</blockquote>`;
      case 'ul': return `<ul style="${top};padding-left:1.4em">${items(n)}</ul>`;
      case 'ol': return `<ol start="${n.start ?? 1}" style="${top};padding-left:1.4em">${items(n)}</ol>`;
      default: return `<p style="${top}">${kids(n)}</p>`;
    }
  }).join('');
}
const body = (m: MailSettings, text: string, color = C.ink) => `<div style="color:${color};word-break:break-word">${md(m, parseComment(text))}</div>`;

/** 整封信：杂志封面式。粗黑线、超大标题、页眉页脚用小号大写字母；只有一块主题色 */
function layout(m: MailSettings, o: { heading: string; content: string; link?: { href: string; label: string }; no?: number; where?: string }) {
  const a = accentOf(m), site = esc((m.fromName || 'BLOG').toUpperCase());
  const brand = m.site ? `<a href="${esc(m.site)}" style="color:${C.ink};text-decoration:none">${site}</a>` : site;
  const label = esc(m.fromName || (m.site ? m.site.replace(/^https?:\/\//, '') : '博客'));
  const name = m.site ? `<a href="${esc(m.site)}" style="color:${C.ink};text-decoration:none">${label}</a>` : label;
  const small = `font-family:${SANS};font-size:11px;line-height:1.6;font-weight:600;letter-spacing:.22em;text-transform:uppercase`;
  const no = o.no ? `NO.&nbsp;${String(o.no).padStart(3, '0')}` : '';
  const where = o.where ? `<tr><td style="padding:0 0 22px;font-family:${SANS};font-size:13px;line-height:1.7;color:${C.soft};border-bottom:1px solid ${C.ink}">${o.where}</td></tr><tr><td style="height:26px;line-height:26px">&nbsp;</td></tr>` : '';
  const btn = o.link ? `<tr><td style="padding:30px 0 0"><a href="${esc(o.link.href)}" style="display:block;background:${C.ink};color:#ffffff;text-decoration:none;padding:16px 22px;${small}">${esc(o.link.label)}<span style="float:right;color:${a}">&rarr;</span></a></td></tr>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
<body style="margin:0;padding:0;background:${C.paper}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.paper}"><tr><td align="center" style="padding:20px 14px 44px">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px;max-width:100%;background:#ffffff;border-top:8px solid ${C.ink}">
<tr><td style="padding:18px 32px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:0 0 46px;${small};color:${C.ink}">${brand}</td><td align="right" style="padding:0 0 46px;${small};color:${a}">${no}</td></tr>
<tr><td colspan="2" style="padding:0 0 30px;font-family:${SANS};font-size:38px;line-height:1.18;font-weight:800;letter-spacing:-.01em;color:${C.ink}">${o.heading}</td></tr>
<tr><td colspan="2"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${where}<tr><td>${o.content}</td></tr>${btn}</table></td></tr>
<tr><td colspan="2" style="padding:40px 0 26px"><div style="border-top:1px solid ${C.ink};padding-top:12px;font-family:${SANS};font-size:13px;line-height:1.7;color:${C.muted}">此邮件由 ${name} 自动发送，请勿直接回复。</div></td></tr>
</table>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

/** 一段话：名字用小号大写，正文放大，左侧一道粗线；quiet 的是被回复的那条，退后一档 */
function said(m: MailSettings, who: string, text: string, quiet = false) {
  const border = quiet ? C.line : C.ink;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px"><tr><td style="border-left:${quiet ? 2 : 4}px solid ${border};padding:2px 0 2px 18px">
<div style="font-family:${SANS};font-size:11px;line-height:1.6;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:${quiet ? C.muted : C.ink};padding:0 0 8px">${who}</div>
<div style="font-family:${SANS};font-size:${quiet ? 14 : 18}px;line-height:1.85;color:${quiet ? C.soft : C.ink}">${body(m, text, quiet ? C.soft : C.ink)}</div>
</td></tr></table>`;
}

export interface MailComment { id: number; entry: string; name: string; email: string | null; url: string | null; ip: string | null; body: string; status: string }

/** 有新评论：给博主 */
export function authorMail(m: MailSettings, c: MailComment, title?: string): Mail {
  const pending = c.status === 'pending';
  // 待审的评论在页面上还没有，链接只到文章
  const where = page(title, c.entry), url = link(m, c.entry, pending ? undefined : c.id);
  const who = [c.name, c.email, c.url, c.ip].filter(Boolean).join(' · ');
  const info = [c.email && `<a href="mailto:${esc(c.email)}" style="color:${C.muted};text-decoration:none">${esc(c.email)}</a>`, c.url && esc(c.url), c.ip && esc(c.ip)].filter(Boolean).join(' &middot; ');
  return {
    to: m.to,
    subject: `${where}有新评论${pending ? '（待审）' : ''}：${c.name}`,
    text: `${who}\n\n${c.body}\n${url ? `\n${url}\n` : ''}`,
    html: layout(m, {
      heading: pending ? '新评论<br>待审' : '新评论',
      no: c.id, where: esc(where),
      content: said(m, `${esc(c.name)}${info ? `<span style="font-weight:400;letter-spacing:.04em;text-transform:none;color:${C.muted}">&nbsp;&nbsp;${info}</span>` : ''}`, c.body),
      link: url ? { href: url, label: pending ? '打开文章' : '查看评论' } : undefined,
    }),
  };
}

/** 有人回复：给被回复的读者 */
export function replyMail(m: MailSettings, to: string, parent: { name: string; body: string }, reply: MailComment, title?: string): Mail {
  const where = page(title, reply.entry), url = link(m, reply.entry, reply.id), from = m.fromName || '博客';
  return {
    to,
    subject: `${reply.name} 回复了你在${where}的评论`,
    text: `${parent.name}，你的评论：\n${parent.body}\n\n${reply.name} 的回复：\n${reply.body}\n${url ? `\n${url}\n` : ''}\n—— ${from}\n`,
    html: layout(m, {
      heading: '有人<br>回复了你', no: reply.id, where: esc(where),
      content: said(m, '你的评论', parent.body, true) + said(m, esc(reply.name), reply.body),
      link: url ? { href: url, label: '查看回复' } : undefined,
    }),
  };
}

export function testMail(m: MailSettings, emoji?: { ok: boolean; count: number; error?: string }): Mail {
  const key = emoji?.ok ? sampleEmoji(m.site) : undefined;
  const line = emoji ? (emoji.ok ? `表情清单：取到 ${emoji.count} 个${key ? `，下面是 :[${key}]` : ''}` : `表情清单：没取到（${emoji.error ?? '原因不明'}）`) : '';
  const demo = key ? `<div style="font-size:18px;line-height:2">${md(m, parseComment(`:[${key}]`))}</div>` : '';
  return {
    to: m.to, subject: '评论服务的测试邮件', text: `能收到这封信，邮件提醒就设置好了。\n${line ? `${line}\n` : ''}`,
    html: layout(m, { heading: '邮件提醒<br>设置好了', content: `<div style="font-family:${SANS};font-size:18px;line-height:1.85;color:${C.ink}">能收到这封信，提醒就能发出来。</div>${line ? `<div style="font-family:${SANS};font-size:13px;line-height:1.7;color:${C.muted};margin-top:12px">${esc(line)}</div>${demo}` : ''}` }),
  };
}

/* ───────────── HTTP 发信：Resend、Cloudflare REST（Node 和 Workers 都能用） ───────────── */

const fromLine = (m: MailSettings) => (m.fromName ? `${m.fromName.replace(/[<>"]/g, '')} <${m.fromEmail}>` : m.fromEmail);

export async function sendHttp(m: MailSettings, mail: Mail, doFetch: typeof fetch = fetch): Promise<void> {
  if (m.provider === 'resend') {
    const r = await doFetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${m.resend.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromLine(m), to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
    });
    if (!r.ok) throw new Error(`Resend 返回 ${r.status}：${(await r.text()).slice(0, 300)}`);
    return;
  }
  if (m.provider === 'cloudflare') {
    if (!m.cloudflare.accountId || !m.cloudflare.apiToken) throw new Error('Cloudflare 要填账号 ID 和 API 令牌（Workers 版绑了 send_email 就不用填）');
    const r = await doFetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(m.cloudflare.accountId)}/email/sending/send`, {
      method: 'POST', headers: { Authorization: `Bearer ${m.cloudflare.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: m.fromEmail, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html }),
    });
    const j: any = await r.json().catch(() => null);
    if (!r.ok || !j?.success) throw new Error(`Cloudflare 返回 ${r.status}：${j?.errors?.map((e: any) => e.message).join('；') || '发送失败'}`);
    return;
  }
  throw new Error(m.provider === 'smtp' ? 'Workers 版不能用 SMTP，请换成 Resend 或 Cloudflare' : '邮件提醒没有打开');
}

/** Workers 的 send_email 绑定（Cloudflare Email Service） */
export interface EmailBinding { send(msg: { from: string | { email: string; name?: string }; to: string; subject: string; text?: string; html?: string }): Promise<unknown> }

export async function sendBinding(binding: EmailBinding, m: MailSettings, mail: Mail) {
  await binding.send({ from: m.fromName ? { email: m.fromEmail, name: m.fromName } : m.fromEmail, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
}

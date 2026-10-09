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
   邮件客户端只认得老式 HTML：表格排版、全部行内样式。颜色照站点的纸、墨、细线，链接用主题色。 */

const C = { paper: '#f3f0e9', card: '#fffdf8', line: '#e4ded2', ink: '#1d1b18', soft: '#55504a', muted: '#8a8378', code: '#f1ede4' };
const SERIF = `'Songti SC','STSong','Noto Serif SC','Source Han Serif SC',Georgia,serif`;
const SANS = `-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Arial,sans-serif`;
const MONO = `Menlo,Consolas,'SF Mono',monospace`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const accentOf = (m: MailSettings) => (/^#[0-9a-f]{6}$/i.test(m.accent) ? m.accent : '#002fa7');
const link = (m: MailSettings, entry: string, id?: number) => (m.site ? `${m.site}/${entry}/${id ? `#c${id}` : ''}` : '');
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
      case 'b': return `<strong style="font-weight:600">${kids(n)}</strong>`;
      case 'i': return `<em>${kids(n)}</em>`;
      case 'del': return `<del style="color:${C.muted}">${kids(n)}</del>`;
      case 'code': return `<code style="font:13px/1.5 ${MONO};background:${C.code};padding:1px 5px;border-radius:3px">${esc(n.text ?? '')}</code>`;
      case 'a': return `<a href="${esc(n.href ?? '')}" style="color:${a};text-decoration:none">${kids(n)}</a>`;
      case 'pre': return `<pre style="${top};padding:10px 14px;background:${C.code};border-radius:6px;font:13px/1.6 ${MONO};white-space:pre-wrap;word-break:break-all">${esc(n.text ?? '')}</pre>`;
      case 'quote': return `<blockquote style="${top};padding:0 0 0 12px;border-left:2px solid ${C.line};color:${C.soft}">${kids(n)}</blockquote>`;
      case 'ul': return `<ul style="${top};padding-left:1.4em">${items(n)}</ul>`;
      case 'ol': return `<ol start="${n.start ?? 1}" style="${top};padding-left:1.4em">${items(n)}</ol>`;
      default: return `<p style="${top}">${kids(n)}</p>`;
    }
  }).join('');
}
const body = (m: MailSettings, text: string, color = C.ink) => `<div style="font:15px/1.8 ${SANS};color:${color};word-break:break-word">${md(m, parseComment(text))}</div>`;

/** 整封信：纸色底，上面一行站名，下面一张卡片 */
function layout(m: MailSettings, o: { kicker: string; heading: string; content: string; action?: { href: string; label: string } }) {
  const a = accentOf(m), site = esc(m.fromName || '');
  const brand = m.site ? `<a href="${esc(m.site)}" style="color:${C.soft};text-decoration:none">${site}</a>` : site;
  const action = o.action ? `<tr><td style="padding:22px 0 0;font:14px/1.6 ${SANS}"><a href="${esc(o.action.href)}" style="color:${a};text-decoration:none;font-weight:500">${esc(o.action.label)} &rarr;</a></td></tr>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
<body style="margin:0;padding:0;background:${C.paper}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.paper}"><tr><td align="center" style="padding:36px 16px 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
<tr><td style="padding:0 6px 14px;font:13px/1.6 ${SERIF};letter-spacing:.16em;color:${C.soft}">${brand}</td></tr>
<tr><td style="background:${C.card};border:1px solid ${C.line};border-radius:14px;padding:30px 30px 28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:0 0 6px;font:12px/1.6 ${SANS};letter-spacing:.08em;color:${C.muted}">${o.kicker}</td></tr>
<tr><td style="padding:0 0 20px;font:21px/1.5 ${SERIF};color:${C.ink};letter-spacing:.02em">${o.heading}</td></tr>
<tr><td>${o.content}</td></tr>
${action}
</table>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

/** 一条评论：名字（博主发的带标记）、一行附属信息、正文 */
function comment(m: MailSettings, c: { name: string; body: string }, meta: string[], dim = false) {
  const info = meta.filter(Boolean).map(esc).join(' &middot; ');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${dim ? ` style="border-left:2px solid ${C.line}"` : ''}><tr><td style="${dim ? 'padding:0 0 0 14px' : ''}">
<div style="font:600 14px/1.6 ${SANS};color:${dim ? C.soft : C.ink}">${esc(c.name)}${info ? `<span style="font-weight:400;color:${C.muted}">&nbsp;&nbsp;${info}</span>` : ''}</div>
<div style="padding-top:6px">${body(m, c.body, dim ? C.soft : C.ink)}</div>
</td></tr></table>`;
}

export interface MailComment { id: number; entry: string; name: string; email: string | null; url: string | null; ip: string | null; body: string; status: string }

/** 有新评论：给博主 */
export function authorMail(m: MailSettings, c: MailComment, title?: string): Mail {
  const pending = c.status === 'pending';
  // 待审的评论在页面上还没有，链接只到文章
  const where = page(title, c.entry), url = link(m, c.entry, pending ? undefined : c.id);
  const who = [c.name, c.email, c.url, c.ip].filter(Boolean).join(' · ');
  const heading = url ? `<a href="${esc(url)}" style="color:${C.ink};text-decoration:none">${esc(where)}</a>` : esc(where);
  return {
    to: m.to,
    subject: `${where}有新评论${pending ? '（待审）' : ''}：${c.name}`,
    text: `${who}\n\n${c.body}\n${url ? `\n${url}\n` : ''}`,
    html: layout(m, {
      kicker: pending ? '新评论 · 待审' : '新评论',
      heading,
      content: comment(m, c, [c.email ?? '', c.url ?? '', c.ip ?? '']),
      action: url ? { href: url, label: pending ? '打开文章' : '查看评论' } : undefined,
    }),
  };
}

/** 有人回复：给被回复的读者 */
export function replyMail(m: MailSettings, to: string, parent: { name: string; body: string }, reply: MailComment, title?: string): Mail {
  const where = page(title, reply.entry), url = link(m, reply.entry, reply.id), from = m.fromName || '博客';
  const heading = `${esc(reply.name)} 回复了你`;
  return {
    to,
    subject: `${reply.name} 回复了你在${where}的评论`,
    text: `${parent.name}，你的评论：\n${parent.body}\n\n${reply.name} 的回复：\n${reply.body}\n${url ? `\n${url}\n` : ''}\n—— ${from}\n`,
    html: layout(m, {
      kicker: url ? `<a href="${esc(url)}" style="color:${C.muted};text-decoration:none">${esc(where)}</a>` : esc(where),
      heading,
      content: comment(m, parent, ['你的评论'], true) + `<div style="height:20px;line-height:20px">&nbsp;</div>` + comment(m, reply, []),
      action: url ? { href: url, label: '查看回复' } : undefined,
    }),
  };
}

export function testMail(m: MailSettings): Mail {
  return {
    to: m.to, subject: '评论服务的测试邮件', text: '能收到这封信，邮件提醒就设置好了。\n',
    html: layout(m, { kicker: '测试', heading: '邮件提醒设置好了', content: `<div style="font:15px/1.8 ${SANS};color:${C.ink}">能收到这封信，提醒就能发出来。</div>` }),
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

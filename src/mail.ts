/**
 * 邮件提醒（Studio 的“设定 → 评论 → 邮件提醒”里填，存在 settings 表的 mail 里）：
 *  - 有新评论时提醒博主（垃圾箱里的不提醒）
 *  - 有人回复时提醒被回复的读者
 * 发信方式：SMTP（只有 Node 版能用）、Resend（HTTP）、Cloudflare Email Service（Workers 里用 send_email 绑定，别处用 REST 接口）。
 * 密码、API Key 这些只进不出：读设置时只告诉有没有填。
 */
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
  smtp: { host: string; port: number; user: string; pass: string };
  resend: { apiKey: string };
  cloudflare: { accountId: string; apiToken: string };
}

export const NO_MAIL: MailSettings = {
  provider: 'off', fromName: '', fromEmail: '', to: '', notifyAuthor: true, notifyReply: true, site: '',
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

/* ───────────── 信的内容 ───────────── */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const link = (m: MailSettings, entry: string, id: number) => (m.site ? `${m.site}/${entry}/#c${id}` : '');
const page = (title: string | undefined, entry: string) => (title ? `《${title}》` : entry);
/** 正文是 Markdown 原文，信里原样放进去（纯文字；HTML 里转义、保留换行） */
const block = (s: string) => `<div style="white-space:pre-wrap;padding:10px 14px;background:#f4f4f2;border-radius:6px;line-height:1.7">${esc(s)}</div>`;
const html = (lines: string[]) => `<div style="font:15px/1.7 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1b1b19;max-width:560px">${lines.join('')}</div>`;

export interface MailComment { id: number; entry: string; name: string; email: string | null; url: string | null; ip: string | null; body: string; status: string }

/** 有新评论：给博主 */
export function authorMail(m: MailSettings, c: MailComment, title?: string): Mail {
  const where = page(title, c.entry), url = link(m, c.entry, c.id), state = c.status === 'pending' ? '（待审）' : '';
  const who = [c.name, c.email, c.url, c.ip].filter(Boolean).join(' · ');
  return {
    to: m.to,
    subject: `${where}有新评论${state}：${c.name}`,
    text: `${who}\n\n${c.body}\n${url ? `\n${url}\n` : ''}`,
    html: html([`<p style="color:#6b6b66">${esc(who)}${state ? ` <b>${state}</b>` : ''}</p>`, block(c.body), url ? `<p><a href="${esc(url)}">${esc(where)}</a></p>` : `<p>${esc(where)}</p>`]),
  };
}

/** 有人回复：给被回复的读者 */
export function replyMail(m: MailSettings, to: string, parent: { name: string; body: string }, reply: MailComment, title?: string): Mail {
  const where = page(title, reply.entry), url = link(m, reply.entry, reply.id), from = m.fromName || '博客';
  return {
    to,
    subject: `${reply.name} 回复了你在${where}的评论`,
    text: `${parent.name}，你的评论：\n${parent.body}\n\n${reply.name} 的回复：\n${reply.body}\n${url ? `\n${url}\n` : ''}\n—— ${from}\n`,
    html: html([`<p>${esc(parent.name)}，你在${esc(where)}的评论：</p>`, block(parent.body), `<p>${esc(reply.name)} 的回复：</p>`, block(reply.body), url ? `<p><a href="${esc(url)}">去看看</a></p>` : '', `<p style="color:#6b6b66">—— ${esc(from)}</p>`]),
  };
}

export function testMail(m: MailSettings): Mail {
  return { to: m.to, subject: '评论服务的测试邮件', text: '能收到这封信，邮件提醒就设置好了。\n', html: html(['<p>能收到这封信，邮件提醒就设置好了。</p>']) };
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

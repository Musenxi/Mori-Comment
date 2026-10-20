import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sqliteStore } from '../src/sqlite.ts';
import { loadEmoji, setEmoji, type Mail, type MailSettings } from '../src/mail.ts';

const ENTRY = 'posts/hello';
const SITE = 'https://blog.example.com';
// 默认没有表情清单（别让测试去真的连网）；要用的测试自己放一份
setEmoji(SITE, {});
const tick = () => new Promise((r) => setTimeout(r, 20));

async function setup(fail = false, autoApprove: 'all' | 'none' = 'all', siteFetch?: typeof fetch) {
  const store = sqliteStore(':memory:');
  await store.init();
  const sent: Array<{ m: MailSettings; mail: Mail }> = [];
  const app = createApp({ store, adminToken: 't', autoApprove, siteFetch, sendMail: async (m, mail) => { if (fail) throw new Error('连不上'); sent.push({ m, mail }); } });
  let ip = 0;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': `10.0.0.${++ip}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const admin = (method: string, path: string, body?: unknown) => call(method, `/admin${path}`, body, { Authorization: 'Bearer t' });
  const post = async (body: Record<string, unknown>) => (await call('POST', '/comments', { entry: ENTRY, name: '读者', email: 'reader@example.com', body: '写得好', ...body })).json() as Promise<any>;
  const on = (extra: Record<string, unknown> = {}) => admin('PUT', '/mail', { mail: { provider: 'resend', fromName: '夜庭記', fromEmail: 'noreply@example.com', to: 'me@example.com', site: 'https://blog.example.com/', resend: { apiKey: 're_secret' }, ...extra } });
  return { sent, call, admin, post, on };
}

test('设置：密码和 Key 只进不出，留空不改；写错了 400', async () => {
  const { admin, on } = await setup();
  const r: any = await (await on()).json();
  assert.equal(r.mail.resend.apiKey, '');
  assert.equal(r.mail.resend.hasKey, true);
  assert.equal(r.mail.site, 'https://blog.example.com');
  const again: any = await (await on({ resend: { apiKey: '' }, fromName: '新名字' })).json();
  assert.equal(again.mail.resend.hasKey, true);
  assert.equal(again.mail.fromName, '新名字');
  assert.equal((await admin('PUT', '/mail', { mail: { provider: 'smtp', fromEmail: 'a@b.cc', smtp: { host: 'smtp.qq.com' } } })).status, 400);
  assert.equal((await admin('PUT', '/mail', { mail: { provider: 'resend', fromEmail: '坏的', resend: { apiKey: 'x' } } })).status, 400);
  assert.equal((await admin('GET', '/mail')).status, 200);
});

test('新评论提醒博主：带文章名、链接；垃圾箱里的、关掉的不提醒', async () => {
  const { sent, admin, post, on } = await setup();
  await post({ body: '没打开时' });
  await tick();
  assert.equal(sent.length, 0);
  await on();
  const r = await post({ body: '**好**', title: '你好' });
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].mail.to, 'me@example.com');
  assert.match(sent[0].mail.subject, /《你好》有新评论/);
  assert.match(sent[0].mail.text, new RegExp(`https://blog.example.com/posts/hello/#c${r.comment.id}`));
  const pg = await post({ body: '留言', entry: 'pages/guestbook' });
  await tick();
  assert.match(sent[1].mail.text, new RegExp(`https://blog.example.com/guestbook/#c${pg.comment.id}`));
  sent.length = 1;
  await admin('PUT', '/settings', { spam: { words: ['广告'] } });
  await post({ body: '打广告' });
  await tick();
  assert.equal(sent.length, 1);
  await on({ notifyAuthor: false });
  await post({ body: '再一条' });
  await tick();
  assert.equal(sent.length, 1);
});

test('回复提醒读者：读者回复、博主在 Studio 回复、待审的回复被通过时；自己回复自己不提醒', async () => {
  const { sent, admin, post, on } = await setup();
  await on({ notifyAuthor: false });
  const a = await post({ email: 'a@example.com', name: '甲', body: '第一条' });
  await post({ email: 'b@example.com', name: '乙', body: '回甲', parentId: a.comment.id });
  await tick();
  assert.deepEqual(sent.map((s) => s.mail.to), ['a@example.com']);
  assert.match(sent[0].mail.subject, /乙 回复了你/);
  await post({ email: 'a@example.com', name: '甲', body: '自己补一句', parentId: a.comment.id });
  await tick();
  assert.equal(sent.length, 1);
  await admin('POST', '/comments', { entry: ENTRY, body: '谢谢', name: '博主', email: 'me@example.com', parentId: a.comment.id, title: '你好' });
  await tick();
  assert.equal(sent.length, 2);
  assert.match(sent[1].mail.subject, /博主 回复了你在《你好》/);
});

test('先审的回复：提交时不提醒读者，在 Studio 里通过时才提醒', async () => {
  const { sent, admin, post, on } = await setup(false, 'none');
  await on({ notifyAuthor: false });
  const a = await post({ email: 'a@example.com', name: '甲', body: '第一条' });
  const pending: any = ((await (await admin('GET', '/comments?status=pending')).json()) as any).comments[0];
  await admin('PATCH', `/comments/${pending.id}`, { status: 'approved' });
  assert.equal(a.status, 'pending');
  await post({ email: 'b@example.com', name: '乙', body: '回甲', parentId: pending.id });
  await tick();
  assert.equal(sent.length, 0);
  const reply: any = ((await (await admin('GET', '/comments?status=pending')).json()) as any).comments[0];
  await admin('PATCH', `/comments/${reply.id}`, { status: 'approved' });
  await tick();
  assert.deepEqual(sent.map((x) => x.mail.to), ['a@example.com']);
});

test('测试邮件：发到博主邮箱；发不出去把原因带回来', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = real; }
  async function run() {
  const ok = await setup();
  await ok.on();
  assert.equal((await ok.admin('POST', '/mail/test')).status, 200);
  assert.equal(ok.sent[0].mail.to, 'me@example.com');
  const bad = await setup(true);
  await bad.on();
  const r = await bad.admin('POST', '/mail/test');
  assert.equal(r.status, 502);
  assert.match(((await r.json()) as any).error, /连不上/);
  }
});

test('测试邮件：带上表情清单的状态，取到了就放一个示例表情', async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ '蛆音娘_1huaji': '/emoji/蛆音娘/1huaji.png' }))) as typeof fetch;
    const a = await setup();
    await a.on();
    await a.admin('POST', '/mail/test');
    assert.match(a.sent[0].mail.text, /表情清单：取到 1 个/);
    assert.match(a.sent[0].mail.html, /<img src="https:\/\/blog\.example\.com\/emoji\//);
    globalThis.fetch = (async () => new Response('', { status: 403 })) as typeof fetch;
    const b = await setup();
    await b.on();
    await b.admin('POST', '/mail/test');
    assert.match(b.sent[0].mail.text, /表情清单：没取到（https:\/\/blog\.example\.com\/emoji\.json 返回 403）/);
    assert.doesNotMatch(b.sent[0].mail.html, /<img /);
  } finally { globalThis.fetch = real; setEmoji(SITE, {}); }
});

test('表情：邮件里按站点的表情清单换成图片，清单里没有的原样写成文字', async () => {
  setEmoji(SITE, { '蛆音娘_1huaji': '/emoji/蛆音娘/1huaji.png', '外链_x': 'https://cdn.example.com/a%20b.png', '坏_y': 'javascript:alert(1)' });
  try {
    const { sent, post, on } = await setup();
    await on();
    await post({ body: '好:[蛆音娘_1huaji]呀:[外链_x]:[没有_z]:[坏_y]' });
    await tick();
    assert.equal(sent.length, 1);
    const html = sent[0].mail.html;
    assert.match(html, /<img src="https:\/\/blog\.example\.com\/emoji\/%E8%9B%86%E9%9F%B3%E5%A8%98\/1huaji\.png" alt=":\[蛆音娘_1huaji\]"/);
    assert.match(html, /<img src="https:\/\/cdn\.example\.com\/a%20b\.png"/);
    assert.match(html, /:\[没有_z\]/);
    assert.match(html, /:\[坏_y\]/);
    assert.doesNotMatch(html, /javascript:/);
    assert.match(sent[0].mail.text, /:\[蛆音娘_1huaji\]/);
  } finally { setEmoji(SITE, {}); }
});

test('表情清单：取不到或格式不对就当没有；取到的缓存起来', async () => {
  const site = 'https://emoji-test.example.com';
  let n = 0;
  const ok = (async () => { n++; return new Response(JSON.stringify({ 'a_b': '/e/a.png', 'bad': 3 })); }) as typeof fetch;
  await loadEmoji(site, ok);
  await loadEmoji(site, ok);
  assert.equal(n, 1);
  const site2 = 'https://emoji-fail.example.com';
  await loadEmoji(site2, (async () => { throw new Error('超时'); }) as typeof fetch);
  await loadEmoji('https://emoji-404.example.com', (async () => new Response('', { status: 404 })) as typeof fetch);
  await loadEmoji('https://emoji-array.example.com', (async () => new Response('[1,2]')) as typeof fetch);
});

test('表情清单走 siteFetch（服务绑定）：不碰全局 fetch；站点域名挡人机验证时也能取到', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response('', { status: 403, headers: { 'cf-mitigated': 'challenge' } })) as typeof fetch;
  try {
    const viaBinding = (async () => new Response(JSON.stringify({ '蛆音娘_1huaji': '/emoji/蛆音娘/1huaji.png' }))) as typeof fetch;
    const a = await setup(false, 'all', viaBinding);
    await a.on();
    await a.admin('POST', '/mail/test');
    assert.match(a.sent[0].mail.text, /表情清单：取到 1 个/);
    setEmoji(SITE, {});
    const b = await setup();
    await b.on();
    await b.admin('POST', '/mail/test');
    assert.match(b.sent[0].mail.text, /返回 403（challenge）/);
  } finally { globalThis.fetch = real; setEmoji(SITE, {}); }
});

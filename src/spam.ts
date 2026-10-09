/**
 * 防垃圾规则（Studio 的“设定 → 评论”里填，存在 settings 表的 spam 里）。命中任何一条，评论直接拒绝，不存。
 *  - words：屏蔽词，正文或昵称里出现就算（不分大小写）
 *  - ips：屏蔽的 IP 或 IP 段：1.2.3.4、1.2.3.*、1.2.3.0/24、2001:db8::/32
 *  - urls：屏蔽的网址，读者留的网址或正文里的链接含有它就算（如 example.com）
 *  - names：屏蔽的昵称，整个昵称相同才算（不分大小写）
 */
export interface SpamRules { words: string[]; ips: string[]; urls: string[]; names: string[] }

export const NO_RULES: SpamRules = { words: [], ips: [], urls: [], names: [] };
const MAX_ITEMS = 1000, MAX_LEN = 200;

/** 整理成干净的列表：去空白、去空行、去重；IP 写错了抛出那一条 */
export function cleanRules(v: any): SpamRules {
  const list = (x: unknown) => {
    const arr = Array.isArray(x) ? x : typeof x === 'string' ? x.split('\n') : [];
    return [...new Set(arr.map((s) => String(s).trim()).filter((s) => s && s.length <= MAX_LEN))].slice(0, MAX_ITEMS);
  };
  const rules = { words: list(v?.words), ips: list(v?.ips), urls: list(v?.urls), names: list(v?.names) };
  for (const ip of rules.ips) if (!ipRule(ip)) throw new Error(`IP 写法不对：${ip}`);
  return rules;
}

/** 这条评论该不该拦下 */
export function blocked(rules: SpamRules, c: { body: string; name: string; url: string; ip: string | null }): boolean {
  const body = c.body.toLowerCase(), name = c.name.trim().toLowerCase();
  if (rules.words.some((w) => body.includes(w.toLowerCase()) || name.includes(w.toLowerCase()))) return true;
  if (rules.names.some((n) => n.toLowerCase() === name)) return true;
  if (rules.urls.length) {
    const links = [c.url, ...(c.body.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [])].filter(Boolean).map((u) => u.toLowerCase());
    if (rules.urls.some((u) => links.some((l) => l.includes(u.toLowerCase())))) return true;
  }
  if (c.ip && rules.ips.length) {
    const addr = parseIp(c.ip);
    if (addr && rules.ips.some((r) => ipRule(r)?.(addr))) return true;
  }
  return false;
}

/* ───────────── IP ───────────── */

type Addr = { v: 4 | 6; n: bigint };

/** 1.2.3.4 / ::1 / ::ffff:1.2.3.4（Node 收到的 IPv4 常是这种写法，按 IPv4 算） */
export function parseIp(s: string): Addr | null {
  s = s.trim().toLowerCase();
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) s = mapped[1];
  if (s.includes('.')) {
    const p = s.split('.');
    if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
    return { v: 4, n: p.reduce((a, x) => (a << 8n) | BigInt(x), 0n) };
  }
  if (!/^[0-9a-f:]+$/.test(s) || (s.match(/::/g) ?? []).length > 1) return null;
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const hs = head ? head.split(':') : [], ts = tail ? tail.split(':') : [];
  const fill = tail === null ? 0 : 8 - hs.length - ts.length;
  const groups = [...hs, ...Array(Math.max(fill, 0)).fill('0'), ...ts];
  if (groups.length !== 8 || fill < 0 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return { v: 6, n: groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g, 16)), 0n) };
}

/** 一条 IP 规则 → 判断函数；写法不对返回 null */
export function ipRule(rule: string): ((a: Addr) => boolean) | null {
  rule = rule.trim();
  // 1.2.3.* / 1.2.*：把 * 换成 0，前面几段算前缀
  if (/^\d{1,3}(\.(\d{1,3}|\*)){0,3}$/.test(rule) && rule.includes('*')) {
    const parts = rule.split('.');
    const fixed = parts.findIndex((p) => p === '*');
    if (parts.slice(fixed).some((p) => p !== '*')) return null;
    const base = parseIp([...parts.slice(0, fixed), ...Array(4 - fixed).fill('0')].join('.'));
    return base ? prefix(base, fixed * 8) : null;
  }
  const [addr, bits, extra] = rule.split('/');
  if (extra !== undefined) return null;
  const base = parseIp(addr);
  if (!base) return null;
  const max = base.v === 4 ? 32 : 128;
  if (bits === undefined) return prefix(base, max);
  if (!/^\d{1,3}$/.test(bits) || Number(bits) > max) return null;
  return prefix(base, Number(bits));
}

function prefix(base: Addr, bits: number) {
  const size = base.v === 4 ? 32 : 128;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(size - bits);
  return (a: Addr) => a.v === base.v && (a.n & mask) === (base.n & mask);
}

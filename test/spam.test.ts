import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocked, cleanRules, ipRule, parseIp } from '../src/spam.ts';

const hit = (rule: string, ip: string) => ipRule(rule)!(parseIp(ip)!);

test('IP 规则：单个、通配、CIDR、IPv6；::ffff: 开头的按 IPv4 算', () => {
  assert.ok(hit('1.2.3.4', '1.2.3.4'));
  assert.ok(!hit('1.2.3.4', '1.2.3.5'));
  assert.ok(hit('1.2.3.*', '1.2.3.200'));
  assert.ok(hit('1.2.*', '1.2.250.1'));
  assert.ok(!hit('1.2.*', '1.3.0.1'));
  assert.ok(hit('10.0.0.0/8', '10.255.1.2'));
  assert.ok(!hit('10.0.0.0/8', '11.0.0.1'));
  assert.ok(hit('1.2.3.4', '::ffff:1.2.3.4'));
  assert.ok(hit('2001:db8::/32', '2001:db8:1::5'));
  assert.ok(!hit('2001:db8::/32', '2001:db9::5'));
  assert.ok(hit('::1', '0:0:0:0:0:0:0:1'));
  assert.ok(!hit('1.2.3.4', '::1'));
});

test('写错的 IP 规则会被指出来', () => {
  for (const bad of ['1.2.3', '1.2.3.256', '1.*.3.4', '1.2.3.4/33', 'abc', '1::2::3']) assert.equal(ipRule(bad), null, bad);
  assert.throws(() => cleanRules({ ips: ['1.2.3.4', '坏的'] }), /坏的/);
});

test('整理列表：去空白、空行、重复；字符串按行拆', () => {
  assert.deepEqual(cleanRules({ words: ' 广告 \n\n广告\n博彩 ', names: ['甲', ' 甲 '] }), { words: ['广告', '博彩'], ips: [], urls: [], names: ['甲'] });
});

test('拦截：屏蔽词（正文和昵称）、昵称整名、网址（留的网址和正文里的链接）、IP 段', () => {
  const rules = cleanRules({ words: ['代开发票'], names: ['Spam'], urls: ['bad.example'], ips: ['9.9.9.0/24'] });
  const ok = { body: '写得好', name: '读者', url: '', ip: '1.1.1.1' };
  assert.equal(blocked(rules, ok), false);
  assert.equal(blocked(rules, { ...ok, body: '专业代开发票' }), true);
  assert.equal(blocked(rules, { ...ok, name: '代开发票小王' }), true);
  assert.equal(blocked(rules, { ...ok, name: 'spam' }), true);
  assert.equal(blocked(rules, { ...ok, name: 'Spammer' }), false);
  assert.equal(blocked(rules, { ...ok, url: 'https://www.BAD.example/x' }), true);
  assert.equal(blocked(rules, { ...ok, body: '看这里 https://bad.example/p' }), true);
  assert.equal(blocked(rules, { ...ok, ip: '9.9.9.9' }), true);
  assert.equal(blocked(rules, { ...ok, ip: null }), false);
});

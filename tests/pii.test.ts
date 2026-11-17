import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeUrl, maskPII } from '../src/pii.ts';

test('masks Korean mobile, RRN, account; flags shortener', () => {
  const r = maskPII('[국민은행] 고객님 주민번호 900101-1234567 확인. 010-1234-5678로 연락, 계좌 110-123-456789 입금. http://bit.ly/abc123');
  const types = r.findings.map((f) => f.type);
  assert.deepEqual(types, ['RRN', 'PHONE', 'ACCOUNT']);
  assert.ok(!r.masked.includes('900101'));
  assert.ok(!r.masked.includes('5678'));
  assert.ok(r.masked.includes('[ACCOUNT_1]'));
  assert.equal(r.urls.length, 1);
  assert.ok(r.urls[0].flags.includes('shortened_link'));
});

test('masks US phone, card, email; flags brand lookalike', () => {
  const r = maskPII('USPS: package held. Call (415) 555-0134 or pay at usps-redelivery-fee.top. Card 4111 1111 1111 1111, mail me at jane.doe@example.com');
  const types = r.findings.map((f) => f.type).sort();
  assert.deepEqual(types, ['CARD', 'EMAIL', 'PHONE']);
  const u = r.urls.find((x) => x.host.includes('usps'));
  assert.ok(u && u.flags.includes('brand_impersonation') && u.flags.includes('high_risk_tld'));
});

test('official domain is not flagged as impersonation', () => {
  const r = maskPII('Your code is ready at https://www.naver.com/help');
  assert.ok(!r.urls[0].flags.includes('brand_impersonation'));
});

test('leaves plain text untouched', () => {
  const r = maskPII('Hi mom, see you at 7 for dinner!');
  assert.equal(r.masked, 'Hi mom, see you at 7 for dinner!');
  assert.equal(r.findings.length, 0);
});

test('same type gets numbered tokens in reading order', () => {
  const r = maskPII('Call 010-1234-5678 or 010-9876-5432.');
  assert.equal(r.masked, 'Call [PHONE_1] or [PHONE_2].');
  assert.deepEqual(r.findings.map((f) => f.original), ['010-1234-5678', '010-9876-5432']);
});

test('masked text can be rebuilt from findings (offsets are exact)', () => {
  const text = '주민번호 900101-1234567, 카드 4111-1111-1111-1111, mail a.b@example.com, +82 10-1234-5678';
  const r = maskPII(text);
  assert.deepEqual(r.findings.map((f) => f.type), ['RRN', 'CARD', 'EMAIL', 'PHONE']);
  for (const f of r.findings) assert.equal(text.slice(f.start, f.end), f.original);
  let rebuilt = r.masked;
  for (const f of r.findings) rebuilt = rebuilt.replace(f.token, f.original);
  assert.equal(rebuilt, text);
});

test('digits inside links are left alone and an email domain is not a link', () => {
  const r = maskPII('Track at http://usps-redelivery-fee.top/track?id=8821312345 or write to help@example.com');
  assert.deepEqual(r.findings.map((f) => f.type), ['EMAIL']);
  assert.equal(r.urls.length, 1);
  assert.ok(r.masked.includes('id=8821312345'));
});

test('analyzeUrl flags', () => {
  const flags = (u: string) => analyzeUrl(u).flags;
  assert.deepEqual(flags('https://www.google.com/account'), []);
  assert.deepEqual(flags('https://example-shop.org'), ['unknown_domain']);
  assert.ok(flags('http://192.168.0.10/login').includes('raw_ip_address'));
  assert.ok(flags('http://192.168.0.10/login').includes('no_https'));
  assert.ok(flags('https://xn--pypal-4ve.com').includes('punycode_lookalike'));
  assert.ok(flags('https://secure-pay-pal-login.com').includes('many_hyphens'));
  assert.ok(flags('https://paypal-secure-login.com').includes('brand_impersonation'));
  assert.ok(flags('han.gl/abc').includes('shortened_link'));
  assert.ok(!flags('https://accounts.google.com').includes('brand_impersonation'));
  assert.ok(flags('https://google.com.evil-site.xyz').includes('brand_impersonation'));
  assert.equal(analyzeUrl('https://naver.com/help.').url, 'https://naver.com/help');
});

test('empty input', () => {
  assert.deepEqual(maskPII(''), { masked: '', findings: [], urls: [] });
});

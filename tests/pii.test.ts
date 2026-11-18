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

test('a link host is never masked, but numbers in its path or query are, and an email domain is not a link', () => {
  const r = maskPII('Track at http://usps-redelivery-fee.top/track?id=8821312345 or write to help@example.com');
  assert.deepEqual(r.findings.map((f) => f.type), ['ACCOUNT', 'EMAIL']);
  assert.equal(r.urls.length, 1);
  assert.equal(r.masked, 'Track at http://usps-redelivery-fee.top/track?id=[ACCOUNT_1] or write to [EMAIL_1]');
  // Digits in the host itself stay, so link analysis and the preview still show the real domain.
  assert.equal(maskPII('see http://1234567.top/x').masked, 'see http://1234567.top/x');
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

const typesOf = (text: string) => maskPII(text).findings.map((f) => f.type);

test('US phones with spaces, dots, parens and 1- prefix', () => {
  for (const p of ['415 555 0134', '415.555.0134', '(415) 555-0134', '1-555-0142-889']) {
    const r = maskPII(`Call ${p} now`);
    assert.equal(r.masked, 'Call [PHONE_1] now', p);
  }
});

test('international phones', () => {
  for (const p of ['+44 7911 123456', '+33 6 12 34 56 78', '+81-90-1234-5678']) {
    assert.equal(maskPII(`Text ${p} please`).masked, 'Text [PHONE_1] please', p);
  }
});

test('cards: Amex grouped/plain, plain 16 digits by Luhn', () => {
  assert.equal(maskPII('Amex 3782 822463 10005 ok').masked, 'Amex [CARD_1] ok');
  assert.equal(maskPII('Amex 378282246310005 ok').masked, 'Amex [CARD_1] ok');
  assert.equal(maskPII('Card 4111111111111111').masked, 'Card [CARD_1]');
  assert.deepEqual(typesOf('Ref 1234567890123456'), ['ACCOUNT']); // fails Luhn
});

test('SSN becomes ID only in SSN formats or after a keyword', () => {
  assert.equal(maskPII('SSN 123-45-6789.').masked, 'SSN [ID_1].');
  assert.equal(maskPII('number 123 45 6789').masked, 'number [ID_1]');
  assert.equal(maskPII('ssn 123456789').masked, 'ssn [ID_1]');
  assert.equal(maskPII('SSN: 123456789').masked, 'SSN: [ID_1]');
  assert.equal(maskPII('Social Security number is 123456789').masked, 'Social Security number is [ID_1]');
  assert.ok(!typesOf('order 123456789').includes('ID'));
});

test('verification codes: only the digits are masked', () => {
  assert.equal(maskPII('Your code is 482913.').masked, 'Your code is [CODE_1].');
  assert.equal(maskPII('OTP: 4829').masked, 'OTP: [CODE_1]');
  assert.equal(maskPII('PIN [482913]').masked, 'PIN [[CODE_1]]');
  assert.equal(maskPII('passcode 12345678').masked, 'passcode [CODE_1]');
  assert.equal(maskPII('인증번호: 482913 입니다').masked, '인증번호: [CODE_1] 입니다');
  assert.equal(maskPII('승인번호 4829').masked, '승인번호 [CODE_1]');
  assert.equal(maskPII('zipcode 94107').masked, 'zipcode 94107');
});

test('fallback: long digit runs masked, dates/money/short numbers left alone', () => {
  assert.deepEqual(typesOf('ref 1234567'), ['ACCOUNT']);
  assert.deepEqual(typesOf('call 0505 123 4567'), ['PHONE']);
  assert.deepEqual(typesOf('id 12 34 56 78'), ['ACCOUNT']);
  for (const t of ['on 2026-11-20 at 3pm', 'on 2026.11.20', 'on 11/20/2026', 'on 20261120', 'on 2026-11-20 15:00', 'paid $1,250.00', 'paid ₩1,000,000', 'room 4821', '₩5000000']) {
    const r = maskPII(t);
    assert.equal(r.masked, t, t);
    assert.equal(r.findings.length, 0, t);
  }
});

test('email inside a URL does not disable link analysis (userinfo trick)', () => {
  const r = maskPII('Log in: http://paypal.com@evil.top/login');
  assert.equal(r.urls.length, 1);
  assert.equal(r.urls[0].host, 'evil.top');
  for (const f of ['userinfo_trick', 'high_risk_tld', 'brand_impersonation']) assert.ok(r.urls[0].flags.includes(f), f);
  assert.equal(r.findings.length, 0);
  assert.equal(r.masked, 'Log in: http://paypal.com@evil.top/login');
});

test('email in a URL query is masked while URL flags are kept', () => {
  const r = maskPII('Go http://usps-redelivery-fee.top/track?email=jane@example.com&id=8821312345 now');
  const flags = r.urls[0].flags;
  for (const f of ['high_risk_tld', 'brand_impersonation', 'no_https', 'many_hyphens']) assert.ok(flags.includes(f), f);
  assert.equal(r.masked, 'Go http://usps-redelivery-fee.top/track?email=[EMAIL_1]&id=[ACCOUNT_1] now');
  assert.deepEqual(typesOf('mail jane@example.com'), ['EMAIL']);
  assert.equal(maskPII('mail jane@example.com').urls.length, 0);
});

test('bare risky-TLD domains are detected without http', () => {
  assert.equal(maskPII('claim at prize.icu today').urls[0].host, 'prize.icu');
  assert.equal(maskPII('see win.buzz/now').urls[0].host, 'win.buzz');
});

test('brand matching is by label, not substring', () => {
  const flags = (u: string) => analyzeUrl(u).flags;
  assert.ok(!flags('https://pineapple-shop.com').includes('brand_impersonation'));
  assert.ok(flags('https://paypal-secure.top').includes('brand_impersonation'));
  assert.ok(flags('https://apple-id.xyz').includes('brand_impersonation'));
  // A label that starts with the brand is still a look-alike.
  assert.ok(flags('http://naverlogin.top').includes('brand_impersonation'));
  assert.ok(!flags('https://www.naver.com').includes('brand_impersonation'));
});

test('numbers next to a date or another claimed span are still masked', () => {
  assert.equal(maskPII('ref 1234567 2026-11-20').masked, 'ref [ACCOUNT_1] 2026-11-20');
  assert.equal(maskPII('+44 7911 123456 2026.11.20').masked, '[PHONE_1] 2026.11.20');
  assert.equal(maskPII('12345678 010-1234-5678').masked, '[ACCOUNT_1] [PHONE_1]');
});

test('7+ digit numbers after a dot, dash or label are masked; amounts are not', () => {
  assert.equal(maskPII('No.1234567').masked, 'No.[ACCOUNT_1]');
  assert.equal(maskPII('ID-12345678').masked, 'ID-[ACCOUNT_1]');
  assert.equal(maskPII('ssn-123456789').masked, 'ssn-[ID_1]');
  assert.equal(maskPII('Balance: 12345.67').findings.length, 0);
  assert.equal(maskPII('total 1,234,567 won').findings.length, 0);
  assert.equal(maskPII("call 5551234567 won't pick up").findings.length, 1);
});

test('a phone number glued to a link with a comma is still masked', () => {
  const r = maskPII('링크:http://a.com,전화:010-1234-5678');
  assert.ok(!r.masked.includes('1234-5678'), r.masked);
  assert.equal(r.urls.length, 1);
  assert.equal(r.urls[0].host, 'a.com');
});

test('an email followed by a slash is masked as an email, not read as a link', () => {
  const r = maskPII('write jane@example.com/x');
  assert.equal(r.masked, 'write [EMAIL_1]/x');
  assert.equal(r.urls.length, 0);
});

test('hyphen-split brands are caught and cloud hosts are not', () => {
  const flags = (u: string) => analyzeUrl(u).flags;
  assert.ok(flags('http://pay-pal.top').includes('brand_impersonation'));
  assert.ok(flags('http://kb-star.xyz').includes('brand_impersonation'));
  for (const ok of ['https://s3.amazonaws.com/x', 'https://fonts.googleapis.com', 'https://naver.me/abc']) {
    assert.ok(!flags(ok).includes('brand_impersonation'), ok);
  }
});

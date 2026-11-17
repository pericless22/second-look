import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskPII } from '../src/pii.ts';

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

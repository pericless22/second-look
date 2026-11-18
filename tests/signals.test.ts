import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskPII } from '../src/pii.ts';
import { asksForOtp, guessScamType, localSignals } from '../src/signals.ts';
import { rulesVerdict } from '../src/rules.ts';

const verdictFor = (text: string) => {
  const signals = localSignals(text, maskPII(text));
  return { signals, ids: signals.map((s) => s.id), verdict: rulesVerdict(signals, 'en') };
};

// Regression: these used to score 32 ("Looks OK") because they contain no link, money request or urgency.
const OTP_FORWARDING = [
  'Hey, I accidentally sent my verification code to your number. Could you forward me the 6-digit code you just received? Thanks!',
  'Hi, wrong number on my signup, sorry! Can you send me the code you got by text?',
  'This is your bank. To cancel the transaction, please tell us the one-time passcode we just texted you.',
  "I'm locked out. What's the 6-digit code? I need it now",
  'Please share the code you received with me so I can finish logging in.',
  'I typed your number by mistake, can you read the OTP back to me?',
  '안녕하세요, 제 인증번호가 실수로 그쪽 번호로 갔어요. 방금 받으신 인증번호 6자리 좀 알려주세요.',
  '엄마 나 폰 바꿨어. 문자로 온 인증번호 불러줘',
  '죄송한데 인증번호를 잘못 보냈어요. 받으신 번호 확인 부탁드립니다.',
];

// Legitimate notices and ordinary chat that mention codes but do not ask the reader to hand one over.
const NOT_OTP_FORWARDING = [
  'Your Google verification code is 482913. Do not share this code with anyone.',
  'Your code is 119204. We will never ask you to send us the code or your password.',
  "Don't forward me the code, I already logged in. Thanks anyway!",
  'Use promo code SAVE10 at checkout for 10% off your next order.',
  'We sent a code to your phone. Enter it on the sign-in page to continue.',
  '[네이버] 인증번호 [482913]을 입력해주세요. 타인에게 절대 알려주지 마세요.',
  '[OO은행] 인증번호는 직원에게도 알려줘서는 안 됩니다.',
  '잘못된 인증번호입니다. 다시 입력해주세요.',
  'Hi mom, running 10 min late, save me some dinner! See you at 7.',
];

test('requests to forward a verification code score HIGH risk', () => {
  for (const text of OTP_FORWARDING) {
    const { ids, verdict } = verdictFor(text);
    assert.ok(asksForOtp(text), `not detected: ${text}`);
    assert.ok(ids.includes('otp_forward'), `no otp_forward signal: ${text}`);
    assert.equal(verdict.risk_level, 'high', `${verdict.risk_score} is not high: ${text}`);
    assert.ok(verdict.risk_score >= 70, text);
    assert.equal(verdict.scam_type, 'account_takeover', text);
    assert.match(verdict.actions[0], /Never share a verification code/, text);
  }
});

test('legit code notices and ordinary chat are not flagged as OTP forwarding', () => {
  for (const text of NOT_OTP_FORWARDING) {
    const { ids, verdict } = verdictFor(text);
    assert.equal(asksForOtp(text), false, `false positive: ${text}`);
    assert.ok(!ids.includes('otp_forward'), text);
    assert.equal(verdict.risk_level, 'low', `${verdict.risk_score} should be low: ${text}`);
  }
});

test('otp_forward is a critical signal; ordinary signals are not', () => {
  const { signals } = verdictFor(OTP_FORWARDING[0]);
  assert.equal(signals.find((s) => s.id === 'otp_forward')?.critical, true);
  assert.ok(verdictFor('URGENT: pay the fee now').signals.every((s) => !s.critical));
});

test('local signals: URL flags and PII findings become signals', () => {
  const { ids } = verdictFor('Pay now at http://bit.ly/x1 or http://192.168.0.1/login, account 110-123-456789, RRN 900101-1234567');
  for (const id of ['url_shortened_link', 'url_raw_ip_address', 'url_no_https', 'contains_account_number', 'contains_rrn']) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  assert.equal(new Set(ids).size, ids.length, 'signal ids are unique');
});

test('a message with no red flags yields no signals and a low, calm verdict', () => {
  const { signals, verdict } = verdictFor('See you at the library at 3pm.');
  assert.deepEqual(signals, []);
  assert.equal(verdict.risk_level, 'low');
  assert.equal(verdict.scam_type, 'none');
  assert.equal(verdict.actions.length, 1);
});

test('guessScamType priority', () => {
  assert.equal(guessScamType([]), 'none');
  assert.equal(guessScamType(['urgency']), 'other');
  assert.equal(guessScamType(['credential_request', 'otp_forward', 'impersonation_bank']), 'account_takeover');
  assert.equal(guessScamType(['delivery_lure', 'impersonation_family']), 'family_impersonation');
  assert.equal(guessScamType(['wrong_number_opener']), 'romance');
  assert.equal(guessScamType(['job_easy_money', 'off_platform_contact']), 'job');
});

test('userinfo_trick is a known URL signal', async () => {
  const { SIGNAL_IDS } = await import('../src/signals.ts');
  assert.ok(SIGNAL_IDS.includes('url_userinfo_trick'));
  assert.ok(verdictFor('http://paypal.com@evil.top/login').ids.includes('url_userinfo_trick'));
});

// English rules need word boundaries: ordinary messages must stay quiet.
const ORDINARY: [string, string[]][] = [
  ["I won't be home first thing, call the bank", ['impersonation_authority', 'prize_refund']],
  ['My wireless earbuds arrived', ['money_request']],
  ['Meeting moved to 2026-11-20 at 3pm', ['contains_account_number']],
  ['The first thing we need is a courtesy call', ['impersonation_authority']],
  ['We won the game last night!', []],
  ["She won't mind", ['prize_refund']],
  ['Wireless charging is great', ['money_request']],
  ['Pineapple pizza at 7?', ['url_brand_impersonation']],
  ['The council meets at 5', ['impersonation_authority']],
  ['Lunch at noon, bring wireless mouse', ['money_request']],
  ['I visited the bank yesterday', []],
  ['Banking apps are handy', []],
];

for (const [text, banned] of ORDINARY) {
  test(`ordinary message stays quiet: ${text}`, () => {
    const { ids, verdict } = verdictFor(text);
    for (const b of banned) assert.ok(!ids.includes(b), `${b} fired for: ${text}`);
    assert.ok(verdict.risk_score < 35, `score ${verdict.risk_score}`);
  });
}

test('word boundaries keep real matches working', () => {
  assert.ok(verdictFor('Please wire the money to this bank').ids.includes('money_request'));
  assert.ok(verdictFor('This is the IRS calling').ids.includes('impersonation_authority'));
  assert.ok(verdictFor('You won a prize!').ids.includes('prize_refund'));
  assert.ok(verdictFor('Your banking account is locked').ids.includes('impersonation_bank'));
});

test('past-tense money and refund words still count', () => {
  const ids = (t: string) => localSignals(t, maskPII(t)).map((s) => s.id);
  assert.ok(ids('Your payment was transferred to the wrong account').includes('money_request'));
  assert.ok(ids('You will be refunded once you confirm').includes('prize_refund'));
  assert.ok(ids('The amount deposited is pending').includes('money_request'));
});

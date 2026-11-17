import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, normalizeVerdict, VERDICT_JSON_SCHEMA, type CheckInput } from '../src/engine.ts';
import { applyLocalFloor, CRITICAL_FLOOR, levelForScore, rulesVerdict } from '../src/rules.ts';
import { RISK_LEVELS, SCAM_TYPES, type Verdict } from '../src/types.ts';

const input = (over: Partial<CheckInput> = {}): CheckInput => ({ text: 'hello', lang: 'en', outLang: 'en', signals: [], ...over });
const lowVerdict: Verdict = { risk_score: 20, risk_level: 'low', scam_type: 'none', reasons: ['Friendly tone'], actions: ['Nothing to do'], confidence: 0.6 };

test('levelForScore thresholds', () => {
  assert.equal(levelForScore(0), 'low');
  assert.equal(levelForScore(34), 'low');
  assert.equal(levelForScore(35), 'medium');
  assert.equal(levelForScore(69), 'medium');
  assert.equal(levelForScore(70), 'high');
  assert.equal(levelForScore(100), 'high');
});

test('normalizeVerdict parses plain, fenced and chatty JSON', () => {
  const json = '{"risk_score":88,"risk_level":"high","scam_type":"delivery","reasons":["a"],"actions":["b"],"confidence":0.9}';
  for (const raw of [json, '```json\n' + json + '\n```', `Sure! Here is the result:\n${json}\nHope that helps.`]) {
    assert.deepEqual(normalizeVerdict(raw), { risk_score: 88, risk_level: 'high', scam_type: 'delivery', reasons: ['a'], actions: ['b'], confidence: 0.9 });
  }
});

test('normalizeVerdict clamps, repairs and trims bad fields', () => {
  const v = normalizeVerdict({ risk_score: 250, risk_level: 'extreme', scam_type: 'aliens', reasons: ['1', ' ', '2', '3', '4', '5'], actions: 'nope', confidence: 7 });
  assert.equal(v.risk_score, 100);
  assert.equal(v.risk_level, 'high'); // derived from the score when the model's level is invalid
  assert.equal(v.scam_type, 'other');
  assert.deepEqual(v.reasons, ['1', '2', '3', '4']);
  assert.deepEqual(v.actions, []);
  assert.equal(v.confidence, 1);

  const nan = normalizeVerdict({ risk_score: 'abc', confidence: 'x' });
  assert.equal(nan.risk_score, 50);
  assert.equal(nan.risk_level, 'medium');
  assert.equal(nan.confidence, 0.5);
  assert.equal(normalizeVerdict({ risk_score: -5 }).risk_score, 0);
  assert.equal(normalizeVerdict({ risk_score: 41.6 }).risk_score, 42);
});

test('normalizeVerdict rejects output that is not a JSON object', () => {
  for (const raw of ['I cannot help with that.', '{"risk_score": 10', '', null, undefined, [1, 2]]) {
    assert.throws(() => normalizeVerdict(raw), /unreadable/, String(raw));
  }
});

test('verdict schema matches the shared enums', () => {
  assert.deepEqual(VERDICT_JSON_SCHEMA.properties.risk_level.enum, [...RISK_LEVELS]);
  assert.deepEqual(VERDICT_JSON_SCHEMA.properties.scam_type.enum, [...SCAM_TYPES]);
  assert.deepEqual(VERDICT_JSON_SCHEMA.required.slice().sort(), Object.keys(VERDICT_JSON_SCHEMA.properties).sort());
});

test('buildPrompt carries signals, language, masking note and the OTP rule', () => {
  const masked = buildPrompt(input({ text: 'Call [PHONE_1]', signals: [{ id: 'urgency', weight: 15 }, { id: 'otp_forward', weight: 60, critical: true }] }), 'ko', true);
  assert.match(masked, /signals already detected on-device: urgency, otp_forward\./);
  assert.match(masked, /in Korean\./);
  assert.match(masked, /masked on the user's device/);
  assert.match(masked, /verification code/);
  assert.match(masked, /--- MESSAGE START ---\nCall \[PHONE_1\]\n--- MESSAGE END ---$/);

  const raw = buildPrompt(input(), 'en', false);
  assert.match(raw, /detected on-device: none\./);
  assert.match(raw, /in English\./);
  assert.doesNotMatch(raw, /masked on the user's device/);
  assert.doesNotMatch(raw, /screenshot/);

  const withImage = buildPrompt(input({ text: '', image: { mimeType: 'image/png', base64: 'AAAA' } }), 'en', false);
  assert.match(withImage, /attached screenshot/);
  assert.match(withImage, /\(see screenshot\)/);
});

test('buildPrompt states score bands, medium cases and the family_impersonation definition', () => {
  const p = buildPrompt(input(), 'en', false);
  assert.match(p, /low 0-34, medium 35-69, high 70-100/);
  assert.match(p, /second-hand trade asking to pay first/);
  assert.match(p, /family_impersonation means ONLY someone claiming to be the reader's parent or child/);
  assert.match(p, /scam_type marketplace/);
});

test('marketplace is a valid scam type and normalizeVerdict accepts it', () => {
  assert.ok((SCAM_TYPES as readonly string[]).includes('marketplace'));
  const v = normalizeVerdict({ risk_score: 55, risk_level: 'medium', scam_type: 'marketplace', reasons: ['a'], actions: ['b'], confidence: 0.7 });
  assert.equal(v.scam_type, 'marketplace');
});

test('applyLocalFloor lifts an under-scored model verdict when a critical signal fired', () => {
  const signals = [{ id: 'otp_forward', weight: 60, critical: true }];
  const v = applyLocalFloor(lowVerdict, signals, 'en');
  assert.equal(v.risk_score, CRITICAL_FLOOR);
  assert.equal(v.risk_level, 'high');
  assert.equal(v.scam_type, 'account_takeover');
  assert.match(v.reasons[0], /verification code/);
  assert.ok(v.reasons.includes('Friendly tone'), 'model reasons are kept');
  assert.ok(v.reasons.length <= 4 && v.actions.length <= 4);
  assert.match(v.actions[0], /Never share a verification code/);
  assert.ok(v.confidence >= 0.8);
  assert.match(applyLocalFloor(lowVerdict, signals, 'ko').reasons[0], /인증번호/);
});

test('applyLocalFloor leaves other verdicts untouched', () => {
  assert.equal(applyLocalFloor(lowVerdict, [{ id: 'urgency', weight: 15 }], 'en'), lowVerdict);
  assert.equal(applyLocalFloor(lowVerdict, [], 'en'), lowVerdict);
  const alreadyHigh: Verdict = { ...lowVerdict, risk_score: 95, risk_level: 'high', scam_type: 'bank_impersonation' };
  assert.equal(applyLocalFloor(alreadyHigh, [{ id: 'otp_forward', weight: 60, critical: true }], 'en'), alreadyHigh);
});

test('rulesVerdict is capped, sorted by weight and localised', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: i === 3 ? 'investment' : 'urgency', weight: i === 3 ? 99 : 20 }));
  const v = rulesVerdict(many, 'ko');
  assert.equal(v.risk_score, 98);
  assert.equal(v.reasons.length, 4);
  assert.equal(v.reasons[0], '투자 수익을 보장한다고 해요');
  assert.equal(v.actions.length, 4);
  assert.equal(rulesVerdict([{ id: 'urgency', weight: 30 }], 'en').risk_level, 'medium');
});

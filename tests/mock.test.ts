// Mock mode must keep working without Firebase, Gemini Nano or a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockEngine } from '../src/mock.ts';
import { maskPII } from '../src/pii.ts';
import { localSignals } from '../src/signals.ts';
import type { CheckInput } from '../src/engine.ts';

const inputFor = (text: string, outLang = 'en'): CheckInput => {
  const mask = maskPII(text);
  return { text: mask.masked, lang: 'en', outLang, signals: localSignals(text, mask) };
};
const OTP = 'I accidentally sent my verification code to your number. Could you forward me the 6-digit code you just received?';
const engine = () => new MockEngine(0);

test('private check runs on the simulated device and flags OTP forwarding as high risk', async () => {
  const r = await engine().privateCheck(inputFor(OTP));
  assert.equal(r.source, 'mock_on_device');
  assert.equal(r.verdict.risk_level, 'high');
  assert.equal(r.verdict.scam_type, 'account_takeover');
});

test('private check refuses to run without an on-device model', async () => {
  const e = engine();
  e.status = 'unavailable';
  await assert.rejects(e.privateCheck(inputFor('hello')), /unavailable/);
});

test('hybrid check prefers the device and falls back to the cloud', async () => {
  const e = engine();
  assert.equal((await e.hybridCheck(inputFor('hello'))).source, 'mock_on_device');
  e.status = 'unavailable';
  assert.equal((await e.hybridCheck(inputFor('hello'))).source, 'mock_in_cloud');
});

test('cloud check answers in the UI language and only ever sees the masked text', async () => {
  const text = '검찰입니다. 안전계좌 110-000-123456 으로 이체하고 010-0000-1234 로 연락 바랍니다.';
  const r = await engine().cloudCheck(inputFor(text, 'ko'));
  assert.equal(r.source, 'mock_in_cloud');
  assert.ok(!r.sentText.includes('123456') && !r.sentText.includes('0000-1234'));
  assert.match(r.sentText, /\[ACCOUNT_1\]/);
  assert.match(r.verdict.reasons.join(' '), /[가-힣]/);
});

test('simulated offline blocks every cloud call', async () => {
  const e = engine();
  e.offline = true;
  e.status = 'unavailable';
  const v = (await engine().privateCheck(inputFor('hello'))).verdict;
  await assert.rejects(e.cloudCheck(inputFor('hello')), /offline/);
  await assert.rejects(e.hybridCheck(inputFor('hello')), /offline/);
  await assert.rejects(e.startFollowUp({ maskedMessage: 'm', verdict: v, uiLang: 'en' }).ask('q'), /offline/);
});

test('download reports progress and makes the model available', async () => {
  const e = engine();
  e.status = 'downloadable';
  const seen: number[] = [];
  await e.downloadOnDevice((p) => seen.push(p));
  assert.equal(seen.length, 10);
  assert.equal(seen.at(-1), 1);
  assert.equal(await e.onDeviceStatus(), 'available');
});

test('follow-up answer is labelled as a mock and echoes the question', async () => {
  const v = (await engine().privateCheck(inputFor(OTP))).verdict;
  const a = await engine().startFollowUp({ maskedMessage: 'masked', verdict: v, uiLang: 'en' }).ask('How do I report this?');
  assert.match(a, /Mock answer/);
  assert.match(a, /How do I report this\?/);
  assert.ok(a.includes(`${v.risk_score}/100`));
});

test('one follow-up chat keeps its history across questions', async () => {
  const v = (await engine().privateCheck(inputFor(OTP))).verdict;
  const chat = engine().startFollowUp({ maskedMessage: 'masked', verdict: v, uiLang: 'en' });
  await chat.ask('Is it a scam?');
  const second = await chat.ask('Who do I call?');
  assert.deepEqual(chat.history, ['Is it a scam?', 'Who do I call?']);
  assert.match(second, /question 2/);
});

test('results record the language their text is written in', async () => {
  assert.equal((await engine().privateCheck(inputFor(OTP, 'ko'))).lang, 'en');
  assert.equal((await engine().cloudCheck(inputFor(OTP, 'ko'))).lang, 'ko');
});

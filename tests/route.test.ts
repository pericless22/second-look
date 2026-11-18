// The privacy promise: raw text only goes to ONLY_ON_DEVICE; anything that can reach the cloud is masked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRoute, friendlyError, maskQuestion, runCheck, secondOpinion, type CheckDeps } from '../src/route.ts';
import { MockEngine } from '../src/mock.ts';
import type { CheckInput } from '../src/engine.ts';

const SCAM = 'URGENT: your package is on hold. Pay the fee at http://usps-redelivery-fee.top/pay or call 415-555-0134.';
const KO = '고객님 택배가 반송되었습니다. 010-1234-5678 로 연락 주세요 http://cj-delivery.xyz';
const IMG = { mimeType: 'image/png', base64: 'iVBORw0KGgo=' };

/** Records every engine call so tests can check exactly what each path was given. */
function spyEngine(status: MockEngine['status'] = 'available') {
  const e = new MockEngine(0);
  e.status = status;
  const calls: { method: string; input: CheckInput }[] = [];
  for (const method of ['privateCheck', 'hybridCheck', 'cloudCheck'] as const) {
    const orig = e[method].bind(e);
    e[method] = async (input: CheckInput) => { calls.push({ method, input }); return orig(input); };
  }
  return { e, calls };
}

const deps = (engine: MockEngine, over: Partial<CheckDeps> = {}): CheckDeps => ({
  engine,
  online: () => !engine.offline,
  uiLang: 'en',
  detectLanguage: async (t) => (/[가-힣]/.test(t) ? 'ko' : 'en'),
  askConsent: async () => true,
  ...over,
});

test('decideRoute covers every case', () => {
  assert.deepEqual(decideRoute({ status: 'available', lang: 'en', online: true }), { kind: 'private' });
  assert.deepEqual(decideRoute({ status: 'available', lang: 'en', online: false }), { kind: 'private' });
  assert.deepEqual(decideRoute({ status: 'available', lang: 'ko', online: true }), { kind: 'cloud', why: 'lang', mode: 'cloud' });
  assert.deepEqual(decideRoute({ status: 'unavailable', lang: 'en', online: true }), { kind: 'cloud', why: 'nomodel', mode: 'hybrid' });
  assert.deepEqual(decideRoute({ status: 'downloadable', lang: 'ja', online: true }), { kind: 'cloud', why: 'nomodel', mode: 'hybrid' });
  assert.deepEqual(decideRoute({ status: 'unavailable', lang: 'ko', online: false }), { kind: 'offline' });
  // Screenshot with no text: language unknown, so never the private Nano path.
  assert.deepEqual(decideRoute({ status: 'available', lang: null, online: true }), { kind: 'cloud', why: 'image', mode: 'cloud' });
  assert.deepEqual(decideRoute({ status: 'available', lang: null, online: false }), { kind: 'offline' });
});

test('private path gets the raw text and nothing else is called', async () => {
  const { e, calls } = spyEngine();
  const out = await runCheck(SCAM, undefined, deps(e, { askConsent: async () => { throw new Error('should not ask'); } }));
  assert.deepEqual(calls.map((c) => c.method), ['privateCheck']);
  assert.equal(calls[0].input.text, SCAM);
  assert.equal(out.route.kind, 'private');
});

test('every cloud-capable call gets exactly the masked text', async () => {
  for (const [text, status] of [[SCAM, 'unavailable'], [KO, 'available'], [KO, 'unavailable']] as const) {
    const { e, calls } = spyEngine(status);
    const out = await runCheck(text, undefined, deps(e));
    assert.ok(calls.length >= 1);
    for (const c of calls) {
      assert.notEqual(c.method, 'privateCheck');
      assert.equal(c.input.text, out.mask.masked);
      assert.ok(!c.input.text.includes('0134') && !c.input.text.includes('5678'), c.input.text);
    }
  }
});

test('Korean goes ONLY_IN_CLOUD, English without a model goes PREFER_ON_DEVICE', async () => {
  const ko = spyEngine('available');
  await runCheck(KO, undefined, deps(ko.e));
  assert.equal(ko.calls[0].method, 'cloudCheck');
  const en = spyEngine('unavailable');
  await runCheck(SCAM, undefined, deps(en.e));
  assert.equal(en.calls[0].method, 'hybridCheck');
});

test('a screenshot with no text never goes to Nano, and asks consent first', async () => {
  const { e, calls } = spyEngine('available');
  const cloud = e.cloudCheck;
  e.cloudCheck = async (input) => { try { return await cloud(input); } catch { return { verdict: { risk_score: 80, risk_level: 'high', scam_type: 'delivery', reasons: [], actions: [], confidence: 0.9 }, source: 'mock_in_cloud', sentText: '', ms: 0 }; } };
  const asked: unknown[] = [];
  const out = await runCheck('', IMG, deps(e, { askConsent: async (_m, why, lang, withImage) => { asked.push({ why, lang, withImage }); return true; } }));
  assert.deepEqual(asked, [{ why: 'image', lang: null, withImage: true }]);
  assert.deepEqual(calls.map((c) => c.method), ['cloudCheck']);
  assert.deepEqual(out.route, { kind: 'cloud', why: 'image', sentImage: true });
});

test('declining consent sends nothing and shows local rules', async () => {
  const { e, calls } = spyEngine('unavailable');
  const out = await runCheck(SCAM, undefined, deps(e, { askConsent: async () => false }));
  assert.equal(calls.length, 0);
  assert.equal(out.route.kind, 'declined');
  assert.equal(out.result?.source, 'rules');
  // A declined screenshot-only check has nothing to show rather than a false "looks OK".
  const img = await runCheck('', IMG, deps(spyEngine('unavailable').e, { askConsent: async () => false }));
  assert.equal(img.result, undefined);
});

test('offline without a model uses local rules and calls no model', async () => {
  const { e, calls } = spyEngine('unavailable');
  e.offline = true;
  const out = await runCheck(SCAM, undefined, deps(e));
  assert.equal(calls.length, 0);
  assert.equal(out.route.kind, 'offline');
  assert.equal(out.result?.verdict.risk_level, 'high');
});

test('a failed model call falls back to the local-rules verdict', async () => {
  for (const status of ['available', 'unavailable'] as const) {
    const { e } = spyEngine(status);
    e.failWith = new Error('[GoogleGenerativeAI Error]: 429 Resource exhausted');
    const out = await runCheck(SCAM, undefined, deps(e));
    assert.equal(out.result?.source, 'rules');
    assert.equal(out.result?.verdict.risk_level, 'high');
    assert.deepEqual(out.route.kind === 'failed' && out.route.error, 'err.quota');
  }
  // Screenshot only: no text to score, so no verdict, but the error is kept.
  const { e } = spyEngine('available');
  e.failWith = new Error('boom');
  const out = await runCheck('', IMG, deps(e));
  assert.equal(out.result, undefined);
  assert.equal(out.route.kind, 'failed');
});

test('mock mode never calls a screenshot "looks OK"', async () => {
  const out = await runCheck('', IMG, deps(new MockEngine(0)));
  assert.equal(out.result, undefined);
  assert.equal(out.route.kind, 'failed');
});

test('friendlyError maps common failures', () => {
  assert.equal(friendlyError(new Error('offline')), 'err.network');
  assert.equal(friendlyError(new TypeError('Failed to fetch')), 'err.network');
  assert.equal(friendlyError(new Error('Request failed with 429')), 'err.quota');
  assert.equal(friendlyError(new Error('403 Firebase App Check token is invalid')), 'err.denied');
  assert.equal(friendlyError(new Error('The input is too long')), 'err.too_long');
  assert.equal(friendlyError('weird'), 'err.model');
  // Chrome's Prompt API uses QuotaExceededError for an over-long input, which is not a rate limit.
  const tooLong = new Error('The input is over quota'); tooLong.name = 'QuotaExceededError';
  assert.equal(friendlyError(tooLong), 'err.too_long');
});

test('a failed call records whether data had already gone to the cloud', async () => {
  const dev = spyEngine('available');
  dev.e.failWith = new Error('boom');
  const a = await runCheck(SCAM, IMG, deps(dev.e));
  assert.deepEqual(a.route.kind === 'failed' && [a.route.attempted, a.route.sentImage], ['device', false]);

  const cloud = spyEngine('unavailable');
  cloud.e.failWith = new Error('boom');
  const b = await runCheck(SCAM, IMG, deps(cloud.e));
  assert.deepEqual(b.route.kind === 'failed' && [b.route.attempted, b.route.sentImage], ['cloud', true]);
});

test('the second opinion and follow-up questions only ever see masked text', async () => {
  const { e, calls } = spyEngine('available');
  const first = await runCheck(SCAM, undefined, deps(e));
  await secondOpinion(e, first, 'en');
  const second = calls.at(-1)!;
  assert.equal(second.method, 'cloudCheck');
  assert.equal(second.input.text, first.mask.masked);
  assert.ok(!second.input.text.includes('0134'));
  assert.equal(maskQuestion('they said call 415-555-0134, should I?'), 'they said call [PHONE_1], should I?');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appCheckPlan, isRealValue, loadConfig, type AppConfig } from '../src/config.ts';

const real: AppConfig = { firebase: { apiKey: 'AIzaFake123', appId: '1:123:web:abc', projectId: 'demo' } };
const fakeFetch = (status: number, body: string) =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

test('placeholders and blanks are not real values', () => {
  for (const v of ['YOUR_RECAPTCHA_V3_SITE_KEY', 'your_api_key', '', '   ', undefined, null, 42]) assert.equal(isRealValue(v), false, String(v));
  assert.equal(isRealValue('6LcXyz'), true);
});

test('a placeholder reCAPTCHA key does not count as configured', () => {
  const plan = appCheckPlan({ ...real, appCheck: { recaptchaV3SiteKey: 'YOUR_RECAPTCHA_V3_SITE_KEY', useDebugToken: true } }, 'localhost');
  assert.equal(plan.siteKey, undefined);
  assert.equal(plan.debugToken, false);
  assert.match(plan.warnings.join(' '), /placeholder/);
});

test('a missing key is reported, a real key is used', () => {
  assert.match(appCheckPlan(real, 'localhost').warnings.join(' '), /no recaptchaV3SiteKey/);
  const plan = appCheckPlan({ ...real, appCheck: { recaptchaV3SiteKey: ' 6LcReal ' } }, 'example.web.app');
  assert.equal(plan.siteKey, '6LcReal');
  assert.deepEqual(plan.warnings, []);
});

test('debug tokens are only honoured on localhost', () => {
  const cfg = { ...real, appCheck: { recaptchaV3SiteKey: '6LcReal', useDebugToken: true } };
  assert.equal(appCheckPlan(cfg, 'localhost').debugToken, true);
  assert.equal(appCheckPlan(cfg, '127.0.0.1').debugToken, true);
  const hosted = appCheckPlan(cfg, 'golden-dccd2.web.app');
  assert.equal(hosted.debugToken, false);
  assert.match(hosted.warnings.join(' '), /ignored on a deployed site/);
});

test('loadConfig accepts a real config', async () => {
  const r = await loadConfig(fakeFetch(200, JSON.stringify(real)));
  assert.equal(r.ok, true);
});

test('loadConfig explains why it fell back to mock mode', async () => {
  // Firebase Hosting answers a missing file with index.html because of the SPA rewrite.
  const html = await loadConfig(fakeFetch(200, '<!doctype html><html></html>'));
  assert.equal(html.ok, false);
  assert.match(!html.ok ? html.reason : '', /not JSON/);

  const missing = await loadConfig(fakeFetch(404, 'nope'));
  assert.match(!missing.ok ? missing.reason : '', /HTTP 404/);

  const placeholder = await loadConfig(fakeFetch(200, JSON.stringify({ firebase: { apiKey: 'YOUR_API_KEY', appId: 'YOUR_APP_ID' } })));
  assert.match(!placeholder.ok ? placeholder.reason : '', /placeholder/);

  const noSection = await loadConfig(fakeFetch(200, '{}'));
  assert.match(!noSection.ok ? noSection.reason : '', /no "firebase" section/);

  const thrown = await loadConfig((async () => { throw new Error('boom'); }) as unknown as typeof fetch);
  assert.match(!thrown.ok ? thrown.reason : '', /boom/);
});

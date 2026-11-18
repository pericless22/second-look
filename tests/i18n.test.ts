import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DICTS, t } from '../src/i18n.ts';
import { SIGNAL_IDS } from '../src/signals.ts';
import { RISK_LEVELS, SCAM_TYPES } from '../src/types.ts';

test('English and Korean define exactly the same keys, none empty', () => {
  assert.deepEqual(Object.keys(DICTS.ko).sort(), Object.keys(DICTS.en).sort());
  for (const [lang, dict] of Object.entries(DICTS)) {
    for (const [k, v] of Object.entries(dict)) assert.ok(v.trim(), `${lang}:${k} is empty`);
  }
});

test('every signal, scam type, risk level and source has a label', () => {
  const keys = [
    ...SIGNAL_IDS.map((id) => `sig.${id}`),
    'sig.none',
    ...SCAM_TYPES.map((s) => `type.${s}`),
    ...RISK_LEVELS.map((l) => `result.level.${l}`),
    ...['on_device', 'in_cloud', 'in_cloud_image', 'mock_on_device', 'mock_in_cloud', 'mock_in_cloud_image', 'in_cloud_screenshot', 'mock_in_cloud_screenshot', 'rules'].map((s) => `result.source.${s}`),
    ...['RRN', 'CARD', 'PHONE', 'ACCOUNT', 'EMAIL', 'ID', 'CODE'].map((p) => `pii.${p}`),
    ...['network', 'quota', 'denied', 'too_long', 'model'].map((e) => `err.${e}`),
  ];
  for (const k of keys) for (const lang of ['en', 'ko']) assert.ok(k in DICTS[lang], `${lang} is missing ${k}`);
});

test('t() falls back to English, then to the key', () => {
  assert.equal(t('ko', 'btn.clear'), '지우기');
  assert.equal(t('fr', 'btn.clear'), 'Clear');
  assert.equal(t('en', 'no.such.key'), 'no.such.key');
});

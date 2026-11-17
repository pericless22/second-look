// Baseline: the deterministic on-device rules alone (no model) on the 30 synthetic samples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLES } from '../src/samples.ts';
import { maskPII } from '../src/pii.ts';
import { localSignals } from '../src/signals.ts';
import { rulesVerdict } from '../src/mock.ts';

test('30 synthetic samples, 15 EN + 15 KO', () => {
  assert.equal(SAMPLES.length, 30);
  assert.equal(SAMPLES.filter((s) => s.lang === 'ko').length, 15);
});

test('rules baseline: scams flagged, safe messages low', () => {
  const rows = SAMPLES.map((s) => {
    const m = maskPII(s.text);
    const v = rulesVerdict(localSignals(s.text, m), 'en');
    return { id: s.id, expected: s.expected, level: v.risk_level, score: v.risk_score, pii: m.findings.map((f) => f.type).join(',') };
  });
  console.table(rows);
  for (const r of rows) {
    if (r.expected === 'scam') assert.notEqual(r.level, 'low', `${r.id} should not be low`);
    if (r.expected === 'safe') assert.equal(r.level, 'low', `${r.id} should be low`);
  }
});

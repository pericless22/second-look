// Baseline: the deterministic on-device rules alone (no model) on the 30 synthetic samples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLES } from '../src/samples.ts';
import { maskPII } from '../src/pii.ts';
import { localSignals } from '../src/signals.ts';
import { rulesVerdict } from '../src/rules.ts';

const rows = SAMPLES.map((s) => {
  const m = maskPII(s.text);
  const v = rulesVerdict(localSignals(s.text, m), 'en');
  return { id: s.id, expected: s.expected, level: v.risk_level, score: v.risk_score, type: v.scam_type, pii: m.findings.map((f) => f.type).join(',') };
});
const row = (id: string) => rows.find((r) => r.id === id)!;

test('30 synthetic samples, 15 EN + 15 KO, unique ids', () => {
  assert.equal(SAMPLES.length, 30);
  assert.equal(SAMPLES.filter((s) => s.lang === 'ko').length, 15);
  assert.equal(SAMPLES.filter((s) => s.lang === 'en').length, 15);
  assert.equal(new Set(SAMPLES.map((s) => s.id)).size, 30);
  for (const s of SAMPLES) assert.ok(s.text.trim() && s.label.trim(), s.id);
});

test('rules baseline: scams and suspicious messages flagged, safe messages low', () => {
  console.table(rows);
  for (const r of rows) {
    if (r.expected === 'safe') {
      assert.equal(r.level, 'low', `${r.id} should be low`);
      assert.ok(r.score < 20, `${r.id} scored ${r.score}`);
      assert.equal(r.type, 'none', r.id);
    } else {
      assert.notEqual(r.level, 'low', `${r.id} should not be low`);
      assert.notEqual(r.type, 'none', r.id);
    }
  }
});

test('en11 (verification-code forwarding) is high risk, not "looks OK"', () => {
  assert.equal(row('en11').level, 'high');
  assert.equal(row('en11').type, 'account_takeover');
});

test('official code notices stay low (en15, ko15)', () => {
  assert.equal(row('en15').level, 'low');
  assert.equal(row('ko15').level, 'low');
});

test('masked samples never leak the PII that was found', () => {
  for (const s of SAMPLES) {
    const m = maskPII(s.text);
    for (const f of m.findings) {
      assert.ok(!m.masked.includes(f.original), `${s.id} leaks ${f.type}`);
      assert.ok(m.masked.includes(f.token), `${s.id} is missing ${f.token}`);
    }
  }
});

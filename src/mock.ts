// Mock engine: lets the full UI be demoed without a Firebase project or Gemini Nano.
// Scores with the same local signals; clearly labelled "MOCK" in the UI.
import type { Engine, CheckInput, OnDeviceStatus } from './engine.ts';
import type { CheckResult, Source, Verdict } from './types.ts';
import type { Signal } from './signals.ts';
import { guessScamType } from './signals.ts';
import { t } from './i18n.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic verdict from local signals only (mock mode, and when the user keeps it on-device without a model). */
export function rulesVerdict(signals: Signal[], outLang: string): Verdict {
  const ids = signals.map((s) => s.id);
  const score = Math.min(98, signals.reduce((a, s) => a + s.weight, ids.length ? 12 : 4));
  const level = score >= 70 ? 'high' : score >= 35 ? 'medium' : 'low';
  const L = (k: string) => t(outLang, k);
  const reasons = signals.slice().sort((a, b) => b.weight - a.weight).slice(0, 4).map((s) => L(`sig.${s.id}`));
  const actions = level === 'low' ? [L('act.low1')] : [L('act.noclick'), L('act.verify'), L('act.report'), ...(level === 'high' ? [L('act.block')] : [])];
  return {
    risk_score: score, risk_level: level, scam_type: level === 'low' ? 'none' : guessScamType(ids),
    reasons: reasons.length ? reasons : [L('sig.none')], actions, confidence: level === 'medium' ? 0.55 : 0.85,
  };
}

export class MockEngine implements Engine {
  kind = 'mock' as const;
  status: OnDeviceStatus = 'available';
  uiLang = 'en';
  offline = false;

  async onDeviceStatus() { return this.status; }
  async downloadOnDevice(onProgress: (p: number) => void) {
    this.status = 'downloading';
    for (let i = 1; i <= 10; i++) { await sleep(120); onProgress(i / 10); }
    this.status = 'available';
  }
  private async run(input: CheckInput, source: Source, outLang: string): Promise<CheckResult> {
    const t0 = performance.now();
    await sleep(source.includes('cloud') ? 900 : 450);
    return { verdict: rulesVerdict(input.signals, outLang), source, sentText: input.text, ms: Math.round(performance.now() - t0) };
  }
  async privateCheck(input: CheckInput) {
    if (this.status !== 'available') throw new Error('on-device model unavailable');
    return this.run(input, 'mock_on_device', 'en');
  }
  async hybridCheck(input: CheckInput) {
    return this.status === 'available' ? this.run(input, 'mock_on_device', 'en') : this.cloudCheck(input);
  }
  async cloudCheck(input: CheckInput) {
    if (this.offline || !navigator.onLine) throw new Error('offline');
    return this.run(input, 'mock_in_cloud', this.uiLang);
  }
  async followUp(_m: string, v: Verdict, q: string, uiLang: string) {
    await sleep(700);
    return t(uiLang, 'mock.followup').replace('{q}', q).replace('{score}', String(v.risk_score));
  }
}

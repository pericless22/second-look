// Deterministic verdicts from local signals. No model, no network.
// Used in mock mode, offline, when the user declines the cloud, and as a floor under model verdicts.
import type { RiskLevel, Verdict } from './types.ts';
import { guessScamType, type Signal } from './signals.ts';
import { t } from './i18n.ts';

export const HIGH_THRESHOLD = 70;
export const MEDIUM_THRESHOLD = 35;
/** Minimum score when a critical signal (e.g. a request to forward a verification code) is present. */
export const CRITICAL_FLOOR = 80;

const MAX_ITEMS = 4;

export function levelForScore(score: number): RiskLevel {
  return score >= HIGH_THRESHOLD ? 'high' : score >= MEDIUM_THRESHOLD ? 'medium' : 'low';
}

/** Standard advice for a risk level, in the given UI language. */
export function defaultActions(level: RiskLevel, signals: Signal[], lang: string): string[] {
  const L = (k: string) => t(lang, k);
  if (level === 'low') return [L('act.low1')];
  const first = signals.some((s) => s.id === 'otp_forward') ? L('act.otp') : L('act.noclick');
  return [first, L('act.verify'), L('act.report'), ...(level === 'high' ? [L('act.block')] : [])];
}

/** Verdict from local signals only. */
export function rulesVerdict(signals: Signal[], outLang: string): Verdict {
  const ids = signals.map((s) => s.id);
  const score = Math.min(98, signals.reduce((sum, s) => sum + s.weight, ids.length ? 12 : 4));
  const level = levelForScore(score);
  const reasons = signals
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_ITEMS)
    .map((s) => t(outLang, `sig.${s.id}`));
  return {
    risk_score: score,
    risk_level: level,
    scam_type: level === 'low' ? 'none' : guessScamType(ids),
    reasons: reasons.length ? reasons : [t(outLang, 'sig.none')],
    actions: defaultActions(level, signals, outLang),
    confidence: level === 'medium' ? 0.55 : 0.85,
  };
}

/**
 * Safety net under a model verdict: small on-device models can under-score scams that have no
 * link and no money request. If a critical local signal fired, the result is never below high risk.
 */
export function applyLocalFloor(verdict: Verdict, signals: Signal[], outLang: string): Verdict {
  const critical = signals.filter((s) => s.critical);
  if (!critical.length || verdict.risk_score >= CRITICAL_FLOOR) return verdict;
  const localReasons = critical.map((s) => t(outLang, `sig.${s.id}`));
  return {
    risk_score: CRITICAL_FLOOR,
    risk_level: 'high',
    scam_type: verdict.scam_type === 'none' || verdict.scam_type === 'other' ? guessScamType(signals.map((s) => s.id)) : verdict.scam_type,
    reasons: [...localReasons, ...verdict.reasons.filter((r) => !localReasons.includes(r))].slice(0, MAX_ITEMS),
    actions: defaultActions('high', signals, outLang),
    confidence: Math.max(verdict.confidence, 0.8),
  };
}

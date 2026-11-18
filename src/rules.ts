// Deterministic verdicts from local signals. No model, no network.
// Used in mock mode, offline, when the user declines the cloud, and as a floor under model verdicts.
import type { RiskLevel, Verdict } from './types.ts';
import { guessScamType, type Signal } from './signals.ts';
import { t } from './i18n.ts';

export const HIGH_THRESHOLD = 70;
export const MEDIUM_THRESHOLD = 35;
/** Minimum score when a critical signal (e.g. a request to forward a verification code) is present. */
export const CRITICAL_FLOOR = 80;
/** Minimum score when the local rules say high risk but the model says low: never show "Looks OK" then. */
export const DISAGREE_FLOOR = 45;

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
 * link and no money request, and a pasted message can try to talk the model down.
 * - A critical local signal keeps the result at high risk or above.
 * - If the local rules alone say high and the model says low, the result is at least "Be careful",
 *   and the first reason says the two disagree.
 */
export function applyLocalFloor(verdict: Verdict, signals: Signal[], outLang: string): Verdict {
  const critical = signals.filter((s) => s.critical);
  if (!critical.length || verdict.risk_score >= CRITICAL_FLOOR) return disagreementFloor(verdict, signals, outLang);
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

function disagreementFloor(verdict: Verdict, signals: Signal[], outLang: string): Verdict {
  if (verdict.risk_level !== 'low') return verdict;
  const local = rulesVerdict(signals, outLang);
  if (local.risk_level !== 'high') return verdict;
  return {
    risk_score: DISAGREE_FLOOR,
    risk_level: levelForScore(DISAGREE_FLOOR),
    scam_type: verdict.scam_type === 'none' ? guessScamType(signals.map((s) => s.id)) : verdict.scam_type,
    reasons: [t(outLang, 'note.disagree'), ...local.reasons.slice(0, 2), ...verdict.reasons].slice(0, MAX_ITEMS),
    actions: defaultActions('medium', signals, outLang),
    confidence: Math.min(verdict.confidence, 0.5),
  };
}

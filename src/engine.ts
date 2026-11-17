import type { CheckResult, Verdict } from './types.ts';
import type { Signal } from './signals.ts';

export type OnDeviceStatus = 'available' | 'downloadable' | 'downloading' | 'unavailable';

export interface CheckInput {
  text: string;           // raw text for private checks, masked text for anything that may reach the cloud
  image?: { mimeType: string; base64: string };
  lang: string;
  signals: Signal[];
}

export interface Engine {
  kind: 'firebase' | 'mock';
  onDeviceStatus(withImage?: boolean): Promise<OnDeviceStatus>;
  downloadOnDevice(onProgress: (p: number) => void): Promise<void>;
  /** Raw text, ONLY_ON_DEVICE: guaranteed never to leave the device. */
  privateCheck(input: CheckInput): Promise<CheckResult>;
  /** Masked text, PREFER_ON_DEVICE: on-device when ready, otherwise Gemini in the cloud. */
  hybridCheck(input: CheckInput): Promise<CheckResult>;
  /** Masked text, ONLY_IN_CLOUD: languages Nano can't read (e.g. Korean) and second opinions. */
  cloudCheck(input: CheckInput): Promise<CheckResult>;
  /** Cloud follow-up Q&A (multi-turn is cloud-only). Context is masked. */
  followUp(maskedMessage: string, verdict: Verdict, question: string, uiLang: string): Promise<string>;
}

export const RISK_ENUM = ['low', 'medium', 'high'];
export const SCAM_ENUM = ['delivery', 'bank_impersonation', 'government_impersonation', 'family_impersonation', 'investment', 'loan', 'prize_or_refund', 'romance', 'job', 'account_takeover', 'none', 'other'];

/** Plain JSON Schema (used for Chrome's responseConstraint on-device). */
export const VERDICT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    risk_score: { type: 'integer', minimum: 0, maximum: 100 },
    risk_level: { type: 'string', enum: RISK_ENUM },
    scam_type: { type: 'string', enum: SCAM_ENUM },
    reasons: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    actions: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['risk_score', 'risk_level', 'scam_type', 'reasons', 'actions', 'confidence'],
};

export function buildPrompt(input: CheckInput, outLang: string, masked: boolean): string {
  const sig = input.signals.map((s) => s.id).join(', ') || 'none';
  return [
    'You are Second Look, a careful anti-scam assistant protecting people (often elderly parents) from smishing, phishing and impersonation scams.',
    'Assess the message below. Return ONLY JSON matching the schema: risk_score 0-100, risk_level (low/medium/high), scam_type, up to 4 short reasons quoting concrete red flags, up to 4 short concrete actions, and confidence 0-1.',
    'Be calibrated: ordinary personal or official messages without requests for money, codes, credentials, app installs or unknown links are low risk. Never tell the user to click links or call numbers in the message.',
    masked ? 'Personal data was masked on the user\'s device before sending; tokens like [PHONE_1], [ACCOUNT_1], [RRN_1] stand for real values. Treat requests to send such data as red flags.' : '',
    `Local rule-based signals already detected on-device: ${sig}.`,
    `Write reasons and actions in ${outLang === 'ko' ? 'Korean' : 'English'}.`,
    input.image ? 'The attached screenshot is the message to assess.' : '',
    '--- MESSAGE START ---',
    input.text || '(see screenshot)',
    '--- MESSAGE END ---',
  ].filter(Boolean).join('\n');
}

export function normalizeVerdict(raw: unknown): Verdict {
  const v = (typeof raw === 'string' ? JSON.parse(raw.replace(/^```(?:json)?|```$/gm, '').trim()) : raw) as Partial<Verdict>;
  const score = Math.max(0, Math.min(100, Math.round(Number(v.risk_score ?? 50))));
  const level = (RISK_ENUM.includes(String(v.risk_level)) ? v.risk_level : score >= 70 ? 'high' : score >= 35 ? 'medium' : 'low') as Verdict['risk_level'];
  return {
    risk_score: score,
    risk_level: level,
    scam_type: (SCAM_ENUM.includes(String(v.scam_type)) ? v.scam_type : 'other') as Verdict['scam_type'],
    reasons: Array.isArray(v.reasons) ? v.reasons.slice(0, 4).map(String) : [],
    actions: Array.isArray(v.actions) ? v.actions.slice(0, 4).map(String) : [],
    confidence: Math.max(0, Math.min(1, Number(v.confidence ?? 0.5))),
  };
}

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const SCAM_TYPES = [
  'delivery', 'bank_impersonation', 'government_impersonation', 'family_impersonation',
  'investment', 'loan', 'prize_or_refund', 'romance', 'job', 'account_takeover',
  'marketplace', 'none', 'other',
] as const;
export type ScamType = (typeof SCAM_TYPES)[number];

export interface Verdict {
  risk_score: number; // 0-100
  risk_level: RiskLevel;
  scam_type: ScamType;
  reasons: string[];
  actions: string[];
  confidence: number; // 0-1
}

/** Where the verdict came from. `rules` = deterministic local rules only (offline / consent declined). */
export type Source = 'on_device' | 'in_cloud' | 'mock_on_device' | 'mock_in_cloud' | 'rules';

export interface CheckResult {
  verdict: Verdict;
  source: Source;
  sentText: string; // exactly what the model saw
  ms: number;
}

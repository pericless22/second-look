export type RiskLevel = 'low' | 'medium' | 'high';
export type ScamType =
  | 'delivery' | 'bank_impersonation' | 'government_impersonation' | 'family_impersonation'
  | 'investment' | 'loan' | 'prize_or_refund' | 'romance' | 'job' | 'account_takeover'
  | 'none' | 'other';

export interface Verdict {
  risk_score: number; // 0-100
  risk_level: RiskLevel;
  scam_type: ScamType;
  reasons: string[];
  actions: string[];
  confidence: number; // 0-1
}

export type Source = 'on_device' | 'in_cloud' | 'mock_on_device' | 'mock_in_cloud';

export interface CheckResult {
  verdict: Verdict;
  source: Source;
  sentText: string; // exactly what the model saw
  ms: number;
}

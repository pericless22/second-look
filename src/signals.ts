// Deterministic local red-flag detection (EN + KO). Always runs on-device.
// Used to prime the model prompt, as a safety floor under model verdicts,
// and as the scoring engine in mock mode / offline.
import type { MaskResult } from './pii.ts';
import type { ScamType } from './types.ts';

export interface Signal {
  id: string;
  weight: number;
  /** Critical signals are high risk on their own: model verdicts are never allowed to score below the floor. */
  critical?: boolean;
}

interface Rule extends Signal {
  test: RegExp | ((text: string) => boolean);
}

// ---------- verification-code (OTP) forwarding ----------
// "I sent my code to your number by mistake, can you forward it?" is an account-takeover
// attempt with no link, no money request and no urgency, so the generic rules barely notice it.
// It gets a dedicated, critical rule. Legit notices ("Your code is 123456. Do not share it.")
// must NOT match, so requests are only counted when they are not negated.
const CODE_EN = String.raw`\b(?:code|otp|passcode)\b`;
const OTP_REQUESTS_EN = [
  // forward / send / tell me the (6-digit) code
  new RegExp(String.raw`\b(?:forward|send|text|tell|give|read|pass|relay|share|message)\s+(?:it\s+|that\s+)?(?:(?:back\s+)?to\s+)?(?:me|us)\b[^.!?\n]{0,40}?${CODE_EN}`, 'gi'),
  // share the code you received / send the code back
  new RegExp(String.raw`\b(?:forward|send|text|tell|give|read|pass|relay|share)\b[^.!?\n]{0,30}?${CODE_EN}[^.!?\n]{0,30}?\b(?:to me|with me|back|you (?:just )?(?:got|received))\b`, 'gi'),
  // what's the code?
  new RegExp(String.raw`\bwhat(?:'s| is| was)\s+the\s+(?:[\w-]+\s+){0,2}${CODE_EN}`, 'gi'),
  // "I accidentally sent my verification code to your number"
  new RegExp(String.raw`\bI\b[^.!?\n]{0,30}\b(?:accidentally|mistakenly|by mistake)\b[^.!?\n]{0,60}${CODE_EN}`, 'gi'),
];
const NEGATED_BEFORE_EN = /\b(?:do not|don'?t|never|not|won'?t|shouldn'?t)\b[^.!?\n]{0,25}$/i;

const CODE_KO = String.raw`(?:인증\s?번호|인증\s?코드|보안\s?코드|승인\s?번호|otp|\d\s?자리\s?(?:숫자|번호|코드)|코드)`;
const ASK_KO = String.raw`(?:알려|불러|보내|전달해|말해|찍어|캡처해)\s?(?:줘|주세요|주실|주시|주십|줄래|줄\s?수|달라|주면|주라)`;
const OTP_REQUESTS_KO = [
  // 인증번호 좀 알려주세요 / 보내줘
  new RegExp(String.raw`${CODE_KO}[^.!?\n]{0,40}?${ASK_KO}`, 'gi'),
  // 인증번호를 그쪽 번호로 잘못 보냈어요
  new RegExp(String.raw`${CODE_KO}[^.!?\n]{0,30}?(?:잘못|실수로)\s?(?:보냈|보내|갔|전송|발송)`, 'gi'),
];
const NEGATED_AFTER_KO = /^[^.!?\n]{0,10}(?:안\s?(?:됩|돼|되)|마세요|마십시오|금지)/;

/** True when the message asks the reader to pass on a verification code they received. */
export function asksForOtp(text: string): boolean {
  for (const re of OTP_REQUESTS_EN) {
    for (const m of text.matchAll(re)) {
      if (!NEGATED_BEFORE_EN.test(text.slice(Math.max(0, m.index - 40), m.index))) return true;
    }
  }
  for (const re of OTP_REQUESTS_KO) {
    for (const m of text.matchAll(re)) {
      if (!NEGATED_AFTER_KO.test(text.slice(m.index + m[0].length))) return true;
    }
  }
  return false;
}

// ---------- rule table ----------
const RULES: Rule[] = [
  { id: 'otp_forward', weight: 60, critical: true, test: asksForOtp },
  { id: 'urgency', weight: 15, test: /urgent|immediately|within 24 ?h|today only|final notice|act now|expire|suspend|긴급|즉시|오늘 ?중|마감|정지|차단|만료/i },
  { id: 'money_request', weight: 20, test: /send money|wire|transfer|gift ?card|pay (a|the)? ?fee|deposit|bitcoin|crypto|송금|입금|이체|결제|수수료|상품권|코인/i },
  // Bare "verification code" / "인증번호" is deliberately absent: services send those legitimately. See otp_forward.
  { id: 'credential_request', weight: 20, test: /password|verify your (account|identity)|login|ssn|social security|(forward|send|tell) me the .{0,20}code|신분증|카드 ?앞뒤|비밀번호|본인 ?인증|주민(등록)?번호|공인인증|보안카드/i },
  { id: 'impersonation_family', weight: 20, test: /\b(mom|dad|it'?s me)\b.*(new (phone|number)|broke|dropped my phone)|(엄마|아빠|딸|아들).*(폰|핸드폰|휴대폰).*(고장|깨졌|깨져|액정|수리)|(폰|휴대폰).*(고장|파손|액정)/i },
  { id: 'impersonation_authority', weight: 15, test: /police|irs|court|prosecutor|tax office|government|검찰|지검|수사관|안전 ?계좌|명의.{0,6}도용|경찰|법원|국세청|금감원|금융감독원|건강보험|국민연금/i },
  { id: 'impersonation_bank', weight: 12, test: /bank|card (company|issuer)|paypal|국민은행|신한|우리은행|하나은행|농협|카드사|토스|카카오뱅크/i },
  { id: 'delivery_lure', weight: 12, test: /package|parcel|delivery|redeliver|shipment|customs|택배|배송|주소지 ?불명|반송|통관/i },
  { id: 'prize_refund', weight: 12, test: /won|winner|prize|refund|reward|cashback|당첨|환급|지원금|보상금|경품/i },
  { id: 'investment', weight: 20, test: /guaranteed (return|profit)|double your|investment|stock tip|리딩방|수익 ?보장|고수익|원금 ?보장|급등주/i },
  { id: 'loan', weight: 12, test: /low[- ]interest loan|pre-?approved|대출|저금리|대환|한도 ?조회/i },
  { id: 'app_install', weight: 15, test: /install (the )?app|download (the )?app|apk|remote (access|support)|teamviewer|anydesk|앱 ?설치|원격|어플 ?설치/i },
  { id: 'secrecy', weight: 10, test: /don'?t tell|keep (this|it) (secret|between us)|비밀로|말하지 ?마/i },
  { id: 'job_easy_money', weight: 20, test: /work from home|earn \$\d+ (per|a) day|easy money|no experience|like (youtube )?videos|part[- ]time.*(daily|per day)|부업|재택|일당|고액 ?알바/i },
  { id: 'off_platform_contact', weight: 10, test: /whatsapp|telegram|카톡 ?id|텔레그램|오픈 ?채팅/i },
  { id: 'tech_support', weight: 20, test: /infected|virus|malware|your (pc|computer) (is|has)|바이러스|해킹(당|되)/i },
  { id: 'wrong_number_opener', weight: 25, test: /wrong number|is this still your number|잘못 보냈|번호 바뀌/i },
  { id: 'event_lure', weight: 20, test: /부고|별세|청첩장|결혼합니다|모바일 ?초대장|obituary|wedding invitation/i },
  { id: 'third_party_account', weight: 15, test: /(동생|친구|지인|다른) ?계좌|friend'?s account|빌려|lend me/i },
];

const URL_FLAG_WEIGHT: Record<string, number> = {
  shortened_link: 15, raw_ip_address: 20, punycode_lookalike: 25, high_risk_tld: 15,
  brand_impersonation: 25, no_https: 5, many_hyphens: 5, unknown_domain: 5,
};

const PII_SIGNALS: Signal[] = [
  { id: 'contains_account_number', weight: 10 },
  { id: 'contains_rrn', weight: 10 },
];

/** Every signal id that localSignals() can emit (used to verify translations exist). */
export const SIGNAL_IDS: string[] = [
  ...RULES.map((r) => r.id),
  ...Object.keys(URL_FLAG_WEIGHT).map((f) => `url_${f}`),
  ...PII_SIGNALS.map((s) => s.id),
];

export function localSignals(text: string, mask: MaskResult): Signal[] {
  const out: Signal[] = RULES
    .filter((r) => (typeof r.test === 'function' ? r.test(text) : r.test.test(text)))
    .map(({ id, weight, critical }) => (critical ? { id, weight, critical } : { id, weight }));
  const urlFlags = new Set(mask.urls.flatMap((u) => u.flags));
  for (const f of urlFlags) out.push({ id: `url_${f}`, weight: URL_FLAG_WEIGHT[f] ?? 5 });
  if (mask.findings.some((f) => f.type === 'ACCOUNT')) out.push(PII_SIGNALS[0]);
  if (mask.findings.some((f) => f.type === 'RRN')) out.push(PII_SIGNALS[1]);
  return out;
}

export function guessScamType(ids: string[]): ScamType {
  const has = (s: string) => ids.includes(s);
  if (has('otp_forward')) return 'account_takeover';
  if (has('impersonation_family')) return 'family_impersonation';
  if (has('impersonation_authority')) return 'government_impersonation';
  if (has('investment')) return 'investment';
  if (has('loan')) return 'loan';
  if (has('delivery_lure')) return 'delivery';
  if (has('impersonation_bank')) return 'bank_impersonation';
  if (has('prize_refund')) return 'prize_or_refund';
  if (has('job_easy_money')) return 'job';
  if (has('credential_request')) return 'account_takeover';
  if (has('wrong_number_opener')) return 'romance';
  return ids.length ? 'other' : 'none';
}

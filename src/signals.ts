// Deterministic local red-flag detection (EN + KO). Always runs on-device.
// Used to prime the model prompt and as the scoring engine in mock mode.
import type { MaskResult } from './pii.ts';
import type { ScamType } from './types.ts';

export interface Signal { id: string; weight: number; }

const RULES: { id: string; weight: number; re: RegExp }[] = [
  { id: 'urgency', weight: 15, re: /urgent|immediately|within 24 ?h|today only|final notice|act now|expire|suspend|긴급|즉시|오늘 ?중|마감|정지|차단|만료/i },
  { id: 'money_request', weight: 20, re: /send money|wire|transfer|gift ?card|pay (a|the)? ?fee|deposit|bitcoin|crypto|송금|입금|이체|결제|수수료|상품권|코인/i },
  { id: 'credential_request', weight: 20, re: /password|verify your (account|identity)|login|ssn|social security|otp|(forward|send|tell) me the .{0,20}code|신분증|카드 ?앞뒤|비밀번호|인증번호|본인 ?인증|주민(등록)?번호|공인인증|보안카드/i },
  { id: 'impersonation_family', weight: 20, re: /\b(mom|dad|it'?s me)\b.*(new (phone|number)|broke|dropped my phone)|(엄마|아빠|딸|아들).*(폰|핸드폰|휴대폰).*(고장|깨졌|깨져|액정|수리)|(폰|휴대폰).*(고장|파손|액정)/i },
  { id: 'impersonation_authority', weight: 15, re: /police|irs|court|prosecutor|tax office|government|검찰|지검|수사관|안전 ?계좌|명의.{0,6}도용|경찰|법원|국세청|금감원|금융감독원|건강보험|국민연금/i },
  { id: 'impersonation_bank', weight: 12, re: /bank|card (company|issuer)|paypal|국민은행|신한|우리은행|하나은행|농협|카드사|토스|카카오뱅크/i },
  { id: 'delivery_lure', weight: 12, re: /package|parcel|delivery|redeliver|shipment|customs|택배|배송|주소지 ?불명|반송|통관/i },
  { id: 'prize_refund', weight: 12, re: /won|winner|prize|refund|reward|cashback|당첨|환급|지원금|보상금|경품/i },
  { id: 'investment', weight: 20, re: /guaranteed (return|profit)|double your|investment|stock tip|리딩방|수익 ?보장|고수익|원금 ?보장|급등주/i },
  { id: 'loan', weight: 12, re: /low[- ]interest loan|pre-?approved|대출|저금리|대환|한도 ?조회/i },
  { id: 'app_install', weight: 15, re: /install (the )?app|download (the )?app|apk|remote (access|support)|teamviewer|anydesk|앱 ?설치|원격|어플 ?설치/i },
  { id: 'secrecy', weight: 10, re: /don'?t tell|keep (this|it) (secret|between us)|비밀로|말하지 ?마/i },
  { id: 'job_easy_money', weight: 20, re: /work from home|earn \$\d+ (per|a) day|easy money|no experience|like (youtube )?videos|part[- ]time.*(daily|per day)|부업|재택|일당|고액 ?알바/i },
  { id: 'off_platform_contact', weight: 10, re: /whatsapp|telegram|카톡 ?id|텔레그램|오픈 ?채팅/i },
  { id: 'tech_support', weight: 20, re: /infected|virus|malware|your (pc|computer) (is|has)|바이러스|해킹(당|되)/i },
  { id: 'wrong_number_opener', weight: 25, re: /wrong number|is this still your number|잘못 보냈|번호 바뀌/i },
  { id: 'event_lure', weight: 20, re: /부고|별세|청첩장|결혼합니다|모바일 ?초대장|obituary|wedding invitation/i },
  { id: 'third_party_account', weight: 15, re: /(동생|친구|지인|다른) ?계좌|friend'?s account|빌려|lend me/i },
];

const URL_FLAG_WEIGHT: Record<string, number> = {
  shortened_link: 15, raw_ip_address: 20, punycode_lookalike: 25, high_risk_tld: 15,
  brand_impersonation: 25, no_https: 5, many_hyphens: 5, unknown_domain: 5,
};

export function localSignals(text: string, mask: MaskResult): Signal[] {
  const out: Signal[] = RULES.filter((r) => r.re.test(text)).map(({ id, weight }) => ({ id, weight }));
  const urlFlags = new Set(mask.urls.flatMap((u) => u.flags));
  for (const f of urlFlags) out.push({ id: `url_${f}`, weight: URL_FLAG_WEIGHT[f] ?? 5 });
  if (mask.findings.some((f) => f.type === 'ACCOUNT')) out.push({ id: 'contains_account_number', weight: 10 });
  if (mask.findings.some((f) => f.type === 'RRN')) out.push({ id: 'contains_rrn', weight: 10 });
  return out;
}

export function guessScamType(ids: string[]): ScamType {
  const has = (s: string) => ids.includes(s);
  if (has('impersonation_family')) return 'family_impersonation';
  if (has('impersonation_authority')) return 'government_impersonation';
  if (has('investment')) return 'investment';
  if (has('loan')) return 'loan';
  if (has('delivery_lure')) return 'delivery';
  if (has('impersonation_bank')) return 'bank_impersonation';
  if (has('prize_refund')) return 'prize_or_refund';
  if (has('job_easy_money')) return 'job';
  if (has('credential_request')) return 'account_takeover';
  return ids.length ? 'other' : 'none';
}

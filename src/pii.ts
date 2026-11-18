// On-device PII masking. Runs entirely in the browser (plain regex, no model),
// so it works offline and before any text could ever reach the cloud.
//
// NOT detected: names, street addresses and free-text identifiers (usernames, order notes, etc.).
// Only structured numbers and emails are masked, so a name in the message still reaches the cloud.

export type PiiType = 'RRN' | 'CARD' | 'PHONE' | 'ACCOUNT' | 'EMAIL' | 'ID' | 'CODE';

export interface PiiFinding {
  type: PiiType;
  original: string;
  token: string;
  start: number;
  end: number;
}

export interface UrlFinding {
  url: string;
  host: string;
  flags: string[];
}

export interface MaskResult {
  masked: string;
  findings: PiiFinding[];
  urls: UrlFinding[];
}

const RISKY_TLDS = ['xyz', 'top', 'info', 'site', 'online', 'shop', 'link', 'click', 'tk', 'cc', 'icu', 'buzz'];
// One shared TLD list: bare domains (no http) are only recognised for these, and it always includes every risky TLD.
const LINK_TLDS = [...new Set(['com', 'net', 'org', 'kr', 'co.kr', 'me', 'ly', 'io', 'app', 'do', 'la', 'gl', 'to', 'gg', 'at', 'im', ...RISKY_TLDS])];
const TLD_ALT = LINK_TLDS.sort((a, b) => b.length - a.length).map((t) => t.replace(/\./g, '\\.')).join('|');
const URL_RE = new RegExp(String.raw`\b(?:https?:\/\/|www\.)[^\s<>"'）)]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:${TLD_ALT})\b(?:\/[^\s<>"']*)?`, 'gi');
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const luhn = (s: string): boolean => {
  let sum = 0;
  let dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (dbl && (d *= 2) > 9) d -= 9;
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
};
const digitCount = (s: string) => s.replace(/\D/g, '').length;
const CODE_WORDS = String.raw`(?:\b(?:code|passcode|otp|pin)|인증번호|인증코드|승인번호)`;
const CURRENCY = String.raw`$₩€£¥`;

// type null = protected span only (dates): claimed so later patterns leave it alone, but never reported.
interface Pattern {
  type: PiiType | null;
  re: RegExp;
  test?: (match: string) => boolean;
  /** Fallback numbers: PHONE when they start with + or 0, or a 1 country code plus separator; otherwise ACCOUNT. */
  phoneLike?: boolean;
}

// Order matters: more specific patterns first so they claim their spans.
const PATTERNS: Pattern[] = [
  // Verification code right after a code word (mask only the digits): "code: 482913", "OTP is [482913]", "인증번호 482913"
  { type: 'CODE', re: new RegExp(String.raw`(?<=${CODE_WORDS}(?:\s*(?:is|:|：|=))?\s*[\[(【]?\s*)\d{4,8}(?!\d|[-.]\d)`, 'gi') },
  // Korean resident registration number (주민등록번호): YYMMDD-GNNNNNN
  { type: 'RRN', re: /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\s?-?\s?[1-8]\d{6}(?!\d)/g },
  // US SSN: 123-45-6789 / 123 45 6789, or 9 digits right after an ssn / social security keyword
  { type: 'ID', re: /(?<![\d-])\d{3}[ -]\d{2}[ -]\d{4}(?![\d-])/g },
  { type: 'ID', re: /(?<=\b(?:ssn|social security(?: number)?)\s*(?:is|:|#|=|-)?\s*)\d{9}(?!\d)/gi },
  // Payment card: 16 digits in groups of 4, Amex 4-6-5, or 15-16 plain digits that pass a Luhn check
  { type: 'CARD', re: /(?<!\d)\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}(?!\d)/g },
  { type: 'CARD', re: /(?<!\d)\d{4}[ -]\d{6}[ -]\d{5}(?!\d)/g },
  { type: 'CARD', re: /(?<!\d)\d{15,16}(?!\d)/g, test: luhn },
  { type: 'EMAIL', re: EMAIL_RE },
  // Phones: KR mobile/landline/rep numbers, +82, US/intl formats
  {
    type: 'PHONE',
    re: /(?<![\d-])(?:\+?82[ -]?1[016789][ -]?\d{3,4}[ -]?\d{4}|0(?:1[016789]|2|[3-6][1-5]|70|50\d?)[ .-]?\d{3,4}[ .-]?\d{4}|1[5-9]\d{2}-\d{4}|\+?1[ .-]?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}|\(\d{3}\)\s?\d{3}[ .-]?\d{4}|\d{3}[ .-]\d{3}[ .-]\d{4}|\+\d{1,3}[ -]\d{2,4}[ -]\d{3,4}[ -]\d{3,4})(?![\d-])/g,
  },
  // International: +44 7911 123456, +33 6 12 34 56 78, +81-90-1234-5678, +14155550134
  { type: 'PHONE', re: /(?<![\d-])\+\d{1,3}(?:[ .-]\(?\d{1,6}\)?){1,5}(?![\d-])/g, test: (m) => digitCount(m) >= 8 && digitCount(m) <= 15 },
  { type: 'PHONE', re: /(?<![\d-])\+\d{8,15}(?!\d)/g },
  // Dates are protected (never masked): 2026-11-20, 2026.11.20, 11/20/2026, 20261120
  { type: null, re: /(?<![\d-])(?:19|20)\d{2}[-./](?:0?[1-9]|1[0-2])[-./](?:0?[1-9]|[12]\d|3[01])(?!\d|-\d)/g },
  { type: null, re: /(?<![\d-])(?:0?[1-9]|1[0-2])[-./](?:0?[1-9]|[12]\d|3[01])[-./](?:19|20)\d{2}(?!\d)/g },
  { type: null, re: /(?<!\d)(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?!\d)/g },
  // Bank accounts: 10-16 digits, optionally hyphenated (e.g. 110-123-456789, 1002-345-678901)
  { type: 'ACCOUNT', re: /(?<![\d-])\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,4})?(?![\d-])|(?<!\d)\d{10,16}(?!\d)/g },
  // Fallback: any other run of 7+ digits (single space/dot/hyphen separators allowed). Money ($1,250.00) and short numbers stay.
  {
    type: 'ACCOUNT',
    // Not after a digit or currency sign, nor after a digit plus separator (the middle of 1,234,567); "No.1234567" is fine.
    re: new RegExp(String.raw`(?<![\d${CURRENCY}]|\d[.,-])\+?\d+(?:[ .-]\d+)*(?!\d|\s?(?:원|만원|달러|won(?!['’])\b|dollars?\b|usd\b|krw\b))`, 'gi'),
    // Decimals such as "12345.67" are amounts, not account numbers.
    test: (m) => digitCount(m) >= 7 && !/^\d+\.\d{1,2}$/.test(m),
    phoneLike: true,
  },
];

const SHORTENERS = ['bit.ly', 'tinyurl.com', 'han.gl', 'me2.do', 'url.kr', 'vo.la', 't.ly', 'is.gd', 'goo.gl', 'ow.ly', 'buly.kr', 'cutt.ly', 'rebrand.ly', 'shorturl.at'];
const BRANDS = ['naver', 'kakao', 'toss', 'coupang', 'paypal', 'amazon', 'apple', 'google', 'usps', 'fedex', 'dhl', 'cjlogistics', 'epost', 'kbstar', 'shinhan', 'wooribank', 'hanabank', 'nhis', 'hometax', 'police', 'netflix', 'microsoft'];
const OFFICIAL = ['amazonaws.com', 'googleapis.com', 'googleusercontent.com', 'naver.me', 'apple.co', 'naver.com', 'kakao.com', 'toss.im', 'coupang.com', 'paypal.com', 'amazon.com', 'apple.com', 'google.com', 'usps.com', 'fedex.com', 'dhl.com', 'cjlogistics.com', 'epost.go.kr', 'kbstar.com', 'shinhan.com', 'wooribank.com', 'hanabank.com', 'nhis.or.kr', 'hometax.go.kr', 'police.go.kr', 'netflix.com', 'microsoft.com'];

/**
 * Brand names are matched per label (split on . and -, digits stripped): a label that is the brand or starts
 * with it ("paypal-secure", "naverlogin"), never a brand buried inside a word ("pineapple").
 */
const brandLabels = (s: string) => s.toLowerCase().split(/[.\-:]/).map((l) => l.replace(/\d/g, ''));

export function analyzeUrl(raw: string): UrlFinding {
  const s = raw.replace(/[.,!?;:]+$/, '');
  const withProto = /^https?:\/\//i.test(s) ? s : `http://${s}`;
  let host = '';
  try {
    host = new URL(withProto).hostname.toLowerCase();
  } catch {
    host = s.toLowerCase();
  }
  // user@host before the real host: http://paypal.com@evil.top/login
  const authority = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)/i.exec(s)?.[1] ?? '';
  const at = authority.lastIndexOf('@');
  const userinfo = at >= 0 ? authority.slice(0, at) : '';
  const flags: string[] = [];
  if (SHORTENERS.some((d) => host === d || host.endsWith('.' + d))) flags.push('shortened_link');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) flags.push('raw_ip_address');
  if (host.startsWith('xn--') || host.includes('.xn--')) flags.push('punycode_lookalike');
  if (userinfo) flags.push('userinfo_trick');
  const tld = host.split('.').pop() ?? '';
  if (RISKY_TLDS.includes(tld)) flags.push('high_risk_tld');
  const isOfficial = OFFICIAL.some((d) => host === d || host.endsWith('.' + d));
  const labels = [...brandLabels(host), ...brandLabels(userinfo)];
  // Also join hyphenated parts so "pay-pal" and "kb-star" still read as the brand.
  const joined = [host, userinfo].map((x) => x.toLowerCase().replace(/\d/g, '').split('.').map((l) => l.replace(/-/g, ''))).flat();
  const looksLike = (l: string) => BRANDS.some((b) => l === b || l.startsWith(b));
  if (!isOfficial && (labels.some(looksLike) || joined.some(looksLike))) flags.push('brand_impersonation');
  if (/^http:\/\//i.test(s)) flags.push('no_https');
  if ((host.match(/-/g) ?? []).length >= 2) flags.push('many_hyphens');
  if (flags.length === 0 && !isOfficial) flags.push('unknown_domain');
  return { url: s, host, flags };
}

export function maskPII(text: string): MaskResult {
  const findings: PiiFinding[] = [];
  // Claimed spans are blanked in a scratch copy, so a later pattern can't match across them and a
  // number next to a claimed span (a date, a URL host) is still found on its own.
  let scratch = text;
  const claim = (start: number, end: number) => {
    scratch = scratch.slice(0, start) + '\u0000'.repeat(end - start) + scratch.slice(end);
  };
  const add = (type: PiiType, start: number, end: number) => {
    findings.push({ type, original: text.slice(start, end), token: '', start, end });
  };

  // Only a link's scheme + host part is protected (flagged, not masked). Its path and query go through the
  // same patterns as the rest of the text, so an email or phone number inside a link is still masked.
  const emailSpans: [number, number][] = [];
  for (const m of text.matchAll(EMAIL_RE)) emailSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const urls: UrlFinding[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    // The whole thing is an email ("jane@example.com"), or a bare domain that is part of one ("jane@example.com/x").
    if (emailSpans.some(([s, e]) => s === start || (!/^(?:https?:\/\/|www\.)/i.test(m[0]) && start > s && start < e))) continue;
    // "http://a.com,전화:…": a comma followed by non-ASCII text ends the link.
    const raw = m[0].replace(/[,，][^\x00-\x7F][\s\S]*$/, '');
    urls.push(analyzeUrl(raw));
    const authority = /^(?:https?:\/\/)?(?:[^/?#@\s]*@)?[a-z0-9.-]+(?::\d+)?/i.exec(raw)?.[0] ?? raw;
    claim(start, start + authority.length);
  }

  for (const { type, re, test, phoneLike } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of scratch.matchAll(re)) {
      if (test && !test(m[0])) continue;
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (m[0].includes('\u0000')) continue;
      claim(start, end);
      if (!type) continue;
      const isPhone = phoneLike && /^(?:\+|0|1[ .-])/.test(m[0]);
      add(isPhone ? 'PHONE' : type, start, end);
    }
  }

  // Number tokens in reading order per type.
  findings.sort((a, b) => a.start - b.start);
  const counters: Record<PiiType, number> = { RRN: 0, CARD: 0, PHONE: 0, ACCOUNT: 0, EMAIL: 0, ID: 0, CODE: 0 };
  let masked = '';
  let cursor = 0;
  for (const f of findings) {
    counters[f.type] += 1;
    f.token = `[${f.type}_${counters[f.type]}]`;
    masked += text.slice(cursor, f.start) + f.token;
    cursor = f.end;
  }
  masked += text.slice(cursor);
  return { masked, findings, urls };
}

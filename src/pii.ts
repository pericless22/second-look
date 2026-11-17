// On-device PII masking. Runs entirely in the browser (plain regex, no model),
// so it works offline and before any text could ever reach the cloud.

export type PiiType = 'RRN' | 'CARD' | 'PHONE' | 'ACCOUNT' | 'EMAIL';

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

// Order matters: more specific patterns first so they claim their spans.
const PATTERNS: { type: PiiType; re: RegExp }[] = [
  // Korean resident registration number (주민등록번호): YYMMDD-GNNNNNN
  { type: 'RRN', re: /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\s?-?\s?[1-8]\d{6}(?!\d)/g },
  // Payment card: 16 digits in groups of 4
  { type: 'CARD', re: /(?<!\d)\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}(?!\d)/g },
  { type: 'EMAIL', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // Phones: KR mobile/landline/rep numbers, +82, US/intl formats
  {
    type: 'PHONE',
    re: /(?<![\d-])(?:\+?82[ -]?1[016789][ -]?\d{3,4}[ -]?\d{4}|0(?:1[016789]|2|[3-6][1-5]|70|50\d?)[ -.]?\d{3,4}[ -.]?\d{4}|1[5-9]\d{2}-\d{4}|\+?1[ -.]?\(?\d{3}\)?[ -.]?\d{3}[ -.]?\d{4}|\(\d{3}\)\s?\d{3}-\d{4}|\+\d{1,3}[ -]\d{2,4}[ -]\d{3,4}[ -]\d{3,4})(?![\d-])/g,
  },
  // Bank accounts: 10-16 digits, optionally hyphenated (e.g. 110-123-456789, 1002-345-678901)
  { type: 'ACCOUNT', re: /(?<![\d-])\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,4})?(?![\d-])|(?<!\d)\d{10,16}(?!\d)/g },
];

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'）)]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|kr|co\.kr|me|ly|io|xyz|top|info|site|online|shop|link|click|app|cc|tk|do|la|gl|to|gg|at|im)\b(?:\/[^\s<>"']*)?/gi;

const SHORTENERS = ['bit.ly', 'tinyurl.com', 'han.gl', 'me2.do', 'url.kr', 'vo.la', 't.ly', 'is.gd', 'goo.gl', 'ow.ly', 'buly.kr', 'cutt.ly', 'rebrand.ly', 'shorturl.at'];
const RISKY_TLDS = ['xyz', 'top', 'info', 'site', 'online', 'shop', 'link', 'click', 'tk', 'cc', 'icu', 'buzz'];
const BRANDS = ['naver', 'kakao', 'toss', 'coupang', 'paypal', 'amazon', 'apple', 'google', 'usps', 'fedex', 'dhl', 'cjlogistics', 'epost', 'kbstar', 'shinhan', 'wooribank', 'hanabank', 'nhis', 'hometax', 'police', 'netflix', 'microsoft'];
const OFFICIAL = ['naver.com', 'kakao.com', 'toss.im', 'coupang.com', 'paypal.com', 'amazon.com', 'apple.com', 'google.com', 'usps.com', 'fedex.com', 'dhl.com', 'cjlogistics.com', 'epost.go.kr', 'kbstar.com', 'shinhan.com', 'wooribank.com', 'hanabank.com', 'nhis.or.kr', 'hometax.go.kr', 'police.go.kr', 'netflix.com', 'microsoft.com'];

export function analyzeUrl(raw: string): UrlFinding {
  let s = raw.replace(/[.,!?;:]+$/, '');
  const withProto = /^https?:\/\//i.test(s) ? s : `http://${s}`;
  let host = '';
  try {
    host = new URL(withProto).hostname.toLowerCase();
  } catch {
    host = s.toLowerCase();
  }
  const flags: string[] = [];
  if (SHORTENERS.some((d) => host === d || host.endsWith('.' + d))) flags.push('shortened_link');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) flags.push('raw_ip_address');
  if (host.startsWith('xn--') || host.includes('.xn--')) flags.push('punycode_lookalike');
  const tld = host.split('.').pop() ?? '';
  if (RISKY_TLDS.includes(tld)) flags.push('high_risk_tld');
  const isOfficial = OFFICIAL.some((d) => host === d || host.endsWith('.' + d));
  if (!isOfficial && BRANDS.some((b) => host.replace(/[-0-9]/g, '').includes(b))) flags.push('brand_impersonation');
  if (/^http:\/\//i.test(s)) flags.push('no_https');
  if ((host.match(/-/g) ?? []).length >= 2) flags.push('many_hyphens');
  if (flags.length === 0 && !isOfficial) flags.push('unknown_domain');
  return { url: s, host, flags };
}

export function maskPII(text: string): MaskResult {
  const taken: [number, number][] = [];
  const findings: PiiFinding[] = [];
  const overlaps = (a: number, b: number) => taken.some(([s, e]) => a < e && b > s);

  // URLs are protected spans (not masked; flagged instead) so digits inside them are not masked.
  // Emails are claimed first so their domain part isn't mistaken for a link.
  const emailSpans: [number, number][] = [];
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    emailSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  const inEmail = (a: number, b: number) => emailSpans.some(([s, e]) => a < e && b > s);
  const urls: UrlFinding[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    if (inEmail(start, start + m[0].length)) continue;
    taken.push([start, start + m[0].length]);
    urls.push(analyzeUrl(m[0]));
  }

  const counters: Record<PiiType, number> = { RRN: 0, CARD: 0, PHONE: 0, ACCOUNT: 0, EMAIL: 0 };
  for (const { type, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      taken.push([start, end]);
      counters[type] += 1;
      findings.push({ type, original: m[0], token: `[${type}_${counters[type]}]`, start, end });
    }
  }

  findings.sort((a, b) => a.start - b.start);
  let masked = '';
  let cursor = 0;
  for (const f of findings) {
    masked += text.slice(cursor, f.start) + f.token;
    cursor = f.end;
  }
  masked += text.slice(cursor);
  return { masked, findings, urls };
}

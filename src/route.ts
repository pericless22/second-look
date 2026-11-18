// The routing and privacy decisions behind one check, without any DOM. main.ts renders the outcome.
// Kept pure (engine and consent are injected) so the central promise can be tested:
// raw text only ever goes to the ONLY_ON_DEVICE path; everything else gets the masked text.
import { maskPII, type MaskResult } from './pii.ts';
import { localSignals, type Signal } from './signals.ts';
import { supportedOnDevice } from './lang.ts';
import { rulesVerdict } from './rules.ts';
import type { CheckInput, Engine, ImageInput, OnDeviceStatus } from './engine.ts';
import type { CheckResult } from './types.ts';

export const MAX_TEXT_CHARS = 4000;

export type CloudWhy = 'lang' | 'nomodel' | 'image' | 'second';

export type Route =
  | { kind: 'private' }
  | { kind: 'cloud'; why: CloudWhy; sentImage: boolean }
  | { kind: 'declined' }
  | { kind: 'offline' }
  /**
   * The model call failed; the verdict comes from the local rules. `error` is an i18n key.
   * `attempted: 'cloud'` means the request went out after consent, so data may have left the device.
   */
  | { kind: 'failed'; error: string; detail: string; attempted: 'device' | 'cloud'; sentImage: boolean };

export type Plan =
  | { kind: 'private' }
  | { kind: 'offline' }
  | { kind: 'cloud'; why: Exclude<CloudWhy, 'second'>; mode: 'hybrid' | 'cloud' };

/**
 * Where a check may run.
 * - Raw text goes on-device only when Nano is ready and can read the message's language.
 * - A screenshot with no text has an unknown language, so it never takes the private path
 *   (Nano could be handed a Korean screenshot it can't read). It goes to the cloud, with consent.
 * - Masked text uses PREFER_ON_DEVICE only when the language is one Nano reads; otherwise ONLY_IN_CLOUD.
 */
export function decideRoute(o: { status: OnDeviceStatus; lang: string | null; online: boolean }): Plan {
  const langOk = o.lang !== null && supportedOnDevice(o.lang);
  if (o.status === 'available' && langOk) return { kind: 'private' };
  if (!o.online) return { kind: 'offline' };
  if (o.lang === null) return { kind: 'cloud', why: 'image', mode: 'cloud' };
  return langOk ? { kind: 'cloud', why: 'nomodel', mode: 'hybrid' } : { kind: 'cloud', why: 'lang', mode: 'cloud' };
}

/** Turns an SDK / network error into an i18n key for a plain-language message. */
export function friendlyError(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  // Chrome's Prompt API reports an over-long input as QuotaExceededError: check it before rate limits.
  if (name === 'QuotaExceededError' || /too (long|large)|exceeds|input.*(limit|size)|quotaexceeded/.test(msg)) return 'err.too_long';
  if (msg === 'offline' || /failed to fetch|networkerror|network error|err_internet/.test(msg)) return 'err.network';
  if (/\b429\b|quota|resource.?exhausted|rate.?limit/.test(msg)) return 'err.quota';
  if (/\b40[13]\b|app.?check|permission|unauthori[sz]ed|api key/.test(msg)) return 'err.denied';
  return 'err.model';
}

export interface CheckDeps {
  engine: Engine;
  online: () => boolean;
  uiLang: string;
  detectLanguage: (text: string) => Promise<string>;
  /** Shows the consent dialog with exactly what would be sent. Resolves true when the user agrees. */
  askConsent: (mask: MaskResult, why: CloudWhy, lang: string | null, withImage: boolean) => Promise<boolean>;
  /** Called after consent, right before the cloud request (UI shows a spinner). */
  onCloudStart?: () => void;
}

export interface Outcome {
  /** Undefined when nothing can be shown (a screenshot with no text and no model). */
  result?: CheckResult;
  route: Route;
  mask: MaskResult;
  signals: Signal[];
  lang: string | null;
  /** Exactly what was handed to the model (raw text on the private path, masked text otherwise). */
  sent?: CheckInput;
}

export function rulesOnly(text: string, signals: Signal[], uiLang: string): CheckResult {
  return { verdict: rulesVerdict(signals, uiLang), source: 'rules', sentText: text, ms: 0, lang: uiLang };
}

export async function runCheck(text: string, image: ImageInput | undefined, deps: CheckDeps): Promise<Outcome> {
  const { engine, uiLang } = deps;
  const mask = maskPII(text);
  const signals = localSignals(text, mask);
  const lang = text ? await deps.detectLanguage(text) : null;
  const status = await engine.onDeviceStatus(!!image);
  const plan = decideRoute({ status, lang, online: deps.online() });
  const base = { mask, signals, lang };
  // Without a model nothing can read a screenshot, so never report "looks OK" for one.
  const local = (route: Route): Outcome => ({ ...base, route, result: text ? rulesOnly(text, signals, uiLang) : undefined });
  const failed = (e: unknown, attempted: 'device' | 'cloud'): Outcome => {
    console.warn('Model call failed, showing local rules instead:', e);
    return local({ kind: 'failed', error: friendlyError(e), detail: e instanceof Error ? e.message : String(e), attempted, sentImage: attempted === 'cloud' && !!image });
  };

  if (plan.kind === 'private') {
    const sent: CheckInput = { text, image, lang: lang ?? 'en', outLang: uiLang, signals };
    try {
      return { ...base, sent, route: { kind: 'private' }, result: await engine.privateCheck(sent) };
    } catch (e) {
      return failed(e, 'device');
    }
  }
  if (plan.kind === 'offline') return local({ kind: 'offline' });

  if (!(await deps.askConsent(mask, plan.why, lang, !!image))) return local({ kind: 'declined' });
  deps.onCloudStart?.();
  const sent: CheckInput = { text: mask.masked, image, lang: lang ?? 'und', outLang: uiLang, signals };
  try {
    const result = plan.mode === 'hybrid' ? await engine.hybridCheck(sent) : await engine.cloudCheck(sent);
    return { ...base, sent, result, route: { kind: 'cloud', why: plan.why, sentImage: !!image } };
  } catch (e) {
    return failed(e, 'cloud');
  }
}

/**
 * Cloud second opinion on an earlier result (after consent, which the caller asks for).
 * Like runCheck, it only ever hands the model the masked text.
 */
export function secondOpinion(engine: Engine, prev: { mask: MaskResult; signals: Signal[]; lang: string | null; image?: ImageInput }, uiLang: string) {
  return engine.cloudCheck({ text: prev.mask.masked, image: prev.image, lang: prev.lang ?? 'und', outLang: uiLang, signals: prev.signals });
}

/** Follow-up questions are masked with the same function: people often paste the number they were told to call. */
export const maskQuestion = (question: string) => maskPII(question).masked;

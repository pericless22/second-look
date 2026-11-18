// Loading and sanity-checking public/firebase-config.json. Kept free of Firebase imports so it can be unit-tested.

export interface AppConfig {
  firebase: { apiKey?: string; appId?: string; projectId?: string; [k: string]: unknown };
  appCheck?: { recaptchaV3SiteKey?: string; useDebugToken?: boolean };
  models?: { cloudModel?: string };
}

/** A value copied from the example file ("YOUR_…") or left blank is not a real setting. */
export function isRealValue(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return s.length > 0 && !/^YOUR_/i.test(s);
}

export const isLocalHost = (hostname: string) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');

export interface AppCheckPlan {
  /** reCAPTCHA v3 site key to initialize App Check with; undefined means App Check is not initialized. */
  siteKey?: string;
  /** Ask the SDK to print a debug token (local development only). */
  debugToken: boolean;
  warnings: string[];
}

/** Decides how App Check is set up for this config on this host. */
export function appCheckPlan(cfg: AppConfig, hostname: string): AppCheckPlan {
  const warnings: string[] = [];
  const key = cfg.appCheck?.recaptchaV3SiteKey;
  const siteKey = isRealValue(key) ? key.trim() : undefined;
  let debugToken = !!cfg.appCheck?.useDebugToken;
  if (!siteKey) {
    warnings.push(key
      ? 'App Check is off: recaptchaV3SiteKey is still the placeholder from the example config.'
      : 'App Check is off: no recaptchaV3SiteKey in firebase-config.json. Calls fail once enforcement is on.');
    // Without initializeAppCheck there is nothing to attach a debug token to.
    debugToken = false;
  }
  if (debugToken && !isLocalHost(hostname)) {
    warnings.push('useDebugToken is ignored on a deployed site: visitors would get unregistered debug tokens. Set it to false for hosting.');
    debugToken = false;
  }
  return { siteKey, debugToken, warnings };
}

export type ConfigResult = { ok: true; cfg: AppConfig } | { ok: false; reason: string };

/**
 * Fetches the config. A missing file on Firebase Hosting comes back as index.html (the SPA rewrite),
 * so anything that is not a JSON object with a real apiKey and appId counts as "no config".
 */
export async function loadConfig(fetchFn: typeof fetch, url = '/firebase-config.json'): Promise<ConfigResult> {
  let r: Response;
  try {
    r = await fetchFn(url, { cache: 'no-store' });
  } catch (e) {
    return { ok: false, reason: `could not fetch ${url} (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!r.ok) return { ok: false, reason: `${url} returned HTTP ${r.status}` };
  const body = await r.text();
  let cfg: AppConfig;
  try {
    cfg = JSON.parse(body);
  } catch {
    return { ok: false, reason: `${url} is not JSON (probably missing from this build, so the server sent the app page instead)` };
  }
  if (!cfg || typeof cfg !== 'object' || !cfg.firebase) return { ok: false, reason: `${url} has no "firebase" section` };
  if (!isRealValue(cfg.firebase.apiKey) || !isRealValue(cfg.firebase.appId)) {
    return { ok: false, reason: `${url} still has placeholder values (apiKey / appId)` };
  }
  return { ok: true, cfg };
}

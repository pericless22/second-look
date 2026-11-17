// Real engine: Firebase AI Logic hybrid inference (Gemini Nano in Chrome + Gemini in the cloud).
import { initializeApp, type FirebaseOptions } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { getRemoteConfig, fetchAndActivate, getValue } from 'firebase/remote-config';
import {
  getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, Schema,
  type GenerativeModel, type Part,
} from 'firebase/ai';
import type { Engine, CheckInput, OnDeviceStatus } from './engine.ts';
import { buildPrompt, normalizeVerdict, VERDICT_JSON_SCHEMA, RISK_ENUM, SCAM_ENUM } from './engine.ts';
import type { CheckResult, Source, Verdict } from './types.ts';

export interface AppConfig {
  firebase: FirebaseOptions;
  appCheck?: { recaptchaV3SiteKey?: string; useDebugToken?: boolean };
  models?: { cloudModel?: string };
}

const CLOUD_SCHEMA = Schema.object({
  properties: {
    risk_score: Schema.integer(),
    risk_level: Schema.enumString({ enum: RISK_ENUM }),
    scam_type: Schema.enumString({ enum: SCAM_ENUM }),
    reasons: Schema.array({ items: Schema.string() }),
    actions: Schema.array({ items: Schema.string() }),
    confidence: Schema.number(),
  },
});

export class FirebaseEngine implements Engine {
  kind = 'firebase' as const;
  private ai;
  private cloudModelName: string;
  private cache = new Map<string, GenerativeModel>();

  constructor(private cfg: AppConfig) {
    const app = initializeApp(cfg.firebase);
    // App Check is required by Firebase AI Logic. Debug tokens are accepted for hackathon judging;
    // the token is printed to the console and must be registered in the Firebase console (never committed).
    if (cfg.appCheck?.useDebugToken) (self as any).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    if (cfg.appCheck?.recaptchaV3SiteKey) {
      initializeAppCheck(app, { provider: new ReCaptchaV3Provider(cfg.appCheck.recaptchaV3SiteKey), isTokenAutoRefreshEnabled: true });
    }
    this.ai = getAI(app, { backend: new GoogleAIBackend() });
    this.cloudModelName = cfg.models?.cloudModel ?? 'gemini-3.5-flash-lite';
    // Remote Config lets us swap the cloud model / thresholds without redeploying.
    try {
      const rc = getRemoteConfig(app);
      rc.defaultConfig = { cloud_model: this.cloudModelName };
      fetchAndActivate(rc).then(() => {
        const m = getValue(rc, 'cloud_model').asString();
        if (m && m !== this.cloudModelName) { this.cloudModelName = m; this.cache.clear(); }
      }).catch(() => {});
    } catch { /* Remote Config optional */ }
  }

  private onDeviceOpts(lang: string, withImage: boolean) {
    const inLangs = Array.from(new Set(['en', lang]));
    return {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: inLangs }, ...(withImage ? [{ type: 'image' }] : [])],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      },
      promptOptions: { responseConstraint: VERDICT_JSON_SCHEMA },
    } as any;
  }

  private model(mode: InferenceMode, lang: string, withImage: boolean): GenerativeModel {
    const key = `${mode}|${lang}|${withImage}|${this.cloudModelName}`;
    let m = this.cache.get(key);
    if (!m) {
      m = getGenerativeModel(this.ai, {
        mode,
        onDeviceParams: this.onDeviceOpts(lang, withImage),
        inCloudParams: {
          model: this.cloudModelName,
          generationConfig: { responseMimeType: 'application/json', responseSchema: CLOUD_SCHEMA, temperature: 0.2 },
        },
      });
      this.cache.set(key, m);
    }
    return m;
  }

  async onDeviceStatus(withImage = false): Promise<OnDeviceStatus> {
    if (typeof LanguageModel === 'undefined') return 'unavailable';
    try { return await LanguageModel.availability(this.onDeviceOpts('en', withImage).createOptions); }
    catch { return 'unavailable'; }
  }

  async downloadOnDevice(onProgress: (p: number) => void) {
    if (typeof LanguageModel === 'undefined') throw new Error('Prompt API not available in this browser');
    const s = await LanguageModel.create({
      ...this.onDeviceOpts('en', false).createOptions,
      monitor(m: any) { m.addEventListener('downloadprogress', (e: any) => onProgress(e.loaded)); },
    });
    s.destroy?.();
  }

  private async run(mode: InferenceMode, input: CheckInput, outLang: string, masked: boolean): Promise<CheckResult> {
    const t0 = performance.now();
    const parts: (string | Part)[] = [buildPrompt(input, outLang, masked)];
    if (input.image) parts.push({ type: 'inlineData', inlineData: { mimeType: input.image.mimeType, data: input.image.base64 } });
    const res = await this.model(mode, input.lang, !!input.image).generateContent(parts);
    const src: Source = res.response.inferenceSource === 'on_device' ? 'on_device' : 'in_cloud';
    return { verdict: normalizeVerdict(res.response.text()), source: src, sentText: input.text, ms: Math.round(performance.now() - t0) };
  }

  privateCheck(input: CheckInput) { return this.run(InferenceMode.ONLY_ON_DEVICE, input, 'en', false); }
  hybridCheck(input: CheckInput) { return this.run(InferenceMode.PREFER_ON_DEVICE, input, 'en', true); }
  cloudCheck(input: CheckInput) { return this.run(InferenceMode.ONLY_IN_CLOUD, input, uiLangOf(input), true); }

  async followUp(maskedMessage: string, v: Verdict, question: string, uiLang: string) {
    const chat = getGenerativeModel(this.ai, { mode: InferenceMode.ONLY_IN_CLOUD, inCloudParams: { model: this.cloudModelName } })
      .startChat({
        history: [
          { role: 'user', parts: [{ type: 'text', text: `Masked message I received:\n${maskedMessage}` }] },
          { role: 'model', parts: [{ type: 'text', text: `Assessment: ${JSON.stringify(v)}` }] },
        ],
      });
    const r = await chat.sendMessage(`${question}\n(Answer briefly in ${uiLang === 'ko' ? 'Korean' : 'English'}. Never ask for personal data.)`);
    return r.response.text();
  }
}

let currentUiLang = 'en';
export function setEngineUiLang(l: string) { currentUiLang = l; }
function uiLangOf(_i: CheckInput) { return currentUiLang; }

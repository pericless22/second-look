// Real engine: Firebase AI Logic hybrid inference (Gemini Nano in Chrome + Gemini in the cloud).
import { initializeApp, type FirebaseOptions } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { getRemoteConfig, fetchAndActivate, getValue } from 'firebase/remote-config';
import {
  getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, Schema,
  type GenerativeModel, type Part,
} from 'firebase/ai';
import type { Engine, CheckInput, FollowUpChat, FollowUpContext, OnDeviceStatus } from './engine.ts';
import { buildPrompt, followUpInstruction, normalizeVerdict, stripMarkers, VERDICT_JSON_SCHEMA } from './engine.ts';
import { applyLocalFloor } from './rules.ts';
import { appCheckPlan, isRealValue, type AppConfig } from './config.ts';
import { RISK_LEVELS, SCAM_TYPES, type CheckResult, type Source } from './types.ts';

export const DEFAULT_CLOUD_MODEL = 'gemini-3.5-flash-lite';
const looksLikeMissingModel = (e: unknown) => /\b404\b|not found|is not supported/i.test(e instanceof Error ? e.message : String(e));

const CLOUD_SCHEMA = Schema.object({
  properties: {
    risk_score: Schema.integer(),
    risk_level: Schema.enumString({ enum: [...RISK_LEVELS] }),
    scam_type: Schema.enumString({ enum: [...SCAM_TYPES] }),
    reasons: Schema.array({ items: Schema.string() }),
    actions: Schema.array({ items: Schema.string() }),
    confidence: Schema.number(),
  },
});

export class FirebaseEngine implements Engine {
  readonly kind = 'firebase' as const;
  private ai;
  private cloudModelName: string;
  private cache = new Map<string, GenerativeModel>();

  constructor(cfg: AppConfig) {
    const app = initializeApp(cfg.firebase as FirebaseOptions);
    // Firebase AI Logic expects App Check. The hosted site uses reCAPTCHA v3; local runs against your own
    // project can use a debug token (printed in the console, registered in the Firebase console, never committed).
    const plan = appCheckPlan(cfg, location.hostname);
    for (const w of plan.warnings) console.warn(`[Second Look] ${w}`);
    if (plan.siteKey) {
      if (plan.debugToken) (self as any).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
      initializeAppCheck(app, { provider: new ReCaptchaV3Provider(plan.siteKey), isTokenAutoRefreshEnabled: true });
    }
    this.ai = getAI(app, { backend: new GoogleAIBackend() });
    this.cloudModelName = isRealValue(cfg.models?.cloudModel) ? cfg.models.cloudModel : DEFAULT_CLOUD_MODEL;
    // Remote Config can swap the cloud model without a redeploy. A bad value falls back to the default (see run()).
    try {
      const rc = getRemoteConfig(app);
      rc.defaultConfig = { cloud_model: this.cloudModelName };
      fetchAndActivate(rc).then(() => {
        const m = getValue(rc, 'cloud_model').asString().trim();
        if (m && m !== this.cloudModelName) { this.cloudModelName = m; this.cache.clear(); }
      }).catch(() => {});
    } catch { /* Remote Config is optional */ }
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
    let res;
    try {
      res = await this.model(mode, input.lang, !!input.image).generateContent(parts);
    } catch (e) {
      // A mistyped Remote Config model name would otherwise break every cloud call.
      if (mode === InferenceMode.ONLY_ON_DEVICE || this.cloudModelName === DEFAULT_CLOUD_MODEL || !looksLikeMissingModel(e)) throw e;
      console.warn(`[Second Look] Cloud model "${this.cloudModelName}" failed, retrying with ${DEFAULT_CLOUD_MODEL}.`, e);
      this.cloudModelName = DEFAULT_CLOUD_MODEL;
      this.cache.clear();
      res = await this.model(mode, input.lang, !!input.image).generateContent(parts);
    }
    const source: Source = res.response.inferenceSource === 'on_device' ? 'on_device' : 'in_cloud';
    // Local rules act as a floor under the model (critical signals, and strong rule evidence vs. a "low" answer).
    const verdict = applyLocalFloor(normalizeVerdict(res.response.text()), input.signals, outLang);
    return { verdict, source, sentText: input.text, ms: Math.round(performance.now() - t0), lang: outLang };
  }

  // The on-device model only writes English for now, so paths that may run on-device ask for English.
  privateCheck(input: CheckInput) { return this.run(InferenceMode.ONLY_ON_DEVICE, input, 'en', false); }
  hybridCheck(input: CheckInput) { return this.run(InferenceMode.PREFER_ON_DEVICE, input, 'en', true); }
  cloudCheck(input: CheckInput) { return this.run(InferenceMode.ONLY_IN_CLOUD, input, input.outLang, true); }

  /** One ChatSession per result: the SDK keeps the history, so follow-ups really are multi-turn. */
  startFollowUp({ maskedMessage, verdict, uiLang }: FollowUpContext): FollowUpChat {
    const chat = getGenerativeModel(this.ai, {
      mode: InferenceMode.ONLY_IN_CLOUD,
      inCloudParams: { model: this.cloudModelName, systemInstruction: followUpInstruction(uiLang), generationConfig: { temperature: 0.3 } },
    }).startChat({
      history: [
        { role: 'user', parts: [{ type: 'text', text: `Masked message I received:\n--- MESSAGE START ---\n${stripMarkers(maskedMessage) || '(screenshot only)'}\n--- MESSAGE END ---` }] },
        { role: 'model', parts: [{ type: 'text', text: `My assessment: ${JSON.stringify(verdict)}` }] },
      ],
    });
    return { ask: async (question: string) => (await chat.sendMessage(question)).response.text() };
  }
}

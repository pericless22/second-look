// Mock engine: lets the full UI be demoed without a Firebase project or Gemini Nano.
// Scores with the same local rules; clearly labelled "MOCK" in the UI.
import type { Engine, CheckInput, FollowUpChat, FollowUpContext, OnDeviceStatus } from './engine.ts';
import type { CheckResult, Source } from './types.ts';
import { rulesVerdict } from './rules.ts';
import { t } from './i18n.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const browserOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

export class MockEngine implements Engine {
  readonly kind = 'mock' as const;
  /** Simulated on-device model state ("Simulate device" selector). */
  status: OnDeviceStatus = 'available';
  /** Simulated network state. */
  offline = false;
  /** Why the app is in mock mode (shown in the banner). Empty when mock mode was asked for with ?mock. */
  reason = '';
  /** Makes the next model calls throw this error (tests, and checking the fallback UI). */
  failWith?: Error;

  /** `delayScale: 0` removes the simulated latency (tests). */
  private delayScale: number;
  constructor(delayScale = 1) { this.delayScale = delayScale; }

  async onDeviceStatus() { return this.status; }

  async downloadOnDevice(onProgress: (p: number) => void) {
    this.status = 'downloading';
    for (let i = 1; i <= 10; i++) { await sleep(120 * this.delayScale); onProgress(i / 10); }
    this.status = 'available';
  }

  private async run(input: CheckInput, source: Source, outLang: string): Promise<CheckResult> {
    const t0 = performance.now();
    await sleep((source === 'mock_in_cloud' ? 900 : 450) * this.delayScale);
    if (this.failWith) throw this.failWith;
    // Local rules can't read pixels; never pretend a screenshot "looks OK".
    if (!input.text && input.image) throw new Error('mock mode cannot read screenshots');
    return { verdict: rulesVerdict(input.signals, outLang), source, sentText: input.text, ms: Math.round(performance.now() - t0), lang: outLang };
  }

  async privateCheck(input: CheckInput) {
    if (this.status !== 'available') throw new Error('on-device model unavailable');
    // Like Gemini Nano today, the simulated on-device path answers in English.
    return this.run(input, 'mock_on_device', 'en');
  }

  async hybridCheck(input: CheckInput) {
    return this.status === 'available' ? this.run(input, 'mock_on_device', 'en') : this.cloudCheck(input);
  }

  async cloudCheck(input: CheckInput) {
    if (this.offline || browserOffline()) throw new Error('offline');
    return this.run(input, 'mock_in_cloud', input.outLang);
  }

  startFollowUp({ verdict, uiLang }: FollowUpContext): FollowUpChat & { history: string[] } {
    const history: string[] = [];
    return {
      history,
      ask: async (question: string) => {
        if (this.offline || browserOffline()) throw new Error('offline');
        await sleep(700 * this.delayScale);
        history.push(question);
        return t(uiLang, 'mock.followup')
          .replace('{q}', question)
          .replace('{score}', String(verdict.risk_score))
          .replace('{n}', String(history.length));
      },
    };
  }
}

// Language routing. Chrome's on-device Prompt API currently accepts en, ja, es, de, fr only.
export const ON_DEVICE_LANGS = ['en', 'ja', 'es', 'de', 'fr'];

declare global {
  // Chrome built-in AI globals (feature-detected at runtime)
  // eslint-disable-next-line no-var
  var LanguageDetector: any;
  // eslint-disable-next-line no-var
  var LanguageModel: any;
}

export async function detectLanguage(text: string): Promise<string> {
  const hangul = (text.match(/[\uAC00-\uD7A3]/g) ?? []).length;
  if (hangul >= 3) return 'ko';
  try {
    if (typeof LanguageDetector !== 'undefined') {
      const d = await LanguageDetector.create();
      const [top] = await d.detect(text);
      if (top && top.confidence > 0.5) return String(top.detectedLanguage).split('-')[0];
    }
  } catch { /* fall through */ }
  return 'en';
}

export function supportedOnDevice(lang: string) {
  return ON_DEVICE_LANGS.includes(lang);
}

# Second Look 🔍

**A private second opinion on suspicious messages.** Paste a text (or a screenshot) your parent just received. Second Look checks it with **Gemini Nano on your own device** via **Firebase AI Logic hybrid inference**. When the device can't handle it (no local model, or a language Nano can't read yet, like Korean), it **masks personal data on-device first**, shows you *exactly* what would be sent, and only then asks Gemini in the cloud, with your consent.

Built for the Firebase **#BuildHybridAI 2026** hackathon (Web / Chrome).

![Second Look: on-device result](docs/screenshots/01-en-on-device-private.png)

## Why hybrid?
Scam messages are full of things you should never upload: phone numbers, bank accounts, national ID numbers (Korean RRN), family names. Smishing is a daily problem in Korea and everywhere else, and the people who receive these messages most (older parents) are the ones least able to judge them.

| Situation | What Second Look does | Firebase AI Logic mode |
|---|---|---|
| Nano available + supported language (en/ja/es/de/fr) | Raw message is checked **only on-device**. Nothing leaves the computer, works offline. | `InferenceMode.ONLY_ON_DEVICE` |
| No on-device model on this device | Mask PII on-device → show preview → consent → hybrid call | `InferenceMode.PREFER_ON_DEVICE` (masked text; on-device once the model is ready, cloud otherwise) |
| Language Nano can't read yet (e.g. Korean) | Mask PII on-device → preview → consent → cloud | `InferenceMode.ONLY_IN_CLOUD` (masked text) |
| On-device verdict is uncertain | Optional "second opinion" from the cloud (masked, consent) | `InferenceMode.ONLY_IN_CLOUD` |
| Follow-up questions ("How do I report this?") | Multi-turn chat is cloud-only, masked context | `ONLY_IN_CLOUD` + `startChat` |
| Offline and no model | Deterministic on-device red-flag rules only | none |

Every result shows a badge with where inference actually ran (`response.inferenceSource`).

## Features
- Risk score (0-100), level, scam type, reasons, concrete actions (structured JSON output on-device via Chrome `responseConstraint`, in the cloud via `responseSchema`).
- **On-device PII masking** (`src/pii.ts`, pure regex, no network): Korean RRN, card numbers, phone numbers (KR/US/intl), bank accounts, emails → `[PHONE_1]`, `[ACCOUNT_1]`…
- **Link analysis on-device**: shortened links, raw IPs, punycode look-alikes, high-risk TLDs, brand impersonation (e.g. `usps-redelivery-fee.top`).
- Local red-flag rules in English and Korean (urgency, money/credential requests, family/authority impersonation, delivery/prize/loan/investment lures, obituary/wedding-link lures…).
- **Verification-code (OTP) forwarding** is a critical signal: "I sent my code to your number by mistake, can you forward it?" has no link and no money request, so it gets a dedicated rule that scores high on its own, and acts as a floor under the model's verdict (`applyLocalFloor`). Official notices ("Your code is 482913. Do not share it.") stay low.
- Screenshot input (PNG/JPEG) on-device. Screenshots can't be auto-masked, so the cloud path warns before sending.
- English + Korean UI, large-text mode, light/dark theme, keyboard shortcuts (Ctrl+Enter), "copy summary for family".
- 30 **synthetic** test messages (15 EN, 15 KO) in `src/samples.ts`.
- Firebase **App Check** (reCAPTCHA v3 + debug token for judging) and **Remote Config** (swap the cloud model without redeploying).

## Run locally
```bash
npm install
npm run dev          # http://localhost:5173 runs in MOCK MODE until you add a Firebase config
npm test             # PII masking, scam rules (incl. OTP forwarding), verdict parsing, mock engine, i18n, 30-sample baseline
npm run typecheck
npm run build        # production build to dist/
```
**Mock mode** (`?mock` or no config) demos the whole UI without Firebase or Gemini Nano: results come from local rules, clearly labelled MOCK, and a "Simulate device" selector switches between Nano available / no model / offline. The Firebase SDK is not even downloaded in mock mode.

Demo URL parameters (mock mode): `?lang=en|ko`, `?sample=en11` (prefill a sample), `?auto=1` (check immediately), `?sim=unavailable|offline`.

![Verification-code forwarding scored as high risk](docs/screenshots/05-en-otp-forwarding.png)

### Connect Firebase (real hybrid inference)
1. Create a Firebase project, add a **Web app**, enable **Firebase AI Logic** (Gemini Developer API) in the console (or `npx firebase-tools init ailogic`).
2. Enable **App Check** with a reCAPTCHA v3 site key; for local testing register the debug token printed in the browser console.
3. `cp public/firebase-config.example.json public/firebase-config.json` and fill in the values (this file is gitignored).
4. For on-device inference use **Chrome desktop 139+**, enable `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input`, restart, then click "Download on-device model" in the app. Requirements: ~22 GB free disk, >4 GB VRAM GPU or 16 GB RAM.

## Project structure
```
src/firebase-engine.ts  Firebase AI Logic: getAI + getGenerativeModel with ONLY_ON_DEVICE / PREFER_ON_DEVICE / ONLY_IN_CLOUD, App Check, Remote Config
src/engine.ts           Engine interface, prompt, verdict schema + tolerant verdict parsing
src/mock.ts             Mock engine (simulated device / cloud / offline)
src/rules.ts            Deterministic rules verdict, risk thresholds, safety floor under model verdicts
src/pii.ts              On-device PII masking and URL flagging
src/signals.ts          Local EN/KO scam red-flag rules (incl. OTP-forwarding detection)
src/lang.ts             Language routing (Chrome LanguageDetector + Hangul check)
src/main.ts             UI and routing/consent flow
src/samples.ts          30 synthetic test messages
src/i18n.ts             EN/KO strings
scripts/screenshot.mjs  Regenerates docs/screenshots (needs `npm run dev` + local Chrome; `CHROME_PATH`, `BASE_URL`)
tests/                  node:test unit tests
```

## Privacy notes
- The raw message is only ever given to `ONLY_ON_DEVICE` models. Anything that can reach the cloud is masked first and shown to the user before sending.
- No message content is stored. No analytics.
- All sample messages, numbers and links are fabricated for testing.

## Built during the hackathon
All code was written from scratch during the #BuildHybridAI submission period (from Nov 17, 2026), with AI coding assistants. No pre-existing project code is used. Third-party: Firebase JS SDK, Vite, TypeScript.

## License
[Apache-2.0](LICENSE)

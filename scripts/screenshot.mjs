import { chromium } from 'playwright-core';
const out = 'docs/screenshots';
// Usage: npm run dev (in another terminal), then: CHROME_PATH=/path/to/chrome node scripts/screenshot.mjs
const executablePath = process.env.CHROME_PATH ?? (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const base = process.env.BASE_URL ?? 'http://localhost:5173';
const b = await chromium.launch({ executablePath });
const p = await b.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
p.on('console', (m) => { if (m.type() === 'error') console.log('console error:', m.text()); });
p.on('pageerror', (e) => console.log('pageerror:', e.message));
// 1) EN, on-device private path
await p.goto(`${base}/?mock&lang=en&sample=en01&auto=1`);
await p.waitForSelector('.gauge', { timeout: 10000 });
await p.screenshot({ path: `${out}/01-en-on-device-private.png`, fullPage: true });
// 2) KO, Korean message -> consent with masked preview
await p.goto(`${base}/?mock&lang=ko&sample=ko03&auto=1`);
await p.waitForSelector('dialog[open]', { timeout: 10000 });
await p.screenshot({ path: `${out}/02-ko-consent-masked.png`, fullPage: true });
await p.click('#cyes');
await p.waitForSelector('.gauge', { timeout: 10000 });
await p.fill('#q', '어디에 신고하면 되나요?');
await p.click('#ask');
await p.waitForSelector('.answer', { timeout: 10000 });
await p.screenshot({ path: `${out}/03-ko-cloud-result.png`, fullPage: true });
// 4) EN, no on-device model -> masked hybrid fallback
await p.goto(`${base}/?mock&lang=en&sample=en03&sim=unavailable&auto=1`);
await p.waitForSelector('dialog[open]', { timeout: 10000 });
await p.screenshot({ path: `${out}/04-en-no-nano-consent.png`, fullPage: true });
// 5) EN, verification-code forwarding request -> high risk
await p.goto(`${base}/?mock&lang=en&sample=en11&auto=1`);
await p.waitForSelector('.gauge', { timeout: 10000 });
await p.screenshot({ path: `${out}/05-en-otp-forwarding.png`, fullPage: true });
await b.close();
console.log('done');

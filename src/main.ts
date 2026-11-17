import { maskPII, type MaskResult } from './pii.ts';
import { localSignals, type Signal } from './signals.ts';
import { detectLanguage, supportedOnDevice } from './lang.ts';
import { t } from './i18n.ts';
import { SAMPLES } from './samples.ts';
import type { Engine, ImageInput, OnDeviceStatus } from './engine.ts';
import { MockEngine } from './mock.ts';
import { defaultActions, rulesVerdict } from './rules.ts';
import type { CheckResult, RiskLevel } from './types.ts';

// ---------- state ----------
/** How the last result was produced; rendered as the privacy note under the score. */
type Route =
  | { kind: 'private' }
  | { kind: 'cloud'; why: 'lang' | 'nomodel' | 'second' }
  | { kind: 'declined' }
  | { kind: 'offline' };

/** Everything needed to re-render (or re-check) the last result, frozen at check time. */
interface Checked {
  result: CheckResult;
  mask: MaskResult;
  signals: Signal[];
  lang: string;
  image?: ImageInput;
  route: Route;
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg'];
const LEVEL_ICON: Record<RiskLevel, string> = { low: '✅', medium: '⚠️', high: '🚨' };

const params = new URLSearchParams(location.search);
let uiLang: 'en' | 'ko' = params.get('lang') === 'ko' || (!params.get('lang') && navigator.language.startsWith('ko')) ? 'ko' : 'en';
let engine: Engine;
let image: (ImageInput & { dataUrl: string }) | undefined;
let last: Checked | undefined;
let status: OnDeviceStatus = 'unavailable';

const L = (k: string) => t(uiLang, k);
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const maybe = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
const list = (items: string[]) => `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;

const mock = () => (engine instanceof MockEngine ? engine : undefined);
const online = () => navigator.onLine && !mock()?.offline;
const errorText = (e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  return msg === 'offline' ? L('err.offline') : `${L('err')}: ${msg}`;
};

async function loadEngine(): Promise<Engine> {
  if (params.has('mock')) return new MockEngine();
  try {
    const r = await fetch('/firebase-config.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('no config');
    const cfg = await r.json();
    if (!cfg?.firebase?.apiKey || String(cfg.firebase.apiKey).startsWith('YOUR_')) throw new Error('placeholder config');
    // Loaded lazily so mock mode never downloads the Firebase SDK.
    const { FirebaseEngine } = await import('./firebase-engine.ts');
    return new FirebaseEngine(cfg);
  } catch {
    return new MockEngine();
  }
}

// ---------- page shell ----------
function renderShell() {
  const draft = maybe<HTMLTextAreaElement>('#msg')?.value ?? '';
  const m = mock();
  document.documentElement.lang = uiLang;
  const how = (['device', 'mask', 'consent'] as const)
    .map((k, i) => `<li><span class="step">${i + 1}</span><div><strong>${L(`how.${k}.title`)}</strong><span>${L(`how.${k}.body`)}</span></div></li>`)
    .join('');
  $('#app').innerHTML = `
  <div class="wrap">
    <header>
      <div class="brand"><div class="logo" aria-hidden="true">🔍</div><div><h1>Second Look</h1><p class="tag">${L('app.tagline')}</p></div></div>
      <div class="controls">
        <div class="seg" role="group" aria-label="${esc(L('a11y.lang'))}">
          <button class="pill" data-lang="en" aria-pressed="${uiLang === 'en'}">EN</button>
          <button class="pill" data-lang="ko" aria-pressed="${uiLang === 'ko'}">한국어</button>
        </div>
        <button class="ghost" id="large" title="${esc(L('a11y.large'))}" aria-label="${esc(L('a11y.large'))}" aria-pressed="${document.body.classList.contains('large')}">A+</button>
      </div>
    </header>
    ${m ? `<div class="banner" role="note"><span>⚠️ ${L('status.mock')}</span>
      <label>${L('mock.sim')}:
      <select id="sim"><option value="available">${L('mock.sim.available')}</option><option value="unavailable">${L('mock.sim.unavailable')}</option><option value="offline">${L('status.offline')}</option></select></label></div>` : ''}
    <p class="sub">${L('app.sub')}</p>
    <ol class="how">${how}</ol>
    <main class="grid">
      <section class="card">
        <label class="h" for="msg">${L('input.label')}</label>
        <textarea id="msg" placeholder="${esc(L('input.placeholder'))}" aria-describedby="hint"></textarea>
        <div class="row">
          <label class="file muted">📎 ${L('input.image')} <input type="file" id="img" accept="${IMAGE_TYPES.join(',')}" /></label>
          <span id="thumb"></span>
        </div>
        <div class="row">
          <select id="samples" aria-label="${esc(L('input.samples'))}"><option value="">${L('input.samples')} (${SAMPLES.length})</option>${SAMPLES.map((s) => `<option value="${s.id}">${s.lang.toUpperCase()} · ${esc(s.label)}</option>`).join('')}</select>
        </div>
        <div class="row">
          <button class="primary" id="check">🔒 ${L('btn.check')}</button>
          <button class="ghost" id="clear">${L('btn.clear')}</button>
          <span class="muted hint" id="hint">${L('input.hint')}</span>
        </div>
        <p class="inline-error" id="input-error" role="alert" hidden></p>
        <div class="status" id="status" role="status"></div>
      </section>
      <section class="card" id="result" aria-live="polite"></section>
    </main>
    <footer>${L('footer')}</footer>
  </div>
  <dialog id="consent" aria-labelledby="consent-title"></dialog>`;

  const msg = $<HTMLTextAreaElement>('#msg');
  msg.value = draft;
  msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) check(); });

  document.querySelectorAll<HTMLButtonElement>('[data-lang]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.lang === uiLang) return;
    uiLang = b.dataset.lang === 'ko' ? 'ko' : 'en';
    relocalizeLast();
    renderShell();
  }));
  $('#large').addEventListener('click', () => {
    const on = document.body.classList.toggle('large');
    $('#large').setAttribute('aria-pressed', String(on));
    try { localStorage.setItem('sl.large', on ? '1' : ''); } catch { /* storage blocked */ }
  });
  $<HTMLSelectElement>('#samples').addEventListener('change', (e) => {
    const s = SAMPLES.find((x) => x.id === (e.target as HTMLSelectElement).value);
    if (s) { msg.value = s.text; showInputError(''); }
  });
  $('#clear').addEventListener('click', () => {
    msg.value = ''; image = undefined; last = undefined;
    renderShell();
    $('#msg').focus();
  });
  $<HTMLInputElement>('#img').addEventListener('change', onImagePicked);
  $('#check').addEventListener('click', check);

  const sim = maybe<HTMLSelectElement>('#sim');
  if (sim && m) {
    sim.value = m.offline ? 'offline' : m.status === 'available' ? 'available' : 'unavailable';
    sim.addEventListener('change', () => {
      m.offline = sim.value === 'offline';
      m.status = sim.value === 'unavailable' ? 'unavailable' : 'available';
      refreshStatus();
    });
  }

  renderThumb();
  if (last) renderResult(); else renderEmpty();
  refreshStatus();
}

function renderEmpty(html = `<div class="big" aria-hidden="true">🔍</div>${L('result.empty')}`) {
  $('#result').innerHTML = `<div class="empty">${html}</div>`;
}
const renderBusy = (key: string) => renderEmpty(`<div class="spinner" aria-hidden="true"></div>${L(key)}`);

function showInputError(msg: string) {
  const el = $('#input-error');
  el.textContent = msg;
  el.hidden = !msg;
}

async function onImagePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (!f) return;
  const problem = !IMAGE_TYPES.includes(f.type) ? L('err.image_type') : f.size > MAX_IMAGE_BYTES ? L('err.image_size') : '';
  showInputError(problem);
  if (problem) { input.value = ''; return; }
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
  image = { mimeType: f.type, base64: dataUrl.split(',')[1], dataUrl };
  renderThumb();
}

function renderThumb() {
  const el = $('#thumb');
  if (!image) { el.innerHTML = ''; return; }
  el.innerHTML = `<img class="thumb" src="${image.dataUrl}" alt="" /><button class="ghost small" id="rmimg" aria-label="${esc(L('input.remove_image'))}" title="${esc(L('input.remove_image'))}">✕</button>`;
  $('#rmimg').addEventListener('click', () => { image = undefined; $<HTMLInputElement>('#img').value = ''; renderThumb(); });
}

async function refreshStatus() {
  status = await engine.onDeviceStatus(false);
  const el = maybe('#status');
  if (!el) return;
  const cls = status === 'available' ? 'ok' : status === 'unavailable' ? 'bad' : 'warn';
  const off = online() ? '' : ` · ${L('status.offline')}`;
  el.innerHTML = `<span class="dot ${cls}"></span><span>${L('status.title')}: ${L('status.' + status)}${off}</span>` +
    (status === 'downloadable' ? ` <button id="dl">${L('btn.download')}</button><div class="progress"><i id="bar"></i></div>` : '');
  const dl = maybe<HTMLButtonElement>('#dl');
  dl?.addEventListener('click', async () => {
    dl.disabled = true;
    try {
      await engine.downloadOnDevice((p) => { const bar = maybe('#bar'); if (bar) bar.style.width = `${Math.round(p * 100)}%`; });
    } catch (e) {
      showInputError(errorText(e));
    }
    refreshStatus();
  });
}

// ---------- core flow ----------
async function check() {
  const btn = $<HTMLButtonElement>('#check');
  if (btn.disabled) return;
  const text = $<HTMLTextAreaElement>('#msg').value.trim();
  const img = image && { mimeType: image.mimeType, base64: image.base64 };
  if (!text && !img) {
    showInputError(L('input.empty'));
    $('#msg').focus();
    return;
  }
  showInputError('');
  btn.disabled = true;
  last = undefined;
  renderBusy('status.checking');
  try {
    const mask = maskPII(text);
    const signals = localSignals(text, mask);
    const lang = text ? await detectLanguage(text) : 'en';
    status = await engine.onDeviceStatus(!!img);
    const langOk = supportedOnDevice(lang);
    const done = (result: CheckResult, route: Route) => { last = { result, mask, signals, lang, image: img, route }; renderResult(); };
    // Without a model nothing can read a screenshot, so never report "looks OK" for one.
    const rulesFallback = (route: Route) => (text ? done(rulesOnly(text, signals), route) : renderEmpty(`⚠️ ${L('err.image_rules')}`));

    // 1) Private path: raw text, ONLY_ON_DEVICE. Never leaves the device.
    if (status === 'available' && langOk) {
      return done(await engine.privateCheck({ text, image: img, lang, outLang: uiLang, signals }), { kind: 'private' });
    }
    // 2) No model and no network: deterministic local rules only.
    if (!online()) return rulesFallback({ kind: 'offline' });

    // 3) Needs the cloud: ask consent, showing exactly the masked text that would be sent.
    const why = langOk ? 'nomodel' : 'lang';
    renderEmpty();
    if (!(await askConsent(mask, cloudReason(why, lang), !!img))) return rulesFallback({ kind: 'declined' });
    renderBusy('status.checking.cloud');
    const input = { text: mask.masked, image: img, lang, outLang: uiLang, signals };
    done(langOk ? await engine.hybridCheck(input) : await engine.cloudCheck(input), { kind: 'cloud', why });
  } catch (e) {
    renderEmpty(`⚠️ ${esc(errorText(e))}`);
  } finally {
    btn.disabled = false;
  }
}

function rulesOnly(text: string, signals: Signal[]): CheckResult {
  return { verdict: rulesVerdict(signals, uiLang), source: 'rules', sentText: text, ms: 0 };
}

/** Rule-based verdict text is generated locally, so it can follow a UI language switch. */
function relocalizeLast() {
  if (!last) return;
  const { source } = last.result;
  if (source === 'rules' || source === 'mock_in_cloud') last.result.verdict = rulesVerdict(last.signals, uiLang);
}

function cloudReason(why: 'lang' | 'nomodel' | 'second', lang: string) {
  if (why === 'second') return L('route.second');
  if (why === 'nomodel') return L('route.nomodel');
  const key = `lang.${lang}`;
  const name = L(key);
  return L('route.lang').replace('{lang}', name === key ? lang.toUpperCase() : name);
}

function highlightMasked(m: MaskResult) {
  return esc(m.masked).replace(/\[(RRN|CARD|PHONE|ACCOUNT|EMAIL)_\d+\]/g, (x) => `<span class="mask">${x}</span>`);
}

function askConsent(mask: MaskResult, reason: string, withImage: boolean): Promise<boolean> {
  const d = $<HTMLDialogElement>('#consent');
  const found = mask.findings.length
    ? `<div class="chips">${mask.findings.map((f) => `<span class="chip neutral">${L('pii.' + f.type)} → ${f.token}</span>`).join('')}</div>`
    : `<span class="muted">${L('consent.none')}</span>`;
  d.innerHTML = `
    <h2 id="consent-title">☁️ ${L('consent.title')}</h2>
    <p class="muted">${esc(reason)}</p>
    <p>${L('consent.body')}</p>
    <div class="mono">${highlightMasked(mask) || L('consent.screenshot')}</div>
    ${withImage ? `<p class="route warn">⚠️ ${L('route.image')}</p>` : ''}
    <h3>${L('consent.found')}</h3>${found}
    <div class="row end">
      <button id="cno">${L('consent.no')}</button>
      <button class="primary" id="cyes">${L('consent.yes')}</button>
    </div>`;
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => {
    $('#cyes').addEventListener('click', () => d.close('yes'));
    $('#cno').addEventListener('click', () => d.close('no'));
    // Esc closes with an empty returnValue, which counts as "keep it on my device".
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true });
  });
}

function routeNote(c: Checked) {
  const { route } = c;
  switch (route.kind) {
    case 'private': return `<div class="route">🔒 ${L('route.private')}</div>`;
    case 'cloud': return `<div class="route cloud">☁️ ${esc(cloudReason(route.why, c.lang))} ${L('route.cloud_note')}</div>`;
    case 'declined': return `<div class="route">🔒 ${L('consent.declined')}</div>`;
    case 'offline': return `<div class="route">📴 ${L('route.offline')}</div>`;
  }
}

function renderResult(error = '') {
  if (!last) return;
  const c = last;
  const { result: r, mask, signals } = c;
  const v = r.verdict;
  const onDevice = r.source === 'on_device' || r.source === 'mock_on_device';
  const inCloud = r.source === 'in_cloud' || r.source === 'mock_in_cloud';
  // The on-device model answers in English; show the standard advice in the UI language instead.
  const translateLocally = onDevice && uiLang !== 'en';
  const actions = translateLocally || !v.actions.length ? defaultActions(v.risk_level, signals, uiLang) : v.actions;
  const reasons = v.reasons.length ? v.reasons : signals.map((s) => L('sig.' + s.id)).slice(0, 4);
  const localFlags = signals.length
    ? `<div class="chips">${signals.map((s) => `<span class="chip">${esc(L('sig.' + s.id))}</span>`).join('')}</div>`
    : `<span class="muted">${L('sig.none')}</span>`;
  const links = mask.urls.length
    ? `<h3>${L('result.links')}</h3><ul class="links">${mask.urls.map((u) => `<li><code>${esc(u.host)}</code> ${u.flags.map((f) => `<span class="chip">${L('flag.' + f)}</span>`).join(' ')}</li>`).join('')}</ul>`
    : '';
  const showSecond = c.route.kind === 'private' && online() && (v.risk_level === 'medium' || v.confidence < 0.6);
  const sourceIcon = onDevice ? '📱' : inCloud ? '☁️' : '📏';

  $('#result').innerHTML = `
    <div class="verdict lv-${v.risk_level}">
      <div class="gauge" role="img" aria-label="${esc(L('a11y.score').replace('{score}', String(v.risk_score)))}" style="--v:${v.risk_score}"><span>${v.risk_score}</span></div>
      <div>
        <div class="level">${LEVEL_ICON[v.risk_level]} ${L('result.level.' + v.risk_level)}</div>
        <div class="muted">${L('result.type')}: ${L('type.' + v.scam_type)} · ${L('result.confidence')} ${Math.round(v.confidence * 100)}%</div>
        <div class="badges"><span class="badge b-${r.source}">${sourceIcon} ${L('result.source.' + r.source)}</span>${r.ms ? `<span class="muted">${r.ms} ms</span>` : ''}</div>
      </div>
    </div>
    ${routeNote(c)}
    <h3>${L('result.reasons')}</h3>${list(reasons)}
    ${translateLocally ? `<p class="muted">ℹ️ ${L('result.ondevice_en')}</p>` : ''}
    <h3>${L('result.actions')}</h3>${list(actions)}
    <h3>${L('result.localflags')}</h3>${localFlags}
    ${links}
    <div class="row actions">
      ${showSecond ? `<button id="second">☁️ ${L('result.second')}</button>` : ''}
      <button id="share">📋 ${L('result.share')}</button>
    </div>
    ${error ? `<p class="inline-error" role="alert">⚠️ ${esc(error)}</p>` : ''}
    ${inCloud ? `<h3><label for="q">${L('follow.title')}</label></h3><div class="follow"><input id="q" placeholder="${esc(L('follow.placeholder'))}" /><button id="ask">${L('follow.ask')}</button></div><div id="ans" aria-live="polite"></div>` : ''}`;

  const share = $('#share');
  share.addEventListener('click', async () => {
    const summary = [
      `[Second Look] ${L('result.level.' + v.risk_level)} (${v.risk_score}/100) · ${L('type.' + v.scam_type)}`,
      ...reasons.map((x) => `- ${x}`),
      `${L('result.actions')}:`,
      ...actions.map((x) => `- ${x}`),
    ].join('\n');
    try { await navigator.clipboard.writeText(summary); share.textContent = '✅ ' + L('result.copied'); } catch { /* clipboard blocked */ }
  });

  const second = maybe<HTMLButtonElement>('#second');
  second?.addEventListener('click', async () => {
    if (!(await askConsent(mask, L('consent.second'), !!c.image))) return;
    second.disabled = true;
    renderBusy('status.checking.cloud');
    try {
      const result = await engine.cloudCheck({ text: mask.masked, image: c.image, lang: c.lang, outLang: uiLang, signals });
      last = { ...c, result, route: { kind: 'cloud', why: 'second' } };
      renderResult();
    } catch (e) {
      last = c;
      renderResult(errorText(e));
    }
  });

  const ask = maybe<HTMLButtonElement>('#ask');
  const q = maybe<HTMLInputElement>('#q');
  if (ask && q) {
    const send = async () => {
      const question = q.value.trim();
      if (!question || ask.disabled) return;
      ask.disabled = true;
      try {
        // The question is masked too: people often paste the number they were told to call.
        const answer = await engine.followUp(mask.masked, v, maskPII(question).masked, uiLang);
        $('#ans').innerHTML = `<div class="answer">${esc(answer)}</div>`;
      } catch (e) {
        $('#ans').innerHTML = `<p class="inline-error" role="alert">⚠️ ${esc(errorText(e))}</p>`;
      } finally {
        ask.disabled = false;
      }
    };
    ask.addEventListener('click', send);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  }
}

// ---------- boot ----------
(async () => {
  engine = await loadEngine();
  try { document.body.classList.toggle('large', localStorage.getItem('sl.large') === '1'); } catch { /* storage blocked */ }

  // Demo hooks (mock mode / automated screenshots): ?sim=unavailable|offline&sample=ko03&auto=1
  const m = mock();
  const sim = params.get('sim');
  if (m && sim) {
    m.offline = sim === 'offline';
    m.status = sim === 'unavailable' ? 'unavailable' : 'available';
  }
  renderShell();
  window.addEventListener('online', refreshStatus);
  window.addEventListener('offline', refreshStatus);

  const sample = SAMPLES.find((x) => x.id === params.get('sample'));
  if (sample) {
    $<HTMLTextAreaElement>('#msg').value = sample.text;
    $<HTMLSelectElement>('#samples').value = sample.id;
    if (params.has('auto')) check();
  }
})();

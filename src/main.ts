import type { MaskResult } from './pii.ts';
import type { Signal } from './signals.ts';
import { detectLanguage } from './lang.ts';
import { t } from './i18n.ts';
import { SAMPLES } from './samples.ts';
import type { Engine, FollowUpChat, ImageInput, OnDeviceStatus } from './engine.ts';
import { MockEngine } from './mock.ts';
import { defaultActions, rulesVerdict } from './rules.ts';
import { friendlyError, MAX_TEXT_CHARS, maskQuestion, runCheck, secondOpinion, type CloudWhy, type Route } from './route.ts';
import { isLocalHost, loadConfig } from './config.ts';
import type { CheckResult, RiskLevel } from './types.ts';

// ---------- state ----------
/** Everything needed to re-render (or re-check) the last result, frozen at check time. */
interface Checked {
  result: CheckResult;
  mask: MaskResult;
  signals: Signal[];
  lang: string | null;
  image?: ImageInput;
  /** How the result was produced; rendered as the privacy note under the score. */
  route: Route;
  /** The on-device verdict a cloud second opinion was asked about, kept visible beside it. */
  previous?: CheckResult;
  /** Follow-up conversation about this result (one session, so it remembers earlier questions). */
  chat?: FollowUpChat;
  /** Questions and answers so far, re-rendered after a language switch. */
  qa?: { q: string; a: string }[];
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
const errorText = (e: unknown) => L(friendlyError(e));

/** Mock mode on a deployed build means the config was missing: say so loudly, not just in a corner. */
const unexpectedMock = () => !!mock() && !params.has('mock') && !isLocalHost(location.hostname);

async function loadEngine(): Promise<Engine> {
  if (params.has('mock')) return new MockEngine();
  const toMock = (reason: string) => {
    console.warn(`[Second Look] MOCK MODE: ${reason}. Nothing in this session calls Gemini.`);
    const m = new MockEngine();
    m.reason = reason;
    return m;
  };
  const loaded = await loadConfig(fetch);
  if (!loaded.ok) return toMock(loaded.reason);
  try {
    // Loaded lazily so mock mode never downloads the Firebase SDK.
    const { FirebaseEngine } = await import('./firebase-engine.ts');
    return new FirebaseEngine(loaded.cfg);
  } catch (e) {
    console.error('[Second Look] Firebase failed to start:', e);
    return toMock(`Firebase failed to start (${e instanceof Error ? e.message : String(e)})`);
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
    ${m ? `<div class="banner${unexpectedMock() ? ' loud' : ''}" role="${unexpectedMock() ? 'alert' : 'note'}"><span>⚠️ ${L(unexpectedMock() ? 'status.mock_deployed' : 'status.mock')}${m.reason ? ` <small>(${esc(m.reason)})</small>` : ''}</span>
      <label>${L('mock.sim')}:
      <select id="sim"><option value="available">${L('mock.sim.available')}</option><option value="unavailable">${L('mock.sim.unavailable')}</option><option value="offline">${L('status.offline')}</option></select></label></div>` : ''}
    <p class="sub">${L('app.sub')}</p>
    <ol class="how">${how}</ol>
    <main class="grid">
      <section class="card">
        <label class="h" for="msg">${L('input.label')}</label>
        <textarea id="msg" placeholder="${esc(L('input.placeholder'))}" aria-describedby="hint" maxlength="${MAX_TEXT_CHARS}"></textarea>
        <div class="row">
          <label class="file muted">📎 ${L('input.image')} <input type="file" id="img" accept="${IMAGE_TYPES.join(',')}" /></label>
          <span id="thumb"></span>
        </div>
        <div class="row">
          <select id="samples" aria-label="${esc(L('input.samples'))}"><option value="">${L('input.samples')} (${SAMPLES.length})</option>${SAMPLES.map((s) => `<option value="${s.id}">${s.lang.toUpperCase()} · ${esc(s.label)}</option>`).join('')}</select>
        </div>
        <div class="row">
          <button class="primary" id="check">🔍 ${L('btn.check')}</button>
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
    // The page is rebuilt, so put keyboard focus back on the language switch.
    maybe<HTMLButtonElement>(`[data-lang="${uiLang}"]`)?.focus();
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
  if (text.length > MAX_TEXT_CHARS) {
    showInputError(L('input.too_long').replace('{max}', String(MAX_TEXT_CHARS)));
    return;
  }
  showInputError('');
  btn.disabled = true;
  last = undefined;
  renderBusy('status.checking');
  try {
    const out = await runCheck(text, img, {
      engine,
      online,
      uiLang,
      detectLanguage,
      askConsent: (mask, why, lang, withImage) => { renderEmpty(); return askConsent(mask, cloudReason(why, lang), withImage); },
      onCloudStart: () => renderBusy('status.checking.cloud'),
    });
    status = await engine.onDeviceStatus(!!img);
    if (!out.result) {
      // A screenshot with no text and no model: nothing can read it, so never report "looks OK".
      const r = out.route;
      // Mock mode never sends anything, so it doesn't claim the screenshot went out.
      const why = r.kind === 'failed' ? `${L(r.error)} ${r.attempted === 'cloud' && !mock() ? L('route.failed_sent_image') + ' ' : ''}` : '';
      return renderEmpty(`⚠️ ${esc(why)}${L('err.image_rules')}`);
    }
    last = { result: out.result, mask: out.mask, signals: out.signals, lang: out.lang, image: img, route: out.route };
    renderResult();
  } catch (e) {
    console.error(e);
    renderEmpty(`⚠️ ${esc(errorText(e))}`);
  } finally {
    btn.disabled = false;
  }
}

/** Rule-based verdict text is generated locally, so it can follow a UI language switch. */
function relocalizeLast() {
  if (!last) return;
  const { source } = last.result;
  if (source === 'rules' || source === 'mock_in_cloud') {
    last.result.verdict = rulesVerdict(last.signals, uiLang);
    last.result.lang = uiLang;
  }
}

function cloudReason(why: CloudWhy, lang: string | null) {
  if (why === 'second') return L('route.second');
  if (why === 'nomodel') return L('route.nomodel');
  if (why === 'image' || !lang) return L('route.image_only');
  const key = `lang.${lang}`;
  const name = L(key);
  return L('route.lang').replace('{lang}', name === key ? lang.toUpperCase() : name);
}

function highlightMasked(m: MaskResult) {
  return esc(m.masked).replace(/\[(RRN|CARD|PHONE|ACCOUNT|EMAIL|ID|CODE)_\d+\]/g, (x) => `<span class="mask">${x}</span>`);
}

function askConsent(mask: MaskResult, reason: string, withImage: boolean): Promise<boolean> {
  const d = $<HTMLDialogElement>('#consent');
  const hasText = !!mask.masked;
  const found = mask.findings.length
    ? `<div class="chips">${mask.findings.map((f) => `<span class="chip neutral">${L('pii.' + f.type)} → ${f.token}</span>`).join('')}</div>`
    : `<span class="muted">${L(withImage ? 'consent.none_text' : 'consent.none')}</span>`;
  // Nothing is scanned in a screenshot, so a screenshot-only dialog shows no "nothing found" reassurance.
  const findings = hasText ? `<h3>${L('consent.found')}</h3>${found}<p class="muted small">${L('consent.limits')}</p>` : '';
  const title = !withImage ? 'consent.title' : hasText ? 'consent.title_both' : 'consent.title_image';
  d.innerHTML = `
    <h2 id="consent-title">☁️ ${L(title)}</h2>
    <p class="muted">${esc(reason)}</p>
    <p>${L(!withImage ? 'consent.body' : hasText ? 'consent.body_image' : 'consent.body_image_only')}</p>
    <div class="mono" tabindex="0" aria-label="${esc(L('consent.preview'))}">${highlightMasked(mask) || L('consent.screenshot')}</div>
    ${withImage ? `<p class="route warn">⚠️ ${L('route.image')}</p>` : ''}
    ${findings}
    <div class="row end">
      <button id="cno">${L('consent.no')}</button>
      <button class="primary" id="cyes">${L(withImage ? 'consent.yes_image' : 'consent.yes')}</button>
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
  const { route, result } = c;
  const onDevice = result.source === 'on_device' || result.source === 'mock_on_device';
  switch (route.kind) {
    case 'private': return `<div class="route">🔒 ${L('route.private')}</div>`;
    case 'cloud': {
      // PREFER_ON_DEVICE may still have run on this device; describe what actually happened.
      if (onDevice) return `<div class="route">🔒 ${L('route.hybrid_device')}</div>`;
      const sent = !route.sentImage ? 'route.cloud_note' : c.mask.masked ? 'route.cloud_note_image' : 'route.cloud_note_image_only';
      return `<div class="route cloud">☁️ ${esc(cloudReason(route.why, c.lang))} ${L(sent)}</div>`;
    }
    case 'declined': return `<div class="route">🔒 ${L('consent.declined')}</div>`;
    case 'offline': return `<div class="route">📴 ${L('route.offline')}</div>`;
    case 'failed': {
      const sent = route.attempted !== 'cloud' ? '' : ` ${L(route.sentImage ? (c.mask.masked ? 'route.failed_sent_both' : 'route.failed_sent_image') : 'route.failed_sent')}`;
      return `<div class="route warn" role="alert">⚠️ ${esc(L(route.error))} ${L('route.failed')}${sent}</div>`;
    }
  }
}

function renderResult(error = '') {
  if (!last) return;
  const c = last;
  const { result: r, mask, signals } = c;
  const v = r.verdict;
  const onDevice = r.source === 'on_device' || r.source === 'mock_on_device';
  const inCloud = r.source === 'in_cloud' || r.source === 'mock_in_cloud';
  // Paths that may run on-device ask for English. When the UI is in another language, lead with the
  // localized local red flags and standard advice, and keep the model's English notes as secondary.
  const translateLocally = r.lang === 'en' && uiLang !== 'en';
  const localReasons = signals.map((s) => L('sig.' + s.id)).slice(0, 4);
  const actions = translateLocally || !v.actions.length ? defaultActions(v.risk_level, signals, uiLang) : v.actions;
  const reasons = translateLocally ? (localReasons.length ? localReasons : v.reasons) : v.reasons.length ? v.reasons : localReasons;
  const modelNotes = translateLocally && localReasons.length && v.reasons.length
    ? `<details class="muted"><summary>${L('result.model_notes')}</summary>${list(v.reasons)}</details>` : '';
  const sourceKey = inCloud && c.route.kind === 'cloud' && c.route.sentImage ? `${r.source}_${mask.masked ? 'image' : 'screenshot'}` : r.source;
  const prev = c.previous;
  const previous = prev
    ? `<p class="muted">${L('result.previous').replace('{score}', String(prev.verdict.risk_score)).replace('{level}', L('result.level.' + prev.verdict.risk_level))}</p>` : '';
  const localFlags = signals.length
    ? `<div class="chips">${signals.map((s) => `<span class="chip">${esc(L('sig.' + s.id))}</span>`).join('')}</div>`
    : `<span class="muted">${L('sig.none')}</span>`;
  const links = mask.urls.length
    ? `<h3>${L('result.links')}</h3><ul class="links">${mask.urls.map((u) => `<li><code>${esc(u.host)}</code> ${u.flags.map((f) => `<span class="chip">${L('flag.' + f)}</span>`).join(' ')}</li>`).join('')}</ul>`
    : '';
  // Offer the cloud when the on-device verdict is unsure, or when the on-device model failed.
  const deviceFailed = c.route.kind === 'failed' && c.route.attempted === 'device';
  const showSecond = online() && ((c.route.kind === 'private' && (v.risk_level === 'medium' || v.confidence < 0.6)) || deviceFailed);
  const sourceIcon = onDevice ? '📱' : inCloud ? '☁️' : '📏';

  $('#result').innerHTML = `
    <div class="verdict lv-${v.risk_level}">
      <div class="gauge" role="img" aria-label="${esc(L('a11y.score').replace('{score}', String(v.risk_score)))}" style="--v:${v.risk_score}"><span>${v.risk_score}</span></div>
      <div>
        <div class="level">${LEVEL_ICON[v.risk_level]} ${L('result.level.' + v.risk_level)}</div>
        <div class="muted">${L('result.type')}: ${L('type.' + v.scam_type)}${r.source === 'rules' ? '' : ` · ${L('result.confidence')} ${Math.round(v.confidence * 100)}%`}</div>
        <div class="badges"><span class="badge b-${r.source}">${sourceIcon} ${L('result.source.' + sourceKey)}</span>${r.ms ? `<span class="muted">${r.ms} ms</span>` : ''}</div>
      </div>
    </div>
    ${routeNote(c)}
    ${previous}
    <h3>${L('result.reasons')}</h3>${list(reasons)}
    ${modelNotes}
    ${translateLocally ? `<p class="muted">ℹ️ ${L('result.ondevice_en')}</p>` : ''}
    <h3>${L('result.actions')}</h3>${list(actions)}
    <h3>${L('result.localflags')}</h3>${localFlags}
    ${links}
    <div class="row actions">
      ${showSecond ? `<button id="second">☁️ ${L(deviceFailed ? 'result.cloud_instead' : 'result.second')}</button>` : ''}
      <button id="share">📋 ${L('result.share')}</button>
    </div>
    ${error ? `<p class="inline-error" role="alert">⚠️ ${esc(error)}</p>` : ''}
    ${inCloud ? `<h3><label for="q">${L('follow.title')}</label></h3><div id="ans" aria-live="polite">${(c.qa ?? []).map(qaHtml).join('')}</div><div class="follow"><input id="q" placeholder="${esc(L('follow.placeholder'))}" maxlength="500" /><button id="ask">${L('follow.ask')}</button></div>` : ''}`;

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
      const result = await secondOpinion(engine, c, uiLang);
      last = { ...c, result, previous: deviceFailed ? undefined : c.result, chat: undefined, qa: undefined, route: { kind: 'cloud', why: 'second', sentImage: !!c.image } };
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
        // One chat per result, so a second question can build on the first answer.
        c.chat ??= engine.startFollowUp({ maskedMessage: mask.masked, verdict: v, uiLang });
        const q2 = maskQuestion(question);
        const answer = await c.chat.ask(q2);
        (c.qa ??= []).push({ q: q2, a: answer });
        maybe('#ans .inline-error')?.remove();
        maybe('#ans')?.insertAdjacentHTML('beforeend', qaHtml({ q: q2, a: answer }));
        q.value = '';
      } catch (e) {
        console.warn('Follow-up failed:', e);
        maybe('#ans .inline-error')?.remove();
        maybe('#ans')?.insertAdjacentHTML('beforeend', `<p class="inline-error" role="alert">⚠️ ${esc(errorText(e))}</p>`);
      } finally {
        ask.disabled = false;
      }
    };
    ask.addEventListener('click', send);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  }
}

function qaHtml({ q, a }: { q: string; a: string }) {
  return `<div class="answer"><p class="muted">${esc(q)}</p>${esc(a)}</div>`;
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

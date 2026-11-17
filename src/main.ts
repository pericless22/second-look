import { maskPII, type MaskResult } from './pii.ts';
import { localSignals, type Signal } from './signals.ts';
import { detectLanguage, supportedOnDevice } from './lang.ts';
import { t } from './i18n.ts';
import { SAMPLES } from './samples.ts';
import type { Engine, CheckInput, OnDeviceStatus } from './engine.ts';
import { MockEngine, rulesVerdict } from './mock.ts';
import type { CheckResult } from './types.ts';

// ---------- state ----------
const params = new URLSearchParams(location.search);
let uiLang = params.get('lang') === 'ko' || (!params.get('lang') && navigator.language.startsWith('ko')) ? 'ko' : 'en';
let engine: Engine;
let image: CheckInput['image'] | undefined;
let last: { result: CheckResult; mask: MaskResult; signals: Signal[] } | undefined;
let status: OnDeviceStatus = 'unavailable';
const L = (k: string) => t(uiLang, k);
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

async function loadEngine(): Promise<Engine> {
  if (params.has('mock')) return new MockEngine();
  try {
    const r = await fetch('/firebase-config.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('no config');
    const cfg = await r.json();
    if (!cfg?.firebase?.apiKey || String(cfg.firebase.apiKey).startsWith('YOUR_')) throw new Error('placeholder config');
    const { FirebaseEngine } = await import('./firebase-engine.ts');
    return new FirebaseEngine(cfg);
  } catch {
    return new MockEngine();
  }
}

const isMock = () => engine.kind === 'mock';
const online = () => navigator.onLine && !(isMock() && (engine as MockEngine).offline);

// ---------- render shell ----------
function shell() {
  document.documentElement.lang = uiLang;
  $('#app').innerHTML = `
  <div class="wrap">
    <header>
      <div class="brand"><div class="logo">🔍</div><div><h1>Second Look</h1><p class="tag">${L('app.tagline')}</p></div></div>
      <div class="controls">
        <button class="pill ${uiLang === 'en' ? 'active' : ''}" data-lang="en">EN</button>
        <button class="pill ${uiLang === 'ko' ? 'active' : ''}" data-lang="ko">한국어</button>
        <button class="ghost" id="large" title="Large text">A+</button>
      </div>
    </header>
    ${isMock() ? `<div class="banner">⚠️ ${L('status.mock')}
      <span>${L('mock.sim')}:</span>
      <select id="sim"><option value="available">${L('mock.sim.available')}</option><option value="unavailable">${L('mock.sim.unavailable')}</option><option value="offline">${L('status.offline')}</option></select></div>` : ''}
    <p class="sub">${L('app.sub')}</p>
    <div class="grid">
      <section class="card">
        <label class="h" for="msg">${L('input.label')}</label>
        <textarea id="msg" placeholder="${esc(L('input.placeholder'))}"></textarea>
        <div class="row">
          <label class="muted">${L('input.image')} <input type="file" id="img" accept="image/png,image/jpeg" /></label>
          <span id="thumb"></span>
        </div>
        <div class="row">
          <select id="samples"><option value="">${L('input.samples')} (30)</option>${SAMPLES.map((s) => `<option value="${s.id}">${s.lang.toUpperCase()} · ${esc(s.label)}</option>`).join('')}</select>
        </div>
        <div class="row">
          <button class="primary" id="check">🔒 ${L('btn.check')}</button>
          <button class="ghost" id="clear">${L('btn.clear')}</button>
        </div>
        <div class="status" id="status"></div>
      </section>
      <section class="card" id="result"><div class="empty">🔍<br/>${uiLang === 'ko' ? '결과가 여기에 표시돼요' : 'Your result will appear here'}</div></section>
    </div>
    <footer>${L('footer')}</footer>
  </div>
  <dialog id="consent"></dialog>`;

  document.querySelectorAll<HTMLButtonElement>('[data-lang]').forEach((b) => b.onclick = () => { uiLang = b.dataset.lang!; setLang(); shell(); refreshStatus(); if (last) renderResult(last.result, last.mask, last.signals); });
  $('#large').onclick = () => document.body.classList.toggle('large');
  $<HTMLSelectElement>('#samples').onchange = (e) => {
    const s = SAMPLES.find((x) => x.id === (e.target as HTMLSelectElement).value);
    if (s) $<HTMLTextAreaElement>('#msg').value = s.text;
  };
  $('#clear').onclick = () => { $<HTMLTextAreaElement>('#msg').value = ''; image = undefined; $('#thumb').innerHTML = ''; last = undefined; shell(); refreshStatus(); };
  $<HTMLInputElement>('#img').onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const dataUrl = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(f); });
    image = { mimeType: f.type, base64: dataUrl.split(',')[1] };
    $('#thumb').innerHTML = `<img class="thumb" src="${dataUrl}" alt="screenshot" />`;
  };
  $('#check').onclick = check;
  const sim = document.querySelector<HTMLSelectElement>('#sim');
  if (sim) {
    const m = engine as MockEngine;
    sim.value = m.offline ? 'offline' : m.status === 'available' ? 'available' : 'unavailable';
    sim.onchange = () => {
      m.offline = sim.value === 'offline';
      m.status = sim.value === 'unavailable' ? 'unavailable' : 'available';
      refreshStatus();
    };
  }
}

function setLang() {
  if (isMock()) (engine as MockEngine).uiLang = uiLang;
  import('./firebase-engine.ts').then((m) => m.setEngineUiLang(uiLang)).catch(() => {});
}

async function refreshStatus() {
  status = await engine.onDeviceStatus(false);
  const el = $('#status');
  if (!el) return;
  const cls = status === 'available' ? 'ok' : status === 'unavailable' ? 'bad' : 'warn';
  const off = !online() ? ` · ${L('status.offline')}` : '';
  el.innerHTML = `<span class="dot ${cls}"></span><span>${L('status.title')}: ${L('status.' + status)}${off}</span>` +
    (status === 'downloadable' ? ` <button id="dl">${L('btn.download')}</button><div class="progress"><i id="bar"></i></div>` : '');
  const dl = document.querySelector<HTMLButtonElement>('#dl');
  if (dl) dl.onclick = async () => {
    dl.disabled = true;
    await engine.downloadOnDevice((p) => { const b = document.querySelector<HTMLElement>('#bar'); if (b) b.style.width = `${Math.round(p * 100)}%`; });
    refreshStatus();
  };
}

// ---------- core flow ----------
async function check() {
  const text = $<HTMLTextAreaElement>('#msg').value.trim();
  if (!text && !image) return;
  const btn = $<HTMLButtonElement>('#check');
  btn.disabled = true;
  try {
    const mask = maskPII(text);
    const signals = localSignals(text, mask);
    const lang = text ? await detectLanguage(text) : 'en';
    status = await engine.onDeviceStatus(!!image);
    const canLocal = status === 'available' && supportedOnDevice(lang);

    if (canLocal) {
      // 1) Private path: raw text, ONLY_ON_DEVICE. Never leaves the device.
      const result = await engine.privateCheck({ text, image, lang, signals });
      return renderResult(result, mask, signals, 'private');
    }
    const reason = !supportedOnDevice(lang) ? L('route.lang').replace('{lang}', L('lang.' + lang)) : L('route.nomodel');
    if (!online()) {
      return renderResult(rulesOnly(text, signals), mask, signals, 'rules');
    }
    // 2) Needs the cloud: ask consent, show exactly the masked text that would be sent.
    const ok = await askConsent(mask, reason);
    if (!ok) return renderResult(rulesOnly(text, signals), mask, signals, 'declined');
    const input = { text: mask.masked, image, lang, signals };
    const result = supportedOnDevice(lang) ? await engine.hybridCheck(input) : await engine.cloudCheck(input);
    renderResult(result, mask, signals, 'cloud', reason);
  } catch (e) {
    $('#result').innerHTML = `<div class="empty">⚠️ ${L('err')}: ${esc(String((e as Error).message ?? e))}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function rulesOnly(text: string, signals: Signal[]): CheckResult {
  return { verdict: rulesVerdict(signals, uiLang), source: 'rules' as any, sentText: text, ms: 0 };
}

function highlightMasked(m: MaskResult) {
  return esc(m.masked).replace(/\[(RRN|CARD|PHONE|ACCOUNT|EMAIL)_\d+\]/g, (x) => `<span class="mask">${x}</span>`);
}

function askConsent(mask: MaskResult, reason: string): Promise<boolean> {
  const d = $<HTMLDialogElement>('#consent');
  const found = mask.findings.length
    ? `<div class="chips">${mask.findings.map((f) => `<span class="chip neutral">${L('pii.' + f.type)} → ${f.token}</span>`).join('')}</div>`
    : `<span class="muted">${L('consent.none')}</span>`;
  d.innerHTML = `
    <h2 style="margin-top:0">☁️ ${L('consent.title')}</h2>
    <p class="muted">${esc(reason)}</p>
    <p>${L('consent.body')}</p>
    <div class="mono">${highlightMasked(mask) || '(screenshot)'}</div>
    ${image ? `<p class="muted">⚠️ ${L('route.image')}</p>` : ''}
    <h3>${L('consent.found')}</h3>${found}
    <div class="row" style="justify-content:flex-end;margin-top:18px">
      <button id="cno">${L('consent.no')}</button>
      <button class="primary" id="cyes">${L('consent.yes')}</button>
    </div>`;
  d.showModal();
  return new Promise((res) => {
    $('#cyes').onclick = () => { d.close(); res(true); };
    $('#cno').onclick = () => { d.close(); res(false); };
    d.oncancel = () => res(false);
  });
}

type Route = 'private' | 'cloud' | 'rules' | 'declined' | undefined;
let lastRoute: Route; let lastReason = '';

function renderResult(r: CheckResult, mask: MaskResult, signals: Signal[], route: Route = lastRoute, reason = lastReason) {
  last = { result: r, mask, signals }; lastRoute = route; lastReason = reason;
  const v = r.verdict;
  const color = v.risk_level === 'high' ? 'var(--high)' : v.risk_level === 'medium' ? 'var(--med)' : 'var(--low)';
  const src = String(r.source);
  const onDevice = src.includes('on_device');
  const routeMsg = route === 'private' ? `<div class="route">🔒 ${L('route.private')}</div>`
    : route === 'cloud' ? `<div class="route cloud">☁️ ${esc(reason)} ${uiLang === 'ko' ? '가린 텍스트만 보냈어요.' : 'Only masked text was sent.'}</div>`
    : route === 'declined' ? `<div class="route">🔒 ${L('consent.declined')}</div>`
    : route === 'rules' ? `<div class="route">📴 ${L('status.offline')}</div>` : '';
  const localFlags = signals.length ? `<div class="chips">${signals.map((s) => `<span class="chip">${esc(L('sig.' + s.id))}</span>`).join('')}</div>` : `<span class="muted">${L('sig.none')}</span>`;
  const links = mask.urls.length ? `<h3>${L('result.links')}</h3><ul>${mask.urls.map((u) => `<li><code>${esc(u.host)}</code> ${u.flags.map((f) => `<span class="chip">${L('flag.' + f)}</span>`).join(' ')}</li>`).join('')}</ul>` : '';
  const showSecond = route === 'private' && online() && (v.risk_level === 'medium' || v.confidence < 0.6);
  $('#result').innerHTML = `
    <div class="score">
      <div class="gauge" style="--v:${v.risk_score};--c:${color}"><span>${v.risk_score}</span></div>
      <div>
        <div class="level lv-${v.risk_level}">${L('result.level.' + v.risk_level)}</div>
        <div class="muted">${L('result.type')}: ${L('type.' + v.scam_type)} · ${L('result.confidence')} ${Math.round(v.confidence * 100)}%</div>
        <div style="margin-top:6px"><span class="badge b-${src}">${onDevice ? '📱' : src === 'rules' ? '📏' : '☁️'} ${L('result.source.' + src)}</span> <span class="muted">${r.ms ? r.ms + ' ms' : ''}</span></div>
      </div>
    </div>
    ${routeMsg}
    <h3>${L('result.reasons')}</h3><ul>${v.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    ${onDevice && uiLang !== 'en' ? `<p class="muted">ℹ️ ${L('result.ondevice_en')}</p>` : ''}
    <h3>${L('result.actions')}</h3><ul>${(onDevice && uiLang !== 'en' ? localActions(v.risk_level) : v.actions).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <h3>${uiLang === 'ko' ? '기기에서 찾은 위험 신호' : 'Red flags found on-device'}</h3>${localFlags}
    ${links}
    <div class="row" style="margin-top:16px">
      ${showSecond ? `<button id="second">☁️ ${L('result.second')}</button>` : ''}
      <button id="share">📋 ${L('result.share')}</button>
    </div>
    ${src.includes('cloud') ? `<h3>${L('follow.title')}</h3><div class="follow"><input id="q" placeholder="${esc(L('follow.placeholder'))}" /><button id="ask">${L('follow.ask')}</button></div><div id="ans"></div>` : ''}`;

  const share = $('#share');
  share.onclick = async () => {
    const txt = `[Second Look] ${L('result.level.' + v.risk_level)} (${v.risk_score}/100) · ${L('type.' + v.scam_type)}\n- ${v.reasons.join('\n- ')}\n${L('result.actions')}:\n- ${(onDevice && uiLang !== 'en' ? localActions(v.risk_level) : v.actions).join('\n- ')}`;
    try { await navigator.clipboard.writeText(txt); share.textContent = '✅ ' + L('result.copied'); } catch { /* ignore */ }
  };
  const second = document.querySelector<HTMLButtonElement>('#second');
  if (second) second.onclick = async () => {
    const ok = await askConsent(mask, uiLang === 'ko' ? '2차 의견을 위해 클라우드 Gemini에 물어봅니다.' : 'Asking Gemini in the cloud for a second opinion.');
    if (!ok) return;
    second.disabled = true;
    const lang = await detectLanguage($<HTMLTextAreaElement>('#msg').value);
    const res = await engine.cloudCheck({ text: mask.masked, image, lang, signals });
    renderResult(res, mask, signals, 'cloud', uiLang === 'ko' ? '2차 의견:' : 'Second opinion:');
  };
  const ask = document.querySelector<HTMLButtonElement>('#ask');
  if (ask) ask.onclick = async () => {
    const q = $<HTMLInputElement>('#q').value.trim();
    if (!q) return;
    ask.disabled = true;
    try { $('#ans').innerHTML = `<div class="answer">${esc(await engine.followUp(mask.masked, v, maskPII(q).masked, uiLang))}</div>`; }
    finally { ask.disabled = false; }
  };
}

function localActions(level: string) {
  return level === 'low' ? [L('act.low1')] : [L('act.noclick'), L('act.verify'), L('act.report'), ...(level === 'high' ? [L('act.block')] : [])];
}

// ---------- boot ----------
(async () => {
  engine = await loadEngine();
  setLang();
  shell();
  await refreshStatus();
  window.addEventListener('online', refreshStatus);
  window.addEventListener('offline', refreshStatus);
  // Demo hooks for automated screenshots: ?sample=ko03&auto=1
  const s = SAMPLES.find((x) => x.id === params.get('sample'));
  if (s) { $<HTMLTextAreaElement>('#msg').value = s.text; if (params.has('sim') && isMock()) { const m = engine as MockEngine; m.status = params.get('sim') === 'unavailable' ? 'unavailable' : 'available'; shell(); $<HTMLTextAreaElement>('#msg').value = s.text; refreshStatus(); } if (params.has('auto')) check(); }
})();

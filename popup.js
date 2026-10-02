'use strict';

/* DeKo – Toman Converter — popup logic (v2.3, Persian RTL, animated live UI)
 * --------------------------------------------------------------------------
 * Live behaviour:
 *   - On open: paint cached rates instantly, then force a FULL live refresh
 *     (12 native tgju currencies + rate-json + er-api in parallel).
 *   - While open: silent auto-refresh every 60s + progress bar + countdown.
 *   - Numbers COUNT UP to their new value (rAF, ease-out) and flash when a
 *     rate actually changed; unchanged polls never animate.
 *   - Persian numbers are formatted with Intl fa-IR (real Persian digits,
 *     U+066C thousands + U+066B decimal) and rendered in the bundled
 *     Vazirmatn font — crisp, standard, beautiful.
 *   - Every currency shows its DAILY CHANGE chip (from tgju) and a 7-day
 *     sparkline drawn from real closes; both animate in.
 *   - Every visible rate change is mirrored from the background via the
 *     DEKO_RATES_UPDATED broadcast too.
 *   - Buttons ripple, the refresh icon spins, toasts slide in.              */

const SETTINGS_KEY = 'deko2_settings';
const RATES_KEY = 'deko2_rates';
const CHAT_KEY = 'deko2_chat';
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
const AUTO_EVERY_SEC = 60;      // silent auto-refresh while popup is open
const GRID_MAX = 6;             // secondary currencies shown in the grid
const COUNT_MS = 750;           // number count-up duration
const CHAT_MAX = 40;            // messages kept in storage

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const toFa = (s) => String(s).replace(/\d/g, (d) => FA_DIGITS[+d]);

/* --- standard Persian number formatting (Intl fa-IR) ---------------------- */
/* fa-IR gives exactly what Persian financial UIs use: extended Arabic-Indic
 * digits (۰-۹), U+066C ٬ as the thousands separator and U+066B ٫ for
 * decimals. Falls back to manual conversion on ancient engines.            */
let NF_FA0 = null;
let NF_FA2 = null;
try { NF_FA0 = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 0 }); } catch (e) {}
try { NF_FA2 = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 2 }); } catch (e) {}

function fmtToman(n) {
  const v = Math.round(n);
  if (NF_FA0) return NF_FA0.format(v);
  return toFa(String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '٬'));
}

function fmtPct(p) {
  if (!Number.isFinite(p)) return '';
  const v = Math.abs(p);
  const body = NF_FA2 ? NF_FA2.format(v) : toFa(String(v));
  return body + '٪';
}

const GRID_ORDER = ['EUR', 'GBP', 'AED', 'TRY', 'CNY', 'CAD', 'AUD', 'JPY', 'SAR', 'INR', 'CHF', 'RUB'];
const CURRENCY_NAME = {
  EUR: 'یورو', GBP: 'پوند انگلیس', AED: 'درهم امارات', TRY: 'لیر ترکیه',
  CNY: 'یوان چین', CAD: 'دلار کانادا', AUD: 'دلار استرالیا', JPY: 'ین ژاپن',
  SAR: 'ریال سعودی', INR: 'روپیه هند', CHF: 'فرانک سوئیس', RUB: 'روبل روسیه',
};
const FLAG = {
  USD: 'flag-us.svg', EUR: 'flag-eu.svg', GBP: 'flag-gb.svg', AED: 'flag-ae.svg',
  TRY: 'flag-tr.svg', CNY: 'flag-cn.svg', CAD: 'flag-ca.svg', AUD: 'flag-au.svg',
  JPY: 'flag-jp.svg', SAR: 'flag-sa.svg', INR: 'flag-in.svg', CHF: 'flag-ch.svg',
  RUB: 'flag-ru.svg',
};

const DEFAULT_SETTINGS = {
  enabled: true,
  disabledSites: [],
  displayMode: 'append',
  digits: 'fa',
  compact: true,
  dollarSymbol: 'USD',
  yenSymbol: 'JPY',
  manualRates: {},
  manualOverride: false,
  aiLLM: { enabled: false, endpoint: '', key: '', model: '' },   // v2.4 optional real LLM
};

let settings = Object.assign({}, DEFAULT_SETTINGS);
let ratesCache = null;
let currentHost = null;
let tick = 0;          // seconds since last successful refresh
let fetching = false;
let gridKeys = '';

/* -------------------------------- helpers -------------------------------- */

function relativeTime(ts) {
  const d = Math.max(0, Date.now() - (ts || 0));
  if (d < 5000) return 'همین الان';
  if (d < 60000) return toFa(Math.floor(d / 1000)) + ' ثانیه پیش';
  const m = Math.floor(d / 60000);
  if (m < 60) return toFa(m) + ' دقیقه پیش';
  const h = Math.floor(m / 60);
  if (h < 24) return toFa(h) + ' ساعت پیش';
  return toFa(Math.floor(h / 24)) + ' روز پیش';
}

function prettySource(s) {
  return String(s || '')
    .replace(/arzdigital\.com/g, 'arzdigital')
    .replace(/tgju\.org full \(Rial\/10\)/g, 'tgju')
    .replace(/tgju\.org \(Rial\/10\)/g, 'tgju')
    .replace(/rate-json\/default/g, 'rate-json')
    .replace(/open\.er-api\.com/g, 'er-api')
    .replace(/manual/g, 'دستی');
}

function toast(msg, kind) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + (kind === 'err' ? 'err' : 'ok');
  // retrigger the slide-in animation
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

function flashEl(el) {
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('flash');
}

/* ------------------------- animated count-up values ----------------------- */

function animateValue(el, to, fmt) {
  const from = el._dekoLast;
  el._dekoLast = to;
  if (from == null || from === to) {
    el.textContent = fmt(to);
    return;
  }
  if (el._dekoRaf) cancelAnimationFrame(el._dekoRaf);
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / COUNT_MS);
    const e = 1 - Math.pow(1 - p, 3); // ease-out cubic
    el.textContent = fmt(from + (to - from) * e);
    if (p < 1) {
      el._dekoRaf = requestAnimationFrame(step);
    } else {
      el._dekoRaf = null;
      el.textContent = fmt(to);
      flashEl(el);
    }
  };
  el._dekoRaf = requestAnimationFrame(step);
}

/* ----------------------------- change + spark ----------------------------- */

function setChangeChip(el, ch) {
  if (!el) return;
  if (!ch || !Number.isFinite(ch.pct)) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const flat = ch.pct === 0 || ch.up == null;
  const up = ch.up === true;
  /* direction comes from ch.up (carried by the background from tgju's
   * high/low class) — the pct value itself is a magnitude */
  el.className = 'chg ' + (flat ? 'flat' : up ? 'up' : 'down');
  el.textContent = flat ? 'بدون تغییر' : (up ? '▲ ' : '▼ ') + fmtPct(ch.pct);
}

/** Tiny area+line SVG from real closes (oldest -> newest). Colored by trend. */
/* v2.5: the 7-day closes come from tgju while the live value may come from
 * arzdigital — the drawn spark must still END at the value actually shown,
 * otherwise the end dot visually hangs away from the big number. The stored
 * history stays source-pure; the current point is appended at DRAW time. */
function withLive(points, current) {
  if (!Array.isArray(points) || !points.length) return points;
  if (!Number.isFinite(current) || current <= 0) return points;
  const last = points[points.length - 1];
  if (Math.abs(last - current) / current <= 0.001) return points;
  return points.concat([current]);
}

function sparkSVG(points, up) {
  if (!Array.isArray(points) || points.length < 2) return '';
  const w = 100;
  const h = 30;
  const pad = 2.5;
  const min = Math.min.apply(null, points);
  const max = Math.max.apply(null, points);
  const range = (max - min) || Math.abs(max) / 50 || 1;
  const stepX = (w - pad * 2) / (points.length - 1);
  const xy = points.map((p, i) => [
    pad + i * stepX,
    h - pad - ((p - min) / range) * (h - pad * 2),
  ]);
  const line = xy.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const area = pad + ',' + (h - pad) + ' ' + line + ' ' + (w - pad).toFixed(1) + ',' + (h - pad);
  const col = up === false ? '#f87171' : '#34d399';
  const last = xy[xy.length - 1];
  return '<svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">' +
    '<polygon points="' + area + '" fill="' + col + '" opacity="0.13"/>' +
    '<polyline class="spark-line" pathLength="1" points="' + line + '" fill="none" stroke="' + col + '" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle class="spark-dot" cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2.1" fill="' + col + '"/>' +
    '</svg>';
}

function setSpark(el, points, up) {
  if (!el) return;
  const key = Array.isArray(points) ? points.join('|') + '#' + (up ? 1 : 0) : '';
  if (el._dekoKey === key) return;      // unchanged -> no churn, no replay
  el._dekoKey = key;
  if (!key) { el.innerHTML = ''; return; }
  const svg = sparkSVG(points, up);
  if (svg) {
    el.innerHTML = svg;
    el.classList.add('has');
  } else {
    el.innerHTML = '';
    el.classList.remove('has');
  }
}

/* -------------------------------- rendering ------------------------------- */

function render() {
  document.getElementById('enabled').checked = !!settings.enabled;

  const siteRow = document.getElementById('siteRow');
  if (currentHost) {
    siteRow.classList.remove('hidden');
    document.getElementById('host').textContent = currentHost;
    const disabled = (settings.disabledSites || []).includes(currentHost);
    document.getElementById('siteEnabled').checked = !disabled;
  } else {
    siteRow.classList.add('hidden');
  }

  const r = ratesCache && ratesCache.rates;
  const usdEl = document.getElementById('usd');
  if (r && r.usdToToman != null) {
    usdEl.classList.remove('skel');
    animateValue(usdEl, r.usdToToman, fmtToman);
  } else {
    usdEl.textContent = '—';
    usdEl._dekoLast = null;
    usdEl.classList.add('skel');
  }

  const ch = ratesCache && ratesCache.changes ? ratesCache.changes.USD : null;
  const hist = ratesCache && ratesCache.history ? ratesCache.history.USD : null;
  setChangeChip(document.getElementById('usdChg'), ch);
  setSpark(document.getElementById('usdSpark'),
    withLive(hist, r ? r.usdToToman : null), ch ? ch.up : null);

  renderGrid(r ? r.perCurrency : null);
  renderSources(ratesCache ? ratesCache.source : '');

  const stale = document.getElementById('stale');
  /* v2.5: freshness is measured from OUR last fetch attempt, not the
   * source's own timestamp — arzdigital serves its index from a short
   * server-side cache, so the page's internal stamp can lag a few minutes
   * behind even a fetch that happened just now. From the user's point of
   * view "updated" = "we just went and got the latest available rates". */
  const touchedAt = ratesCache
    ? Math.max(ratesCache.lastAttempt || 0, ratesCache.updatedAt || 0)
    : 0;
  const isStale = ratesCache && (ratesCache.stale || (Date.now() - touchedAt) > STALE_AFTER_MS);
  stale.classList.toggle('hidden', !isStale);

  updateTicker();
}

function makeCell(code, i) {
  const cell = document.createElement('div');
  cell.className = 'cell in';
  cell.dataset.cur = code;
  cell.style.animationDelay = (i * 55) + 'ms';

  const top = document.createElement('div');
  top.className = 'cell-top';

  const fl = document.createElement('span');
  fl.className = 'cflag';
  const img = document.createElement('img');
  img.src = 'flags/' + (FLAG[code] || 'flag-us.svg');
  img.alt = code;
  img.draggable = false;
  fl.appendChild(img);

  const cd = document.createElement('span');
  cd.className = 'code';
  cd.textContent = code;

  const chg = document.createElement('span');
  chg.className = 'chg hidden';

  top.appendChild(fl);
  top.appendChild(cd);
  top.appendChild(chg);

  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = CURRENCY_NAME[code] || code;

  const val = document.createElement('div');
  val.className = 'val';
  val.textContent = '—';

  const spark = document.createElement('div');
  spark.className = 'spark';
  spark.dir = 'ltr';

  cell.appendChild(top);
  cell.appendChild(nm);
  cell.appendChild(val);
  cell.appendChild(spark);
  return cell;
}

function renderGrid(per) {
  const grid = document.getElementById('grid');
  const codes = per ? GRID_ORDER.filter((c) => per[c] != null).slice(0, GRID_MAX) : [];
  const key = codes.join(',');

  if (key !== gridKeys) {
    gridKeys = key;
    grid.textContent = '';
    if (!codes.length) {
      // shimmering placeholders while the first fetch is in flight
      for (let i = 0; i < 6; i++) {
        const c = document.createElement('div');
        c.className = 'cell skel-cell';
        grid.appendChild(c);
      }
      return;
    }
    codes.forEach((code, i) => grid.appendChild(makeCell(code, i)));
  }

  const changes = ratesCache && ratesCache.changes ? ratesCache.changes : {};
  const history = ratesCache && ratesCache.history ? ratesCache.history : {};
  codes.forEach((code) => {
    const cell = grid.querySelector('[data-cur="' + code + '"]');
    if (!cell) return;
    const val = cell.querySelector('.val');
    animateValue(val, per[code], fmtToman);
    setChangeChip(cell.querySelector('.chg'), changes[code]);
    const ch = changes[code];
    setSpark(cell.querySelector('.spark'),
      withLive(history[code], per[code]), ch ? ch.up : null);
  });
}

function renderSources(source) {
  const box = document.getElementById('srcs');
  const parts = prettySource(source).split(' + ').filter(Boolean);
  if (!parts.length) { box.textContent = ''; return; }
  if (box.dataset.src === parts.join('|')) return; // unchanged -> no churn
  box.dataset.src = parts.join('|');
  box.textContent = '';
  parts.forEach((p, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '·';
      box.appendChild(sep);
    }
    const s = document.createElement('span');
    s.className = 'src';
    s.textContent = p;
    s.style.animationDelay = (i * 70) + 'ms';
    box.appendChild(s);
  });
}

function updateTicker() {
  if (fetching) return; // status line is showing the fetch state
  const nextEl = document.getElementById('next');
  const bar = document.getElementById('bar');
  const pos = tick % AUTO_EVERY_SEC;
  nextEl.textContent = toFa(AUTO_EVERY_SEC - pos);
  bar.style.width = (pos / AUTO_EVERY_SEC) * 100 + '%';

  const upd = document.getElementById('updated');
  if (ratesCache && ratesCache.rates) {
    /* v2.5: freshness = our last fetch attempt (see renderAll note) */
    const touchedAt = Math.max(ratesCache.lastAttempt || 0, ratesCache.updatedAt || 0);
    // pure Persian text here; the source chips live in their own LTR row
    upd.textContent = 'بروزرسانی: ' + relativeTime(touchedAt);
  } else {
    upd.textContent = 'هنوز نرخی دریافت نشده است';
  }
}

/* ------------------------------ live refresh ------------------------------ */

/** order-independent stringify: key order may differ between passes even
 *  when the values are identical */
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

async function liveRefresh(opts) {
  const full = !!(opts && opts.full);
  const quiet = !!(opts && opts.quiet);
  if (fetching) return;
  fetching = true;

  const btn = document.getElementById('refresh');
  btn.classList.add('spin');
  btn.disabled = true;
  document.getElementById('statusDot').className = 'dot busy';
  document.getElementById('updated').textContent = 'در حال دریافت نرخ لحظه‌ای…';

  const before = ratesCache ? stableStringify(ratesCache.rates) : null;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'DEKO_REFRESH', full });
    if (!resp || !resp.ok || !resp.cache || !resp.cache.rates) {
      throw new Error('bad response');
    }
    ratesCache = resp.cache;
    tick = 0;
    render();
    document.getElementById('statusDot').className = 'dot ok';
    const after = stableStringify(ratesCache.rates);
    if (before !== after) {
      if (!quiet) toast('نرخ‌ها لحظه‌ای بروز شد ✓', 'ok');
    } else if (!quiet) {
      toast('نرخ‌ها از قبل بروز بود ✓', 'ok');
    }
  } catch (e) {
    document.getElementById('statusDot').className = 'dot err';
    document.getElementById('updated').textContent = 'دریافت ناموفق بود — تلاش دوباره…';
    if (!quiet) toast('اتصال برقرار نشد؛ اینترنت را بررسی کنید', 'err');
  } finally {
    fetching = false;
    btn.classList.remove('spin');
    btn.disabled = false;
    updateTicker();
  }
}

/* --------------------------------- ripple --------------------------------- */

function addRipple(e) {
  const btn = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  const d = Math.max(rect.width, rect.height);
  const rip = document.createElement('span');
  rip.className = 'ripple';
  rip.style.width = rip.style.height = d + 'px';
  rip.style.left = (e.clientX - rect.left - d / 2) + 'px';
  rip.style.top = (e.clientY - rect.top - d / 2) + 'px';
  btn.appendChild(rip);
  setTimeout(() => rip.remove(), 700);
}

/* -------------------------------- settings -------------------------------- */

async function loadAll() {
  const st = await chrome.storage.local.get([SETTINGS_KEY, RATES_KEY]);
  settings = Object.assign({}, DEFAULT_SETTINGS, st[SETTINGS_KEY] || {});
  if (st[SETTINGS_KEY] && st[SETTINGS_KEY].aiLLM) {
    settings.aiLLM = Object.assign(
      { enabled: false, endpoint: '', key: '', model: '' }, st[SETTINGS_KEY].aiLLM);
  }
  ratesCache = st[RATES_KEY] || null;
  render();
}

async function saveSettings() {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

async function detectHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && /^https?:/i.test(tab.url)) {
      const u = new URL(tab.url);
      currentHost = u.hostname.replace(/^www\./, '') || null;
    }
  } catch (e) { currentHost = null; }
}

/* -------------------------------- listeners ------------------------------- */

document.getElementById('enabled').addEventListener('change', async (e) => {
  settings.enabled = e.target.checked;
  await saveSettings();
});

document.getElementById('siteEnabled').addEventListener('change', async (e) => {
  if (!currentHost) return;
  const list = new Set(settings.disabledSites || []);
  if (e.target.checked) list.delete(currentHost);
  else list.add(currentHost);
  settings.disabledSites = [...list];
  await saveSettings();
});

document.getElementById('refresh').addEventListener('click', () => {
  liveRefresh({ full: true, quiet: false });
});

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ripple on every button
for (const id of ['refresh', 'openOptions']) {
  document.getElementById(id).addEventListener('pointerdown', addRipple);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[RATES_KEY]) ratesCache = changes[RATES_KEY].newValue || null;
  if (changes[SETTINGS_KEY]) {
    settings = Object.assign({}, DEFAULT_SETTINGS, changes[SETTINGS_KEY].newValue || {});
  }
  render();
});

// background broadcast -> instant re-render even for refreshes we did not ask for
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'DEKO_RATES_UPDATED' && msg.cache && msg.cache.rates) {
    ratesCache = msg.cache;
    render();
  }
});

/* ================== v2.4: DeKo AI — unified in one panel ==================
 * No tabs: the assistant lives INSIDE the same panel as the rates (like the
 * top open-source converter extensions). Local engine (deko-ai.js) answers
 * EVERYTHING offline with the live rates. If the user connected an
 * OpenAI-compatible LLM in options, the same chat upgrades to that model
 * (system prompt + live rates); any failure falls back to the local engine
 * so the assistant NEVER dies.                                          */

const AI_CHIPS = [
  '۱۰۰ دلار چنده؟',
  'نرخ یورو چند تومانه؟',
  '۲۵ میلیون تومان چند دلاره؟',
  'روند دلار چطوره؟',
  'هفته پیش ۱۰۰۰ دلار خریده بودم، الان چطوره؟',
];

let chatMsgs = [];        // [{role:'user'|'bot', text, ts}]
let chatBusy = false;

function chatTime(ts) {
  const d = new Date(ts || Date.now());
  return toFa(String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'));
}

function bubbleEl(role, text, ts) {
  const el = document.createElement('div');
  el.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
  el.textContent = text;
  const t = document.createElement('span');
  t.className = 'm-time';
  t.textContent = chatTime(ts);
  el.appendChild(t);
  return el;
}

function chatAppend(role, text, ts) {
  const box = document.getElementById('chat');
  const el = bubbleEl(role, text, ts);
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

function showTyping() {
  const box = document.getElementById('chat');
  const el = document.createElement('div');
  el.className = 'msg bot typing';
  el.id = 'typing';
  for (let i = 0; i < 3; i++) {
    const d = document.createElement('i');
    d.className = 'tdot';
    el.appendChild(d);
  }
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function hideTyping() {
  const el = document.getElementById('typing');
  if (el) el.remove();
}

async function saveChat() {
  try { await chrome.storage.local.set({ [CHAT_KEY]: chatMsgs.slice(-CHAT_MAX) }); } catch (e) { /* ignore */ }
}

/** optional real-LLM path (OpenAI-compatible /chat/completions) */
async function askLLM(text) {
  const cfg = settings.aiLLM || {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const messages = [
      {
        role: 'system',
        content: DeKoAI.SYSTEM_PROMPT +
          '\n\nنرخ‌های زندهٔ فعلی (تومان):\n' + DeKoAI.buildLLMContext(ratesCache),
      },
      ...chatMsgs.slice(-10).map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.text,
      })),
      { role: 'user', content: text },
    ];
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (cfg.key || ''),
      },
      body: JSON.stringify({
        model: cfg.model || 'gpt-4o-mini',
        messages,
        temperature: 0.3,
        max_tokens: 300,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const out = data && data.choices && data.choices[0] && data.choices[0].message &&
      data.choices[0].message.content;
    if (!out) throw new Error('bad LLM response');
    return String(out).trim();
  } finally {
    clearTimeout(timer);
  }
}

function llmConfigured() {
  const c = settings.aiLLM || {};
  return !!(c.enabled && c.endpoint && c.key);
}

async function aiAnswer(text) {
  if (llmConfigured()) {
    try {
      const out = await askLLM(text);
      if (out) return out;
    } catch (e) {
      toast('اتصال به LLM برقرار نشد؛ موتور داخلی جواب داد', 'err');
    }
  }
  return DeKoAI.answer(text, ratesCache).text;
}

async function chatSend(text) {
  text = String(text || '').trim();
  if (!text || chatBusy) return;
  chatBusy = true;
  const sendBtn = document.getElementById('aiSend');
  sendBtn.disabled = true;

  chatMsgs.push({ role: 'user', text, ts: Date.now() });
  chatAppend('user', text);
  await saveChat();

  document.getElementById('aiStatus').textContent = 'در حال فکر کردن…';
  showTyping();
  const delay = llmConfigured() ? 0 : 380 + Math.random() * 420;
  if (delay) await new Promise((r) => setTimeout(r, delay));
  let out;
  try {
    out = await aiAnswer(text);
  } catch (e) {
    out = 'خطایی پیش آمد؛ دوباره بپرس.';
  }
  hideTyping();
  document.getElementById('aiStatus').textContent = 'آنلاین · متصل به نرخ زنده';

  chatMsgs.push({ role: 'bot', text: out, ts: Date.now() });
  chatAppend('bot', out);
  await saveChat();
  chatBusy = false;
  sendBtn.disabled = false;
  document.getElementById('aiInput').focus();
}

function renderChips() {
  const box = document.getElementById('chips');
  box.textContent = '';
  AI_CHIPS.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = c;
    b.style.animationDelay = (i * 70) + 'ms';
    b.addEventListener('click', () => chatSend(c));
    box.appendChild(b);
  });
}

async function initChat() {
  const st = await chrome.storage.local.get(CHAT_KEY);
  chatMsgs = Array.isArray(st[CHAT_KEY]) ? st[CHAT_KEY].slice(-CHAT_MAX) : [];

  const box = document.getElementById('chat');
  box.textContent = '';
  if (!chatMsgs.length) {
    // seed with the assistant's greeting (no storage write until user talks)
    const welcome = DeKoAI.answer('سلام', null).text;
    chatMsgs.push({ role: 'bot', text: welcome, ts: Date.now() });
  }
  for (const m of chatMsgs) chatAppend(m.role, m.text, m.ts);

  // "LLM فعال" badge when a real model is connected
  if (llmConfigured()) {
    const b = document.createElement('span');
    b.className = 'llm-badge';
    b.textContent = 'LLM فعال';
    document.querySelector('#page-ai .ai-names small').appendChild(b);
  }

  renderChips();

  document.getElementById('aiForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('aiInput');
    const v = input.value;
    input.value = '';
    chatSend(v);
  });

  document.getElementById('chatClear').addEventListener('click', async () => {
    chatMsgs = [];
    await saveChat();
    box.textContent = '';
    const welcome = DeKoAI.answer('سلام', null).text;
    chatMsgs.push({ role: 'bot', text: welcome, ts: Date.now() });
    chatAppend('bot', welcome);
    document.getElementById('aiInput').focus();
  });
}

/* ---------------------------------- init ---------------------------------- */

(async function init() {
  await detectHost();
  await loadAll();                          // instant paint from cache
  liveRefresh({ full: true, quiet: true }); // LIVE refresh the moment popup opens
  await initChat();

  setInterval(() => {
    tick++;
    updateTicker();
    if (tick % AUTO_EVERY_SEC === 0) {
      liveRefresh({ full: false, quiet: true }); // cheap silent auto-refresh
    }
  }, 1000);
})();

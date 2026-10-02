'use strict';

/* DeKo – Toman Converter — options logic (Persian UI) */

const SETTINGS_KEY = 'deko2_settings';

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

const MANUAL_CURRENCIES = ['USD', 'EUR', 'GBP', 'AED', 'TRY', 'CNY', 'CAD', 'AUD', 'JPY'];

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const faToEn = (s) => String(s).replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)));

let settings = Object.assign({}, DEFAULT_SETTINGS);

function buildManualGrid() {
  const grid = document.getElementById('manualRates');
  grid.innerHTML = '';
  for (const cur of MANUAL_CURRENCIES) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const label = document.createElement('label');
    label.textContent = cur;
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.placeholder = 'مثلاً ۲۵۳۷۰۰';
    input.dataset.cur = cur;
    const v = settings.manualRates ? settings.manualRates[cur] : null;
    if (v != null) input.value = String(v);
    wrap.appendChild(label);
    wrap.appendChild(input);
    grid.appendChild(wrap);
  }
}

function render() {
  document.getElementById('optEnabled').checked = !!settings.enabled;
  document.getElementById('optCompact').checked = !!settings.compact;
  document.getElementById('optOverride').checked = !!settings.manualOverride;
  document.getElementById('optDollar').value = settings.dollarSymbol || 'USD';
  document.getElementById('optYen').value = settings.yenSymbol || 'JPY';
  const ai = settings.aiLLM || {};
  document.getElementById('optAiEnabled').checked = !!(ai && ai.enabled);
  document.getElementById('optAiEndpoint').value = (ai && ai.endpoint) || '';
  document.getElementById('optAiKey').value = (ai && ai.key) || '';
  document.getElementById('optAiModel').value = (ai && ai.model) || '';
  for (const radio of document.querySelectorAll('input[name="displayMode"]')) {
    radio.checked = radio.value === (settings.displayMode || 'append');
  }
  for (const radio of document.querySelectorAll('input[name="digits"]')) {
    radio.checked = radio.value === (settings.digits || 'fa');
  }
  document.getElementById('optSites').value = (settings.disabledSites || []).join('\n');
  buildManualGrid();
  refreshAiStatus();
}

/* ---------- DeKo AI: optional real-LLM connection (v2.4) ------------------- */

function aiOriginPattern(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin + '/*';
  } catch (e) { return null; }
}

async function refreshAiStatus() {
  const el = document.getElementById('optAiStatus');
  const url = document.getElementById('optAiEndpoint').value.trim();
  const pat = aiOriginPattern(url);
  if (!url) { el.textContent = 'برای استفادهٔ پیش‌فرض نیازی به این بخش نیست — دستیار همیشه با موتور داخلی کار می‌کند.'; return; }
  let granted = false;
  try { granted = await chrome.permissions.contains({ origins: [pat] }); } catch (e) { /* ignore */ }
  el.textContent = granted
    ? 'اجازهٔ دسترسی به ' + pat + ' داده شده ✓ (بعد از ذخیره، گفتگو با LLM فعال می‌شود)'
    : 'هنوز اجازهٔ دسترسی به ' + (pat || 'آدرس نامعتبر') + ' داده نشده — دکمهٔ «درخواست اجازه» را بزن.';
}

async function requestAiPermission() {
  const url = document.getElementById('optAiEndpoint').value.trim();
  const pat = aiOriginPattern(url);
  if (!pat) {
    document.getElementById('optAiStatus').textContent = 'آدرس Endpoint نامعتبر است؛ مثال: https://openrouter.ai/api/v1/chat/completions';
    return;
  }
  try {
    const ok = await chrome.permissions.request({ origins: [pat] });
    document.getElementById('optAiStatus').textContent = ok
      ? 'اجازه داده شد ✓ حالا «ذخیره» را بزن.'
      : 'اجازه داده نشد؛ بدون آن LLM کار نمی‌کند (موتور داخلی همچنان فعال است).';
  } catch (e) {
    document.getElementById('optAiStatus').textContent = 'درخواست اجازه ممکن نشد: ' + e.message;
  }
}

async function load() {
  const st = await chrome.storage.local.get(SETTINGS_KEY);
  settings = Object.assign({}, DEFAULT_SETTINGS, st[SETTINGS_KEY] || {});
  render();
}

async function save() {
  settings.enabled = document.getElementById('optEnabled').checked;
  settings.compact = document.getElementById('optCompact').checked;
  settings.manualOverride = document.getElementById('optOverride').checked;
  settings.dollarSymbol = document.getElementById('optDollar').value;
  settings.yenSymbol = document.getElementById('optYen').value;
  for (const radio of document.querySelectorAll('input[name="displayMode"]')) {
    if (radio.checked) settings.displayMode = radio.value;
  }
  for (const radio of document.querySelectorAll('input[name="digits"]')) {
    if (radio.checked) settings.digits = radio.value;
  }

  const manualRates = {};
  let first = true;
  for (const input of document.querySelectorAll('#manualRates input')) {
    const cur = input.dataset.cur;
    const raw = faToEn(input.value.trim()).replace(/[٬,]/g, '');
    const n = parseFloat(raw);
    if (input.value.trim() && Number.isFinite(n) && n > 0) manualRates[cur] = n;
    if (cur === 'USD' && n > 0) first = false;
  }
  settings.manualRates = manualRates;

  // Sanity: "manual only" mode needs a USD rate to be useful.
  if (settings.manualOverride && manualRates.USD == null) {
    settings.manualOverride = false;
    document.getElementById('optOverride').checked = false;
  }

  const sitesRaw = document.getElementById('optSites').value;
  settings.disabledSites = sitesRaw.split('\n')
    .map((s) => s.trim().toLowerCase().replace(/^www\./, ''))
    .filter((s) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s));

  settings.aiLLM = {
    enabled: document.getElementById('optAiEnabled').checked,
    endpoint: document.getElementById('optAiEndpoint').value.trim(),
    key: document.getElementById('optAiKey').value.trim(),
    model: document.getElementById('optAiModel').value.trim(),
  };

  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });

  const saved = document.getElementById('saved');
  saved.classList.remove('hidden');
  setTimeout(() => saved.classList.add('hidden'), 2000);
  refreshAiStatus();
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('optAiPermission').addEventListener('click', requestAiPermission);
document.getElementById('optAiEndpoint').addEventListener('change', refreshAiStatus);

load();

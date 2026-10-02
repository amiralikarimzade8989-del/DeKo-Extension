'use strict';

/* ============================================================================
 * DeKo – Toman Converter (v2.5.0) — background service worker
 * ----------------------------------------------------------------------------
 * Rate pipeline (auto-refresh every 5 MINUTES + LIVE BROADCAST to all tabs;
 * popup = instant LIVE refresh; page loads trigger a fresh pull when our last
 * attempt is older than 3 minutes => rates are live everywhere, instantly):
 *
 *   v2.5 ARZDIGITAL PRIMARY (user request: "اکسنشن رو arzdigital.com وصل کن"):
 *     - NEW Provider AR: https://arzdigital.com/currencies/ — the fiat index
 *       page is SERVER-RENDERED with a live Toman price for ~90 currencies
 *       (verified live 2026-10-01: one ~110KB-gzip fetch covers everything).
 *       Row shape: <a href=".../currencies/{slug}/"> + within ~900 bytes
 *       <span class="arz-irt-price" dir="rtl"><span>۲۹۲,۱۵۰</span>...
 *       Persian digits (U+06F0-06F9), Latin comma separators, '.' decimals
 *       (IQD ۱۹۷.۴۸) or '٫'. Unit is TOMAN already — NO /10.
 *     - ALL 16 DeKo currencies are native free-market quotes on arzdigital
 *       (tgju covers 12) — slug map below, cross-validated against er-api
 *       cross-rates: every implied FX rate within ~1.1% of the global mid
 *       (AED/SAR show the real free-market premium). JPY is PER 1 JPY
 *       (implied USD/JPY 158.2 vs er-api 157.3) — unlike tgju's per-100.
 *     - AR is the primary ANCHOR; T (tgju) still rides along in full mode to
 *       supply the daily change-chips + 7-day sparklines and becomes the
 *       fallback anchor if arzdigital fails. Cheap (non-full) passes fetch
 *       AR only (~110KB, no tgju) — previous chips/sparklines are carried
 *       forward so silent refreshes never wipe popup UI data.
 *     - Refresh-kick now looks at lastAttempt (not just updatedAt): the
 *       source page itself is cached server-side for a few minutes, so what
 *       matters is when WE last tried, not the source's own timestamp.
 *
 *   v2.3 ACCURACY + MARKET CONTEXT:
 *     - 12 NATIVE tgju slugs (USD EUR GBP AED TRY CNY CAD AUD JPY SAR INR CHF)
 *       -> almost every currency is a real Iranian free-market quote now,
 *       not a global-mid-market cross rate.
 *     - DataTables pagination verified live: ?draw=1&start=0&length=8 returns
 *       only the newest 8 rows (~1KB instead of ~600KB of full history).
 *     - Every tgju row carries the daily change -> cache now also stores
 *       changes {CUR: {pct, up}} and history {CUR: [8 closes]} for the
 *       popup change-chips and 7-day sparklines.
 *     - JPY on tgju is quoted per 100 JPY (cross-verified vs er-api:
 *       ratio 99.78 ~ 100) -> divisor 100 applied at the parse boundary.
 *
 *   v2.2 LIVE UPDATES:
 *     - alarm period 30 min -> 5 min (auto background refresh)
 *     - DEKO_GET_RATES {fresh:'auto'}: page open + cache older than 3 min
 *       fires a background refresh (page still answers instantly from cache,
 *       then receives the new rates via the broadcast/storage listener)
 *     - every successful refresh is BROADCAST to every tab
 *       (chrome.tabs.sendMessage DEKO_RATES_UPDATED {cache, changed}) so
 *       open pages re-render their badges the moment rates move
 *     - "changed" flag = rates JSON differs from previous cache -> content
 *       script only re-renders (and animates) when numbers really moved
 *
 *   AR) arzdigital.com/currencies/ -> free-market TOMAN, server-rendered
 *                                    index page (see v2.5 block above).
 *                                    PRIMARY anchor + native rates for all
 *                                    16 currencies. Verified live 2026-10-01:
 *                                    USD ۲۵۸,۷۰۰ EUR ۲۹۲,۱۵۰ GBP ۳۴۲,۰۹۰
 *                                    AED ۷۱,۱۱۰ TRY ۵,۲۸۰ CNY ۳۸,۵۸۰ ...
 *
 *   A) github rate-json/default   -> free-market TOMAN (USD EUR AED TRY CNY)
 *                                    Schema verified live 2026-09-30:
 *                                    {"generated_by_tomanify_at":"2026-09-30",
 *                                     "values":{"USD":253700,"EUR":287500,...}}
 *                                    Unit = TOMAN (cross-validated against T).
 *
 *   T) api.tgju.org               -> free-market RIAL — ALWAYS divide by 10.
 *                                    Schema verified live 2026-09-30 (+ again
 *                                    2026-10-01) with pagination:
 *                                    GET .../summary-table-data/{slug}
 *                                        ?draw=1&start=0&length=8
 *                                    {"data":[[open, low, high, close, chg,
 *                                              chg%, gdate, jdate], ...]}
 *                                    row 0 = newest day; close = col 3 (RIAL),
 *                                    chg = col 4, chg% = col 5 (HTML spans,
 *                                    class "high"=up / "low"=down), e.g.
 *                                    price_dollar_rl -> close "2,547,000"
 *                                    Rial = 254,700 Toman; chg% "0.39%".
 *                                    price_jpy is quoted per 100 JPY -> /100.
 *                                    Slugs (all live-tested): price_dollar_rl,
 *                                    price_eur, price_gbp, price_aed,
 *                                    price_try, price_cny, price_cad,
 *                                    price_aud, price_jpy, price_sar,
 *                                    price_inr, price_chf.
 *                                    Normal mode: USD only (1 request, used as
 *                                    cross-check). Full mode (popup/anchor): all.
 *
 *   B) open.er-api.com/v6/latest/USD -> global cross rates. Verified schema:
 *                                    {"result":"success","rates":{CUR: units
 *                                    per 1 USD}, "time_last_update_unix":...}
 *                                    1 CUR = usdToToman / rates[CUR] Toman.
 *
 *   C) manual rates from options  -> fill gaps (default) or full override.
 *
 * Sanity: finite/positive; USD inside plausible absolute bounds; move >30%
 * vs a recent (<48h) cache is rejected and the old value is kept.
 * Cache lives in chrome.storage.local under the "deko2_*" namespace.
 * NOTE: 1 Toman = 10 Rial. Everything this extension stores/displays is Toman.
 * ==========================================================================*/

const RATES_KEY = 'deko2_rates';
const SETTINGS_KEY = 'deko2_settings';
const ALARM_NAME = 'deko2-refresh';
const REFRESH_PERIOD_MIN = 5;       // v2.2: live feel (was 30)
const FRESH_TTL_MS = 3 * 60 * 1000; // page-load refresher threshold

const MAX_JUMP = 0.30;                            // reject >30% moves vs cache
const JUMP_GUARD_MAX_AGE_MS = 48 * 60 * 60 * 1000; // guard expires on old caches
const USD_ABS_MIN = 20000;                         // plausible Toman/USD floor
const USD_ABS_MAX = 5000000;                       // plausible Toman/USD ceiling
const TGJU_MISMATCH = 0.20;                        // A vs T divergence threshold

const PROVIDER_A_URLS = [
  'https://raw.githubusercontent.com/rate-json/default/main/data.json',
  'https://raw.githubusercontent.com/rate-json/default/master/data.json',
];
const PROVIDER_B_URL = 'https://open.er-api.com/v6/latest/USD';

/* ---- v2.5: arzdigital.com — PRIMARY live source (free-market TOMAN) ------
 * One server-rendered page carries ~90 currencies. These slugs cover every
 * currency DeKo tracks natively; all cross-validated live vs er-api.       */
const PROVIDER_AR_URL = 'https://arzdigital.com/currencies/';
const ARZ_SLUGS = {
  'united-states-dollar': 'USD',
  'euro': 'EUR',
  'pound-sterling': 'GBP',
  'united-arab-emirates-dirham': 'AED',
  'turkish-lira': 'TRY',
  'chinese-yuan': 'CNY',
  'canadian-dollar': 'CAD',
  'australian-dollar': 'AUD',
  'japanese-yen': 'JPY',
  'indian-rupee': 'INR',
  'swiss-franc': 'CHF',
  'russian-ruble': 'RUB',
  'saudi-riyal': 'SAR',
  'new-zealand-dollar': 'NZD',
  'south-korean-won': 'KRW',
  'swedish-krona': 'SEK',
};

const TGJU_SLUGS = {
  USD: 'price_dollar_rl',
  EUR: 'price_eur',
  GBP: 'price_gbp',
  AED: 'price_aed',
  TRY: 'price_try',
  CNY: 'price_cny',
  CAD: 'price_cad',
  AUD: 'price_aud',
  JPY: 'price_jpy',
  SAR: 'price_sar',
  INR: 'price_inr',
  CHF: 'price_chf',
};

/* tgju quotes some currencies per N units (verified live: price_jpy is per
 * 100 JPY — cross-checked against er-api cross rate, ratio 99.78 ~ 100).
 * Everything else is per 1 unit. Applied at the parse boundary only. */
const TGJU_DIVISOR = { JPY: 100 };

/* Rows pulled per slug: row 0 = today, rows 1..7 = the week before.
 * 8 rows ~ 1.2KB — enough for the popup 7-day sparkline. */
const TGJU_ROW_COUNT = 8;

/* Currencies the content script may ask for (chain fills these from B). */
const CURRENCIES = [
  'USD', 'EUR', 'GBP', 'AED', 'TRY', 'CNY', 'CAD', 'AUD', 'JPY',
  'INR', 'CHF', 'RUB', 'SAR', 'NZD', 'KRW', 'SEK',
];

const DEFAULT_SETTINGS = {
  enabled: true,
  disabledSites: [],        // ["amazon.de", ...]
  displayMode: 'append',    // 'append' | 'replace' | 'tooltip'
  digits: 'fa',             // 'fa' | 'en'
  compact: true,            // "۳۰٫۸ میلیون" instead of the full number
  dollarSymbol: 'USD',      // what a bare "$" means: USD | CAD | AUD
  yenSymbol: 'JPY',         // what a bare "¥" means: JPY | CNY
  manualRates: {},          // { USD: '253700', EUR: '287500', ... } in Toman
  manualOverride: false,    // true => use ONLY manual rates
};

/* -------------------------------- helpers --------------------------------- */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Order-independent JSON stringify (key-sorted) so rate comparisons don't
 *  false-positive just because object insertion order differs between a
 *  full pass and a cheap pass. */
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** "2,537,000" / "253700" / "۲٬۵۰۰" -> number | null (tolerant). */
function toNum(s) {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  const n = parseFloat(String(s).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function safe(promiseFactory) {
  try { return await promiseFactory(); } catch (e) { return null; }
}

async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getSettings() {
  const o = await chrome.storage.local.get(SETTINGS_KEY);
  return Object.assign({}, DEFAULT_SETTINGS, o[SETTINGS_KEY] || {});
}

async function loadCache() {
  const o = await chrome.storage.local.get(RATES_KEY);
  return o[RATES_KEY] || null;
}

/* ------------------------------- Provider A -------------------------------- */

function parseProviderA(json) {
  if (!json || typeof json !== 'object') return null;
  const values = json.values;
  if (!values || typeof values !== 'object') return null;

  const perCurrency = {};
  for (const [code, val] of Object.entries(values)) {
    const n = typeof val === 'number' ? val : toNum(val);
    if (n != null && n > 0) perCurrency[code.toUpperCase()] = n;
  }
  const usdToToman = perCurrency.USD || null;
  if (!usdToToman) return null;

  // "2026-09-30" -> epoch (+half day so same-day feeds never look stale).
  let updatedAt = Date.parse(json.generated_by_tomanify_at);
  updatedAt = Number.isFinite(updatedAt) ? updatedAt + 12 * 3600 * 1000 : Date.now();

  return { usdToToman, perCurrency, updatedAt, source: 'rate-json/default' };
}

async function providerA() {
  for (const url of PROVIDER_A_URLS) {
    try {
      const parsed = parseProviderA(await fetchJson(url));
      if (parsed) return parsed;
    } catch (e) { /* try the next branch */ }
  }
  return null;
}

/* ------------------------------ Provider AR --------------------------------
 * arzdigital.com/currencies/ — server-rendered fiat index (v2.5 PRIMARY).
 * Prices are ALREADY Toman; digits are Persian (۰-۹ / ٠-٩), thousands may be
 * Latin ',' or Persian '٬', decimals '.' or '٫'. The page's JSON-LD carries
 * "dateModified" — the source's own data timestamp, used as updatedAt.      */

const FA_MAP = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '٫': '.', '٬': '',       // Persian decimal point / thousands separator
};

function faDigitsToEn(s) {
  return String(s).replace(/[۰-۹٠-٩٫٬]/g, (c) => FA_MAP[c] || c);
}

function parseArzdigital(html) {
  if (typeof html !== 'string' || html.length < 10000) return null;

  const per = {};
  const seenSlugs = new Set();
  /* href to a currency page, then the price span within ~900 bytes.
   * Proven against the live page (90 rows, incl. decimal IQD ۱۹۷.۴۸). */
  const rowRe = /href=["']https:\/\/arzdigital\.com\/currencies\/([a-z-]+)\/?["'][\s\S]{0,900}?arz-irt-price[^>]*>\s*<span>([^<]+)<\/span>/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const slug = m[1];
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    const cur = ARZ_SLUGS[slug];
    if (!cur || per[cur] != null) continue;
    const n = toNum(faDigitsToEn(m[2]));
    if (n != null && n > 0) per[cur] = n;
  }
  if (per.USD == null) return null;    // anchor missing -> source unusable

  let updatedAt = Date.now();
  const dm = html.match(/"dateModified":"([^"]+)"/);
  if (dm) {
    const t = Date.parse(dm[1]);
    if (Number.isFinite(t)) updatedAt = t;
  }
  return { per, updatedAt, source: 'arzdigital.com' };
}

async function providerAR() {
  return parseArzdigital(await fetchText(PROVIDER_AR_URL, 12000));
}

/* ------------------------------- Provider T --------------------------------
 * tgju.org free market — quotes RIAL. Everything here is converted to Toman
 * (divide by 10, plus per-N divisors like JPY/100) at the parse boundary;
 * nothing Rial ever leaves this file. Each response also yields the daily
 * change (col 4/5, class high/low) and the week of closes for sparklines. */

function stripTags(s) {
  return String(s == null ? '' : s).replace(/<[^>]*>/g, '').trim();
}

function parseTgjuSummary(json, cur) {
  if (!json || !Array.isArray(json.data) || !json.data.length) return null;
  if (!Array.isArray(json.data[0])) return null;

  const div = (TGJU_DIVISOR[cur] || 1);
  const toToman = (rial) => {
    const n = toNum(rial);
    return (n == null || n <= 0) ? null : n / 10 / div;   // RIAL -> TOMAN
  };

  const row0 = json.data[0];
  const toman = toToman(row0[3]);        // col 3 = closing price (RIAL)
  if (toman == null) return null;

  /* col 5 like `<span class="high" dir="ltr">0.39%</span>` */
  let pct = null;
  let up = null;
  const chgHtml = String(row0[5] == null ? '' : row0[5]);
  const pctN = parseFloat(stripTags(chgHtml).replace('%', ''));
  if (Number.isFinite(pctN)) {
    pct = pctN;
    up = /class="high"/i.test(chgHtml) ? true
       : /class="low"/i.test(chgHtml) ? false : null;
  }

  /* closes of the newest rows, oldest -> newest (sparkline input) */
  const history = [];
  for (const row of json.data) {
    if (!Array.isArray(row)) continue;
    const c = toToman(row[3]);
    if (c != null) history.push(c);
  }
  history.reverse();

  return { toman, pct, up, history };
}

async function tgjuRate(cur) {
  const slug = TGJU_SLUGS[cur];
  const url = 'https://api.tgju.org/v1/market/indicator/summary-table-data/' + slug +
              '?draw=1&start=0&length=' + TGJU_ROW_COUNT;   // ~1KB, not 600KB
  return parseTgjuSummary(await fetchJson(url), cur);
}

/** full=false -> USD only; full=true -> every known slug, fetched in PARALLEL
 *  (one round-trip => popup "live refresh" stays fast). Also returns the
 *  daily change chips + 7-day history for the popup UI. */
async function providerT(full) {
  const curs = full ? Object.keys(TGJU_SLUGS) : ['USD'];
  const vals = await Promise.all(curs.map((c) => safe(() => tgjuRate(c))));

  const per = {};
  const changes = {};
  const history = {};
  curs.forEach((c, i) => {
    const v = vals[i];
    if (!v) return;
    per[c] = v.toman;
    if (v.pct != null) changes[c] = { pct: v.pct, up: v.up };
    if (v.history && v.history.length > 1) history[c] = v.history;
  });
  if (per.USD == null) return null;
  return { per, changes, history, updatedAt: Date.now(), source: 'tgju.org (Rial/10)' };
}

/* ------------------------------- Provider B -------------------------------- */

function parseProviderB(json) {
  if (!json || json.result !== 'success' || !json.rates) return null;
  const perUsd = {};
  for (const [cur, val] of Object.entries(json.rates)) {
    const n = typeof val === 'number' ? val : toNum(val);
    if (n != null && n > 0) perUsd[cur.toUpperCase()] = n;
  }
  if (!perUsd.EUR) return null;
  return {
    perUsd,
    updatedAt: (json.time_last_update_unix || Math.floor(Date.now() / 1000)) * 1000,
    source: 'open.er-api.com',
  };
}

async function providerB() {
  return parseProviderB(await fetchJson(PROVIDER_B_URL));
}

/* ---------------------------- refresh pipeline ----------------------------- */

async function refreshRates(opts) {
  /* opts.full = true -> also pull every tgju slug in PARALLEL (popup live mode) */
  const full = !!(opts && opts.full);
  const settings = await getSettings();
  const prev = await loadCache();
  const prevRates = prev && prev.rates ? prev.rates : null;
  const jumpOn = !!(prev && (Date.now() - prev.updatedAt) < JUMP_GUARD_MAX_AGE_MS);
  const notes = [];

  const acceptUsd = (v) => {
    if (!isNum(v) || v < USD_ABS_MIN || v > USD_ABS_MAX) return false;
    const old = prevRates ? prevRates.usdToToman : null;
    if (jumpOn && isNum(old) && Math.abs(v - old) / old > MAX_JUMP) return false;
    return true;
  };
  const acceptCur = (cur, v) => {
    if (!isNum(v) || v <= 0) return false;
    const old = prevRates && prevRates.perCurrency ? prevRates.perCurrency[cur] : null;
    if (jumpOn && isNum(old) && Math.abs(v - old) / old > MAX_JUMP) return false;
    return true;
  };

  const sources = [];
  let updatedAt = 0;
  let anyLive = false;
  let usdToToman = null;
  const perCurrency = {};
  const changes = {};      // v2.3: {CUR: {pct, up}} daily market moves
  const history = {};      // v2.3: {CUR: [closes oldest->newest]} sparklines

  /* v2.2 anti-churn: a cheap (non-full) pass only re-fetches the USD anchor.
   * For every other currency, restore the value from a recent (< 10 min)
   * cache BEFORE the daily snapshot (A) can overwrite live values, so silent
   * refreshes don't wiggle numbers that are already fresh. The matching
   * change-chip + sparkline data is restored along with the rate. Restored
   * values still pass the same sanity checks. */
  const PREV_KEEP_MS = 10 * 60 * 1000;
  const prevFresh = !!(prev && prev.rates && prev.rates.perCurrency &&
    (Date.now() - (prev.lastAttempt || prev.updatedAt || 0)) < PREV_KEEP_MS);
  const restorePrev = (cur) => {
    const old = prev.rates.perCurrency[cur];
    if (!isNum(old) || old <= 0 || !acceptCur(cur, old)) return false;
    perCurrency[cur] = old;
    if (prev.changes && prev.changes[cur]) changes[cur] = prev.changes[cur];
    if (prev.history && prev.history[cur]) history[cur] = prev.history[cur];
    return true;
  };

  if (settings.manualOverride) {
    /* ---- Provider C full override: manual rates only ---- */
    const m = settings.manualRates || {};
    const mu = m.USD != null ? toNum(m.USD) : null;
    if (mu != null && mu > 0) usdToToman = Math.round(mu);
    for (const [cur, val] of Object.entries(m)) {
      const n = toNum(val);
      if (n == null || n <= 0) continue;
      const code = cur.toUpperCase();
      if (code === 'USD') continue;
      perCurrency[code] = Math.round(n);
    }
    if (usdToToman != null) {
      perCurrency.USD = usdToToman;
      sources.push('manual');
      anyLive = true;
      updatedAt = Date.now();
    }
  } else {
    /* ---- v2.5: AR (arzdigital) + T (tgju full) + A fetched in PARALLEL.
     *      AR is the PRIMARY live anchor (user request) and the native-Toman
     *      source for ALL 16 currencies. T supplies the daily change-chips +
     *      7-day sparklines and is the fallback anchor when AR is down.
     *      A (daily snapshot) stays as the last automatic fallback. ---- */
    let AR = null;
    let T = null;
    let A = null;
    if (full) {
      [AR, T, A] = await Promise.all([
        safe(providerAR),
        safe(() => providerT(true)),
        safe(providerA),
      ]);
      /* tgju full failed -> degrade to USD-only so chips still refresh */
      if (!T) T = await safe(() => providerT(false));
    } else {
      /* cheap pass: AR only (one fetch). tgju USD-only runs only if AR died. */
      [AR, A] = await Promise.all([safe(providerAR), safe(providerA)]);
      if (!AR) T = await safe(() => providerT(false));
    }

    /* ---- 1) AR anchor + 16 native free-market rates ---- */
    if (AR && isNum(AR.per.USD)) {
      if (acceptUsd(AR.per.USD)) {
        usdToToman = Math.round(AR.per.USD);
        anyLive = true;
        sources.push(AR.source);
        updatedAt = Math.max(updatedAt, AR.updatedAt || 0);
        for (const [cur, v] of Object.entries(AR.per)) {
          if (cur === 'USD') continue;
          if (perCurrency[cur] == null && acceptCur(cur, v)) perCurrency[cur] = Math.round(v);
        }
      } else {
        notes.push('arzdigital USD rejected by sanity check');
      }
    }

    /* ---- 2) T: fallback anchor + change-chips + sparklines ---- */
    if (T && isNum(T.per.USD)) {
      if (usdToToman == null && acceptUsd(T.per.USD)) {
        usdToToman = Math.round(T.per.USD);
        anyLive = true;
        sources.push(T.source);
        updatedAt = Math.max(updatedAt, T.updatedAt || 0);
        notes.push('tgju anchor (arzdigital unavailable)');
      } else if (usdToToman != null) {
        /* divergence note only — live arzdigital wins */
        const dev = Math.abs(usdToToman - T.per.USD) / T.per.USD;
        if (dev > TGJU_MISMATCH) {
          notes.push('arzdigital vs tgju USD diverged ' + Math.round(dev * 100) + '%');
        }
      }
      /* full mode: T delivers 12 live native-Toman currencies + changes */
      for (const [cur, v] of Object.entries(T.per)) {
        if (cur === 'USD') continue;
        if (perCurrency[cur] == null && acceptCur(cur, v)) perCurrency[cur] = Math.round(v);
      }
      for (const [cur, ch] of Object.entries(T.changes || {})) {
        /* USD is kept unconditionally: acceptUsd already passed above and
         * perCurrency.USD is only assigned after this loop */
        if (perCurrency[cur] != null || cur === 'USD') changes[cur] = ch;
      }
      for (const [cur, h] of Object.entries(T.history || {})) {
        if (perCurrency[cur] != null || cur === 'USD') history[cur] = h;
      }
    }

    /* v2.5: cheap passes skip tgju (arzdigital is the live source now), so
     * carry the last known change-chips/sparklines forward for currencies
     * that are still on display — silent refreshes must never wipe popup UI
     * data. Values themselves always come from the fresh pass. */
    if (prev) {
      for (const [cur, ch] of Object.entries(prev.changes || {})) {
        /* cur === 'USD': perCurrency.USD is assigned only after this block */
        if ((perCurrency[cur] != null || cur === 'USD') && changes[cur] == null) changes[cur] = ch;
      }
      for (const [cur, h] of Object.entries(prev.history || {})) {
        if ((perCurrency[cur] != null || cur === 'USD') && history[cur] == null) history[cur] = h;
      }
    }

    if (prevFresh) {
      for (const cur of CURRENCIES) {
        if (cur === 'USD' || perCurrency[cur] != null) continue;
        restorePrev(cur);
      }
    }

    if (A && isNum(A.usdToToman)) {
      if (usdToToman == null) {
        /* arzdigital AND tgju unavailable -> daily snapshot anchors */
        if (acceptUsd(A.usdToToman)) {
          usdToToman = Math.round(A.usdToToman);
          anyLive = true;
          sources.push(A.source);
          updatedAt = Math.max(updatedAt, A.updatedAt || 0);
          notes.push('arzdigital+tgju unavailable -> provider A anchor');
        } else {
          notes.push('USD anchor rejected by sanity check');
        }
      } else {
        /* divergence note only — live arzdigital wins */
        const dev = Math.abs(usdToToman - A.usdToToman) / A.usdToToman;
        if (dev > TGJU_MISMATCH) {
          notes.push('A vs live USD diverged ' + Math.round(dev * 100) + '% (live wins)');
        }
      }
      let aAdded = false;
      for (const [cur, val] of Object.entries(A.perCurrency || {})) {
        if (cur === 'USD') continue;
        if (perCurrency[cur] == null && acceptCur(cur, val)) {
          perCurrency[cur] = Math.round(val);
          aAdded = true;
        }
      }
      if (aAdded && !sources.includes(A.source)) sources.push(A.source);
    }

    /* ---- B: cross-rate chain for everything still missing ---- */
    if (usdToToman != null) {
      const missing = CURRENCIES.filter((c) => c !== 'USD' && perCurrency[c] == null);
      if (missing.length) {
        const B = await safe(providerB);
        if (B && B.perUsd) {
          let added = 0;
          for (const cur of missing) {
            const unitsPerUsd = B.perUsd[cur];
            if (!isNum(unitsPerUsd) || unitsPerUsd <= 0) continue;
            const t = usdToToman / unitsPerUsd;   // 1 CUR = (1/unitsPerUsd) USD
            if (acceptCur(cur, t)) { perCurrency[cur] = Math.round(t); added++; }
          }
          if (added) {
            anyLive = true;
            sources.push(B.source);
            updatedAt = Math.max(updatedAt, B.updatedAt || 0);
          }
        }
      }
    }

    /* ---- C: manual rates fill remaining gaps ---- */
    for (const [cur, val] of Object.entries(settings.manualRates || {})) {
      const n = toNum(val);
      const code = String(cur).toUpperCase();
      if (n == null || n <= 0 || code === 'USD') continue;
      if (perCurrency[code] == null && n < USD_ABS_MAX) perCurrency[code] = Math.round(n);
    }
  }

  if (usdToToman != null) perCurrency.USD = usdToToman;

  /* ---- nothing usable? keep serving the old cache, flagged stale ---- */
  if (usdToToman == null) {
    if (prev) {
      const staleCache = Object.assign({}, prev, {
        stale: true, lastAttempt: Date.now(), notes,
      });
      await chrome.storage.local.set({ [RATES_KEY]: staleCache });
      return staleCache;
    }
    return null;
  }

  const newRatesJson = stableStringify({ usdToToman, perCurrency });
  const changed = !prevRates || newRatesJson !== stableStringify(prevRates);
  const cache = {
    rates: { usdToToman, perCurrency },
    changes,            // v2.3: daily % moves for the popup chips
    history,            // v2.3: 7-day closes for the popup sparklines
    updatedAt: updatedAt || Date.now(),
    source: [...new Set(sources)].join(' + ') || 'cache',
    stale: !anyLive,
    lastAttempt: Date.now(),
    notes,
  };
  await chrome.storage.local.set({ [RATES_KEY]: cache });
  broadcastRates(cache, changed);   // v2.2: push to every open tab, live
  return cache;
}

/* ------------------------------ live broadcast -----------------------------
 * Push the fresh cache to every tab that has the content script. Tabs
 * without a receiver (chrome://, the popup itself, discarded tabs) simply
 * reject the message — the rejection is swallowed. Also mirrors into the
 * popup via chrome.runtime.sendMessage so it can re-render instantly.      */

function broadcastRates(cache, changed) {
  if (!cache || !cache.rates) return;
  const msg = { type: 'DEKO_RATES_UPDATED', cache, changed: !!changed };
  try {
    chrome.tabs.query({}, (tabs) => {
      const err = chrome.runtime.lastError; /* legacy guard */
      for (const t of tabs || []) {
        if (!t || t.id == null) continue;
        try { chrome.tabs.sendMessage(t.id, msg, () => void chrome.runtime.lastError); }
        catch (e) { /* tab gone / no receiver */ }
      }
    });
  } catch (e) { /* tabs API unavailable */ }
  try {
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  } catch (e) { /* no other listener (e.g. popup closed) */ }
}

/* ------------------------------ messaging etc ------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'DEKO_GET_RATES') {
    (async () => {
      const cache = await loadCache();
      /* v2.2 live (v2.5 tune): page just opened and our last ATTEMPT is older
       * than 3 minutes (or missing) -> kick off a live refresh in the
       * background. lastAttempt is used (not the source's updatedAt) because
       * arzdigital's own page is cached server-side for a few minutes — what
       * matters is when we last tried, not the timestamp the source stamped.
       * The page still gets the cached answer instantly so badges render
       * without delay, and the broadcast / storage listener re-renders them
       * the moment the fresh rates land. */
      const age = cache ? Date.now() - Math.max(cache.lastAttempt || 0, cache.updatedAt || 0) : Infinity;
      if (msg.fresh === 'auto' && (!cache || age > FRESH_TTL_MS)) {
        refreshRates({ full: false }).catch(() => {});
      }
      sendResponse(cache || null);
    })();
    return true; // async response
  }
  if (msg.type === 'DEKO_REFRESH') {
    refreshRates({ full: !!(msg && msg.full) })
      .then((cache) => sendResponse({ ok: true, cache }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response
  }
  return false;
});

function scheduleAlarm() {
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: REFRESH_PERIOD_MIN,
  });
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleAlarm();
  refreshRates();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleAlarm();
  refreshRates();
});

// Defensive: create the alarm on every service-worker wake as well.
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM_NAME) refreshRates();
});
scheduleAlarm();

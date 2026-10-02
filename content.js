'use strict';

/* ============================================================================
 * DeKo – Toman Converter (v2.0.0) — content script
 * ----------------------------------------------------------------------------
 * Detects foreign-currency prices in text nodes and appends an inline badge
 * with the free-market Toman equivalent:  $100 -> $100 (≈ ۲۵٫۴ میلیون تومان)
 *
 * v2 fix (the 1000x bug): on Amazon the price is split across sibling spans —
 *   <span class="a-price-whole">106<span class="a-price-decimal">.</span></span>
 *   <span class="a-price-fraction">99</span>
 * The hidden decimal inside "whole" made the old combiner produce "106..99",
 * which parseNumber() treated as thousands grouping -> 10699 -> a 1000x error.
 * Now: the accessible .a-offscreen text ("€106.99") is preferred, and the
 * trailing decimal of "whole" is stripped before joining the fraction.
 *
 * No network access here: rates come from the background service worker via
 * chrome.runtime messaging, with a chrome.storage fallback.
 * All generated DOM is prefixed "deko-" to avoid clashing with host pages.
 * ========================================================================== */

(() => {
  if (window.__deko2Injected) return;
  window.__deko2Injected = true;

  /* =============================== constants ============================== */

  const RATES_CACHE_KEY = 'deko2_rates';
  const SETTINGS_KEY = 'deko2_settings';
  const STALE_AFTER_MS = 3 * 60 * 60 * 1000; // popup-style "stale" hint in tooltip

  const STR = {
    toman: 'تومان',
    approx: '≈',
    rangeTo: 'تا',
    tooltipRate: 'نرخ',
    tooltipSource: 'منبع',
    tooltipUpdated: 'به‌روزرسانی',
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    disabledSites: [],
    displayMode: 'append',   // 'append' | 'replace' | 'tooltip'
    digits: 'fa',            // 'fa' | 'en'
    compact: true,
    dollarSymbol: 'USD',     // bare "$" means: USD | CAD | AUD
    yenSymbol: 'JPY',        // bare "¥" means: JPY | CNY
    manualRates: {},
    manualOverride: false,
  };

  /* =========================== state & settings =========================== */

  let settings = null;
  let rates = null;       // { usdToToman, perCurrency: {CUR: toman} }
  let ratesMeta = null;   // { updatedAt, source, stale, ... }

  let scanPaused = false;

  function effectiveEnabled() {
    return !!(settings && settings.enabled && rates && rates.usdToToman);
  }

  function isSiteDisabled() {
    if (!settings) return false;
    const host = location.hostname.replace(/^www\./, '');
    return (settings.disabledSites || []).some((d) => host === d || host.endsWith('.' + d));
  }

  /* ============================== numbers ================================= */

  const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

  function toFaDigits(s) {
    let out = '';
    for (const ch of String(s)) {
      out += (ch >= '0' && ch <= '9') ? FA_DIGITS[+ch] : ch;
    }
    return out;
  }

  /** Persian/Arabic digits + separators -> ASCII so parseNumber() is uniform. */
  function normalizeNum(s) {
    let out = '';
    for (const ch of s) {
      const fi = FA_DIGITS.indexOf(ch);
      const ai = AR_DIGITS.indexOf(ch);
      if (fi >= 0) out += fi;
      else if (ai >= 0) out += ai;
      else if (ch === '\u066B') out += '.';                    // Persian decimal
      else if (ch === '\u066C' || ch === '\u060C') out += ','; // Persian thousands
      else if (ch === '\u00A0') out += ' ';
      else out += ch;
    }
    return out;
  }

  /**
   * Parse "1,299.99" | "1.299,99" | "1 299,99" | "1299" | "۱٬۲۰۰" | "۳۵۰٫۵" ...
   * Rules:
   *  - both "." and "," present  -> the LAST one is the decimal separator
   *  - only "," present          -> groups of exactly 3 = thousands, else decimal
   *  - only "." present          -> groups of 3 = thousands ("1.299.999", "1.299"),
   *                                 else decimal ("1.99")
   *  - spaces / NBSP             -> thousands separators
   *  - an EMPTY group ("11..13") -> malformed -> null   [v2 hardening]
   */
  function parseNumber(raw) {
    if (!raw) return null;
    let s = normalizeNum(String(raw)).trim();
    if (!s) return null;
    if (/\d \d{3}(\D|$)/.test(s)) s = s.replace(/ (?=\d{3}(\D|$))/g, ''); // "1 299"

    const hasDot = s.indexOf('.') >= 0;
    const hasComma = s.indexOf(',') >= 0;
    let dec = null, thou = null;

    if (hasDot && hasComma) {
      if (s.lastIndexOf('.') > s.lastIndexOf(',')) { dec = '.'; thou = ','; }
      else { dec = ','; thou = '.'; }
      // a malformed mix like "1,2..3" has empty groups once split
      const groups = s.split(/[.,]/);
      if (groups.some((g) => g === '')) return null;
    } else if (hasDot) {
      const parts = s.split('.');
      if (parts.length > 2) {
        if (parts.some((g) => g === '')) return null;   // "11..13" -> null (v2 fix)
        thou = '.';
      } else if (parts[1] && parts[1].length === 3 && parts[0].length <= 3 && /^\d+$/.test(parts[0])) {
        thou = '.';                                     // European "1.299"
      } else {
        dec = '.';                                      // "1.99", "25.3"
      }
    } else if (hasComma) {
      const parts = s.split(',');
      if (parts.length === 2 && parts[1].length !== 3) dec = ',';
      else if (parts.some((g) => g === '')) return null;
      else thou = ',';
    }

    let numStr = s;
    if (thou) numStr = numStr.split(thou).join('');
    if (dec) numStr = numStr.split(dec).join('.');
    const v = parseFloat(numStr);
    return Number.isFinite(v) ? v : null;
  }

  /** k / m / thousand / million / billion / هزار / میلیون / میلیارد */
  function multValue(m) {
    if (!m) return 1;
    const t = m.toLowerCase();
    if (t === 'k' || t === 'thousand' || m === 'هزار') return 1e3;
    if (t === 'm' || t === 'million' || m === 'میلیون') return 1e6;
    if (t === 'billion' || m === 'میلیارد') return 1e9;
    return 1;
  }

  /* ============================ currency tokens =========================== */

  const CURRENCY_NAMES = {
    USD: 'دلار آمریکا', EUR: 'یورو', GBP: 'پوند انگلیس', AED: 'درهم امارات',
    TRY: 'لیر ترکیه', CNY: 'یوان چین', CAD: 'دلار کانادا', AUD: 'دلار استرالیا',
    JPY: 'ین ژاپن', INR: 'روپیه هند', CHF: 'فرانک سوئیس', RUB: 'روبل روسیه',
    SAR: 'ریال عربستان', NZD: 'دلار نیوزیلند', KRW: 'وون کره', SEK: 'کرون سوئد',
  };

  function tokenToCurrency(token) {
    if (!token) return null;
    let t = normalizeNum(token).trim();
    if (!t) return null;
    t = t.replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/\s+/g, ' ');

    // Persian words (suffix/prefix)
    const faMap = {
      'دلار': 'USD', 'دلار امریکا': 'USD', 'دلار آمریکا': 'USD',
      'یورو': 'EUR', 'اورو': 'EUR', 'پوند': 'GBP', 'استرلینگ': 'GBP',
      'درهم': 'AED', 'لیر': 'TRY', 'یوان': 'CNY', 'روپیه': 'INR',
      'روبل': 'RUB', 'فرانک': 'CHF', 'وون': 'KRW', 'ین': 'JPY',
    };
    if (faMap[t]) return faMap[t];
    // already-Toman currencies must never be converted
    if (t === 'تومان' || t === 'تومن' || t === 'ریال' || t === 'ريال') return null;

    const up = t.toUpperCase().replace(/\s/g, '');
    // bare symbols whose meaning the user can remap in options
    if (t === '$') return settings && settings.dollarSymbol ? settings.dollarSymbol : 'USD';
    if (t === '¥') return settings && settings.yenSymbol ? settings.yenSymbol : 'JPY';
    const symMap = {
      'US$': 'USD', 'USD$': 'USD', 'C$': 'CAD', 'CA$': 'CAD', 'CAD$': 'CAD',
      'A$': 'AUD', 'AU$': 'AUD', 'AUD$': 'AUD', 'NZ$': 'NZD',
      '€': 'EUR', '£': 'GBP', '₺': 'TRY', '₹': 'INR', '₽': 'RUB',
      '₩': 'KRW', 'د.إ': 'AED', 'د. إ': 'AED', 'دإ': 'AED',
    };
    if (symMap[up]) return symMap[up];
    if (symMap[t]) return symMap[t];
    const codeMap = {
      USD: 'USD', EUR: 'EUR', GBP: 'GBP', AED: 'AED', TRY: 'TRY', CNY: 'CNY',
      CAD: 'CAD', AUD: 'AUD', JPY: 'JPY', INR: 'INR', CHF: 'CHF', RUB: 'RUB',
      SAR: 'SAR', NZD: 'NZD', KRW: 'KRW', SEK: 'SEK',
    };
    if (codeMap[up]) return codeMap[up];
    const wordMap = {
      'DOLLAR': 'USD', 'DOLLARS': 'USD', 'EURO': 'EUR', 'EUROS': 'EUR',
      'POUND': 'GBP', 'POUNDS': 'GBP', 'DIRHAM': 'AED', 'DIRHAMS': 'AED',
      'LIRA': 'TRY', 'LIRAS': 'TRY', 'YEN': 'JPY', 'YUAN': 'CNY',
      'RUPEE': 'INR', 'RUPEES': 'INR', 'FRANC': 'CHF', 'FRANCS': 'CHF',
      'RUBLE': 'RUB', 'RUBLES': 'RUB',
    };
    if (wordMap[up]) return wordMap[up];
    return null;
  }

  /* ========================= regex construction ===========================
   * Persian digits: \u06F0-\u06F9   Arabic-Indic: \u0660-\u0669
   * Decimal sep: . \u066B          Thousands: , space \u060C \u066C
   * ========================================================================= */

  const D = '0-9\\u06F0-\\u06F9\\u0660-\\u0669';
  const NUM_CLS = '[' + D + ']';
  const TSEP = ',\\u060C\\u066C ';
  const DSEP = '\\u066B';

  const CUR_TOKENS = [
    'US\\$', 'C\\$', 'A\\$',
    '[\\$\u20AC\u00A3\u00A5\u20BA\u20B9\u20BD\u20A9]',
    'د\\.?\\s?إ',
    '(?<![A-Za-z])(?:USD|EUR|GBP|AED|TRY|CNY|CAD|AUD|JPY|INR|CHF|RUB|SAR|KRW|SEK|NZD)(?![A-Za-z])',
    '(?<![A-Za-z])(?:dollars?|euros?|pounds?|dirhams?|liras?|yen|yuan|rupees?|francs?|rubles?)(?![A-Za-z])',
    'دلار|یورو|پوند|درهم|لیر|یوان|روپیه|روبل|فرانک|وون|استرلینگ',
  ].join('|');

  const CUR_GROUP = '(' + CUR_TOKENS + ')';

  // "1,299.99" | "1 299" | "1.299,99" | "1.299.500" | "1299" | "۱٬۲۰۰٫۵" ...
  const NUM_SRC =
    NUM_CLS + '{1,3}(?:[' + TSEP + ']' + NUM_CLS + '{3})+' +
    '(?:[.' + DSEP + ']' + NUM_CLS + '{1,2}|,' + NUM_CLS + '{1,2}(?!' + NUM_CLS + '))?' +
    '|' + NUM_CLS + '{1,3}(?:[.' + DSEP + ']' + NUM_CLS + '{3})+' +
    '(?:,' + NUM_CLS + '{1,2}(?!' + NUM_CLS + '))?' +
    '|' + NUM_CLS + '+(?:[.' + DSEP + ']' + NUM_CLS + '{1,2}|,' + NUM_CLS + '{1,2}(?!' + NUM_CLS + '))?';

  // NOTE: no internal "?"; the surrounding optional wrapper owns the space.
  const MULT_SRC = '(k\\b|m\\b|thousand\\b|million\\b|billion\\b|هزار|میلیون|میلیارد)';

  const LOOKBEHIND = '(?<![\\d.\\u060C\\u066C\\u066B,])';
  const GUARD_AFTER_RE = /^(?:\d|[.,\u060C\u066C\u066B]\d)/;

  // The space before an optional group lives INSIDE the group, otherwise the
  // trailing \s* would eat the space after the price ("$75 only!").
  const PRICE_RE = new RegExp(
    LOOKBEHIND + CUR_GROUP + '?[\\s\u00A0]*(' + NUM_SRC + ')' +
    '(?:\\s*' + MULT_SRC + ')?' +
    '(?:\\s*' + CUR_GROUP + ')?',
    'gi'
  );

  // "$10 - $20" | "$10 to $20" | "از ۱۰ تا ۲۰ دلار" | "$10–$20"
  const RANGE_RE = new RegExp(
    LOOKBEHIND + CUR_GROUP + '?[\\s\u00A0]*(' + NUM_SRC + ')' +
    '(?:\\s*' + MULT_SRC + ')?' +
    '(?:\\s*' + CUR_GROUP + ')?' +
    '\\s*(?:-|\u2013|\u2014|to\\b|until\\b|تا)\\s*' +
    CUR_GROUP + '?[\\s\u00A0]*(' + NUM_SRC + ')' +
    '(?:\\s*' + MULT_SRC + ')?' +
    '(?:\\s*' + CUR_GROUP + ')?',
    'gi'
  );

  // Cheap pre-filter: only run the expensive regexes on promising nodes.
  const HINT_RE = /[\$\u20AC\u00A3\u00A5\u20BA\u20B9\u20BD\u20A9]|د\.?إ|درهم|دلار|یورو|پوند|لیر|یوان|روپیه|روبل|فرانک|وون|استرلینگ|USD|EUR|GBP|AED|TRY|CNY|CAD|AUD|JPY|INR|CHF|RUB|SAR|KRW|SEK|NZD|dollar|euro|pound|dirham|lira|yen|yuan|rupee|franc|ruble/i;
  const HAS_DIGIT_RE = new RegExp('[' + D + ']');

  const SYMBOL_ONLY_RE = /^\s*(?:US\$|C\$|A\$|[\$\u20AC\u00A3\u00A5\u20BA\u20B9\u20BD\u20A9]|د\.?\s?إ)\s*$/;

  /* ============================ match collection ========================== */

  const YEAR_LIKE_RE = /^\s*(?:19|20)\d{2}\s*$/;
  // "$100Total" -> a bare number glued to letters is not a price
  const GLUED_LETTER_RE = /[A-Za-z\u0600-\u06FF\uFB50-\uFEFF]/;

  function collectMatches(text) {
    const out = [];
    const consumed = [];

    for (const m of text.matchAll(RANGE_RE)) {
      const n1 = parseNumber(m[2]);
      const n2 = parseNumber(m[6]);
      if (n1 == null || n2 == null) continue;
      const curs = [m[1], m[4], m[5], m[8]].map(tokenToCurrency).filter(Boolean);
      if (!curs.length || new Set(curs).size > 1) continue; // one currency, one kind
      if (!m[1] && !m[4] && YEAR_LIKE_RE.test(m[2])) continue; // "1990 to 2000 dollars"
      const end = m.index + m[0].length;
      if (GUARD_AFTER_RE.test(text.slice(end, end + 2))) continue;
      if (!m[8] && !m[7] && GLUED_LETTER_RE.test(text.charAt(end) || '')) continue;
      out.push({
        type: 'range', start: m.index, end, cur: curs[0],
        v1: n1 * multValue(m[3]), v2: n2 * multValue(m[7]),
      });
      consumed.push([m.index, end]);
    }

    for (const m of text.matchAll(PRICE_RE)) {
      const start = m.index;
      const end = start + m[0].length;
      if (consumed.some(([a, b]) => start < b && end > a)) continue;
      const cur = tokenToCurrency(m[1] || m[4]);
      if (!cur) continue;
      const n = parseNumber(m[2]);
      if (n == null) continue;
      if (!m[1] && YEAR_LIKE_RE.test(m[2])) continue;   // bare "2020 dollars"
      if (GUARD_AFTER_RE.test(text.slice(end, end + 2))) continue;
      if (!m[4] && !m[3] && GLUED_LETTER_RE.test(text.charAt(end) || '')) continue;
      out.push({ type: 'single', start, end, cur, v: n * multValue(m[3]) });
    }

    out.sort((a, b) => a.start - b.start);
    return out;
  }

  /* ============================== conversion ============================== */

  function rateFor(cur) {
    if (!rates || !cur) return null;
    if (cur === 'USD') return rates.usdToToman;
    const r = rates.perCurrency ? rates.perCurrency[cur] : null;
    return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : null;
  }

  function tomanFor(amount, cur) {
    const rate = rateFor(cur);
    if (rate == null) return null;
    return Math.round(amount * rate);
  }

  /* ============================== formatting ============================== */

  function fmtFull(n) {
    const s = Math.round(n).toLocaleString('en-US');
    return settings.digits === 'fa' ? toFaDigits(s).replace(/,/g, '\u066C') : s;
  }

  /** Compact: "۳۰٫۸ میلیون تومان" — falls back to the full number below 1M. */
  function fmtTomanNum(v) {
    const n = Math.round(v);
    if (settings.compact && n >= 1e6) {
      const div = n >= 1e9 ? 1e9 : 1e6;
      const unit = n >= 1e9 ? (settings.digits === 'fa' ? 'میلیارد' : 'billion')
                            : (settings.digits === 'fa' ? 'میلیون' : 'million');
      const q = Math.round((n / div) * 10) / 10;
      let qBase = q.toFixed(1).replace(/\.0$/, '');      // 19.0 -> "19"
      if (settings.digits === 'fa') qBase = toFaDigits(qBase).replace('.', '\u066B');
      return qBase + ' ' + unit;
    }
    return fmtFull(n);
  }

  /** Range: "۲٫۵ تا ۵٫۱ میلیون" when both ends share one tier, else verbose. */
  function fmtRange(a, b) {
    const tier = (n) => (Math.round(n) >= 1e9 ? 1e9 : Math.round(n) >= 1e6 ? 1e6 : 0);
    const ta = tier(a), tb = tier(b);
    if (ta && ta === tb) {
      const q = (n) => {
        const qv = Math.round((n / ta) * 10) / 10;
        let s = qv.toFixed(1).replace(/\.0$/, '');
        if (settings.digits === 'fa') s = toFaDigits(s).replace('.', '\u066B');
        return s;
      };
      const unit = ta === 1e9 ? 'میلیارد' : 'میلیون';
      return q(a) + ' ' + STR.rangeTo + ' ' + q(b) + ' ' + unit;
    }
    return fmtTomanNum(a) + ' ' + STR.rangeTo + ' ' + fmtTomanNum(b);
  }

  function faDateTime(ts) {
    try {
      return new Date(ts).toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) {
      return new Date(ts).toISOString();
    }
  }

  function tooltipText(items) {
    const lines = [];
    for (const it of items) {
      const rate = rateFor(it.cur);
      lines.push(
        STR.tooltipRate + ': 1 ' + it.cur + ' = ' +
        (rate ? Math.round(rate).toLocaleString('en-US') : '?') + ' ' + STR.toman +
        '   |   ' + fmtFull(it.amount) + ' ' + it.cur + ' = ' +
        fmtFull(it.toman) + ' ' + STR.toman
      );
    }
    lines.push(STR.tooltipSource + ': ' + (ratesMeta && ratesMeta.source ? ratesMeta.source : '?'));
    if (ratesMeta && ratesMeta.updatedAt) {
      lines.push(STR.tooltipUpdated + ': ' + faDateTime(ratesMeta.updatedAt));
    }
    if (ratesMeta && (ratesMeta.stale || (Date.now() - (ratesMeta.updatedAt || 0)) > STALE_AFTER_MS)) {
      lines.push('(stale rates — caches serve until the next successful refresh)');
    }
    return lines.join('\n');
  }

  /* --------------------------- badge rendering ---------------------------- */

  /**
   * items: [{ cur, amount, toman }] — one entry per price, two for a range.
   * parens=false renders bare text (used by the "replace" display mode).
   */
  function makeBadge(toman, cur, items, anchorText, parens) {
    const badge = document.createElement('span');
    badge.className = 'deko-badge deko-pop';
    if (Date.now() < liveFlashUntil) badge.classList.add('deko-live');
    badge.dir = 'rtl';

    let inner;
    if (items.length === 2) {
      inner = STR.approx + ' ' + fmtRange(items[0].toman, items[1].toman) + ' ' + STR.toman;
    } else {
      inner = STR.approx + ' ' + fmtTomanNum(items[0].toman) + ' ' + STR.toman;
    }
    badge.textContent = parens ? '(' + inner + ')' : inner;
    badge.title = tooltipText(items);
    if (anchorText) badge.dataset.dekoAnchor = anchorText;
    return badge;
  }

  /* ============================= DOM scanning ============================= */

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'CODE', 'PRE', 'KBD', 'SAMP', 'SVG', 'MATH', 'CANVAS', 'IFRAME',
    'OBJECT', 'EMBED', 'TEMPLATE',
  ]);

  // Re-created on wipeAndRescan so a settings change re-badges every node.
  let processedText = new WeakSet();

  function skipParent(el) {
    if (!el) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('.deko-badge, .deko-replaced, [data-deko-ignore], [contenteditable="true"]')) return true;
    return false;
  }

  function collectTextNodes(root) {
    const out = [];
    if (!root || root.nodeType !== 1) return out;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p || skipParent(p)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) out.push(walker.currentNode);
    return out;
  }

  function markTreeProcessed(el) {
    if (!el || el.nodeType !== 1) return;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) processedText.add(w.currentNode);
  }

  /* ------------------------- split-price containers ------------------------
   * Amazon splits one price across sibling spans:
   *   <span class="a-price">
   *     <span class="a-price-symbol">€</span>
   *     <span class="a-price-whole">106<span class="a-price-decimal">.</span></span>
   *     <span class="a-price-fraction">99</span>
   *     <span class="a-offscreen">€106.99</span>   <- accessible full copy
   *   </span>
   * v2: prefer .a-offscreen; when composing manually, strip the trailing
   * decimal from "whole" first ("106." + "." + "99" was the 1000x bug).
   * ------------------------------------------------------------------------ */

  function amazonSplit(root) {
    for (const el of root.querySelectorAll('.a-price')) {
      if (el.hasAttribute('data-deko-split')) continue;
      if (el.closest('.deko-badge, [data-deko-ignore]')) continue;

      const sym = el.querySelector('.a-price-symbol');
      const whole = el.querySelector('.a-price-whole');
      const frac = el.querySelector('.a-price-fraction');
      if (!sym || !whole) continue;

      let cur = tokenToCurrency(sym.textContent);
      let num = null;

      // 1) The offscreen copy carries the properly formatted full price.
      const off = el.querySelector('.a-offscreen');
      if (off) {
        const t = (off.textContent || '').trim();
        const m = /^\s*([^\d]*?)\s*([\d.,\u060C\u066C\u066B\u06F0-\u06F9\u0660-\u0669]+)\s*$/.exec(t);
        if (m) {
          const c2 = tokenToCurrency(m[1]) || cur;
          const n2 = parseNumber(m[2]);
          if (c2 && n2 != null) { cur = c2; num = n2; }
        }
      }

      // 2) Compose from whole + fraction (whole may end with a hidden ".").
      if (num == null) {
        const w = whole.textContent.replace(/[\s\u00A0]*[.,\u066B\u066C]\s*$/, '').trim();
        const f = frac ? (frac.textContent || '').replace(/\D/g, '').slice(0, 2) : '';
        num = parseNumber(w + (f ? '.' + f : ''));
      }

      if (num == null || !cur) continue;
      const toman = tomanFor(num, cur);
      if (toman == null) continue;

      el.insertAdjacentElement('afterend', makeBadge(toman, cur, [{ cur, amount: num, toman }], null));
      el.setAttribute('data-deko-split', '1');
      markTreeProcessed(el);
    }
  }

  /**
   * Generic sibling split: a lone "$" span directly followed by a lone "1,299"
   * span (and optionally a "99" fraction span). Fractions are cents.
   */
  function trySplitFromSymbol(symEl) {
    const symText = (symEl.textContent || '').trim();
    const cur = tokenToCurrency(symText);
    if (!cur) return;
    let el = symEl.nextElementSibling;
    let num = null, numEl = null, fracEl = null;
    for (let hops = 0; el && hops < 3; hops++, el = el.nextElementSibling) {
      const t = (el.textContent || '').trim();
      if (SYMBOL_ONLY_RE.test(t)) continue;
      if (!numEl && HAS_DIGIT_RE.test(t)) {
        numEl = el;
        const parts = t.split(/[.,\u066B\u066C]/).filter(Boolean);
        if (parts.length === 2 && parts[1].length <= 2 && el.children.length === 0) {
          // "99"-style fraction-only span handled below via nextElementSibling
          const nf = el.nextElementSibling;
          if (nf && /^\s*\d{1,2}\s*$/.test(nf.textContent || '')) fracEl = nf;
        }
        num = parseNumber(t);
        break;
      }
    }
    if (!numEl || num == null) return;
    if (fracEl) {
      const f = (fracEl.textContent || '').replace(/\D/g, '').slice(0, 2);
      const base = parseNumber((numEl.textContent || '').replace(/[\s\u00A0]*[.,\u066B\u066C]\s*$/, '').trim());
      num = base != null && f ? base + Number(f) / 100 : num;
    }
    const toman = tomanFor(num, cur);
    if (toman == null) return;
    const anchor = (numEl.parentElement && (numEl.parentElement.textContent || '').replace(/\s+/g, '')
      === ((symText + (numEl.textContent || '') + (fracEl ? fracEl.textContent : '')).replace(/\s+/g, '')))
      ? numEl.parentElement : numEl;
    if (anchor.hasAttribute('data-deko-split')) return;
    anchor.insertAdjacentElement('afterend', makeBadge(toman, cur, [{ cur, amount: num, toman }], null));
    markTreeProcessed(anchor.parentElement && anchor.parentElement !== anchor ? anchor.parentElement : anchor);
    anchor.setAttribute('data-deko-split', '1');
  }

  /* ---------------------------- text processing ---------------------------- */

  function processTextNode(node) {
    if (processedText.has(node)) return;
    const text = node.nodeValue;
    if (!text || text.length > 3000 || !HAS_DIGIT_RE.test(text) || !HINT_RE.test(text)) {
      processedText.add(node);
      return;
    }
    processedText.add(node);
    if (!effectiveEnabled() || isSiteDisabled()) return;

    const matches = collectMatches(text);
    if (!matches.length) return;

    const items = [];
    for (const m of matches) {
      if (m.type === 'single') {
        const toman = tomanFor(m.v, m.cur);
        if (toman == null) { items.push(null); continue; }
        items.push({ type: 'single', start: m.start, end: m.end, toman, cur: m.cur, amount: m.v });
      } else {
        const t1 = tomanFor(m.v1, m.cur);
        const t2 = tomanFor(m.v2, m.cur);
        if (t1 == null || t2 == null) { items.push(null); continue; }
        items.push({
          type: 'range', start: m.start, end: m.end,
          toman: Math.min(t1, t2), cur: m.cur,
          amounts: [{ amount: m.v1, toman: t1 }, { amount: m.v2, toman: t2 }],
        });
      }
    }
    if (!items.some(Boolean)) return;

    const mode = settings.displayMode || 'append';
    const original = node.nodeValue;
    const parent = node.parentNode;
    if (!parent) return;

    if (mode === 'tooltip') {
      const el = parent;
      const tipItems = [];
      for (const it of items) {
        if (!it) continue;
        if (it.type === 'single') tipItems.push({ cur: it.cur, amount: it.amount, toman: it.toman });
        else for (const a of it.amounts) tipItems.push({ cur: it.cur, amount: a.amount, toman: a.toman });
      }
      el.setAttribute('data-deko-tip', '1');
      el.title = (el.title ? el.title + '\n' : '') + tooltipText(tipItems);
      return;
    }

    const frag = document.createDocumentFragment();
    let lastEnd = 0;
    for (const it of items) {
      if (!it) continue;
      if (it.start > lastEnd) {
        const tn = document.createTextNode(original.slice(lastEnd, it.start));
        processedText.add(tn);
        frag.appendChild(tn);
      }
      const matchedText = original.slice(it.start, it.end);
      if (mode === 'replace') {
        const span = document.createElement('span');
        span.className = 'deko-badge deko-replaced';
        span.dir = 'rtl';
        const inner = it.type === 'single'
          ? fmtTomanNum(it.toman) + ' ' + STR.toman
          : STR.approx + ' ' + fmtRange(it.amounts[0].toman, it.amounts[1].toman) + ' ' + STR.toman;
        span.textContent = inner;
        span.title = tooltipText(it.type === 'single'
          ? [{ cur: it.cur, amount: it.amount, toman: it.toman }]
          : it.amounts.map((a) => ({ cur: it.cur, amount: a.amount, toman: a.toman })));
        span.dataset.dekoOrig = matchedText;
        frag.appendChild(span);
      } else {
        const badgeIt = it.type === 'single'
          ? [{ cur: it.cur, amount: it.amount, toman: it.toman }]
          : it.amounts.map((a) => ({ cur: it.cur, amount: a.amount, toman: a.toman }));
        frag.appendChild(makeBadge(it.toman, it.cur, badgeIt, matchedText, true));
      }
      const tn2 = document.createTextNode(matchedText);
      processedText.add(tn2);
      frag.appendChild(tn2);
      lastEnd = it.end;
    }
    if (lastEnd < original.length) {
      const tn3 = document.createTextNode(original.slice(lastEnd));
      processedText.add(tn3);
      frag.appendChild(tn3);
    }
    scanPaused = true;
    try {
      parent.replaceChild(frag, node);
    } catch (e) { /* detached mid-flight */ }
    scanPaused = false;
  }

  /* ------------------------------ scan pump ------------------------------- */

  const queue = [];
  let pumping = false;

  function enqueueRoot(root) {
    for (const n of collectTextNodes(root)) queue.push(n);
    pump();
  }

  function pump() {
    if (pumping) return;
    pumping = true;
    const step = () => {
      const t0 = performance.now();
      while (queue.length && performance.now() - t0 < 12) {
        const node = queue.shift();
        try { processTextNode(node); } catch (e) { /* keep going */ }
      }
      if (queue.length) scheduleNext(step);
      else pumping = false;
    };
    scheduleNext(step);
  }

  function scheduleNext(fn) {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 500 });
    else setTimeout(fn, 0);
  }

  function scanRoot(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.closest && root.closest('.deko-badge, .deko-replaced, [data-deko-ignore]')) return;
    amazonSplit(root);
    enqueueRoot(root);
    // lone "$"-symbol spans next to number spans (generic split prices)
    for (const node of collectTextNodes(root)) {
      if (processedText.has(node)) continue;
      const t = node.nodeValue;
      if (SYMBOL_ONLY_RE.test(t)) {
        processedText.add(node);
        if (node.parentElement) trySplitFromSymbol(node.parentElement);
      }
    }
  }

  /* ------------------------------- observer ------------------------------- */

  let pendingRoots = new Set();
  let pendingTexts = [];
  let flushTimer = null;

  const mo = new MutationObserver((muts) => {
    if (scanPaused) return;
    if (!effectiveEnabled() || isSiteDisabled()) return;
    for (const m of muts) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) {
            if (n.classList && (n.classList.contains('deko-badge') || n.classList.contains('deko-replaced'))) continue;
            pendingRoots.add(n);
          } else if (n.nodeType === 3) {
            if (processedText.has(n)) continue;
            const p = n.parentElement;
            if (p && (p.closest('.deko-badge, .deko-replaced') || skipParent(p))) continue;
            pendingTexts.push(n);
          }
        }
        // a removed price may have been inside a container we marked
        for (const n of m.removedNodes) {
          if (n.nodeType === 1 && n.hasAttribute && n.hasAttribute('data-deko-split')) {
            // keep the attribute; harmless when re-added, cleared on rescan
          }
        }
      } else if (m.type === 'characterData' && m.target.nodeType === 3) {
        const t = m.target;
        processedText.delete(t); // text changed -> scan it again
        pendingTexts.push(t);
      }
    }
    if (pendingRoots.size || pendingTexts.length) scheduleFlush();
  });

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushPending();
    }, 300);
  }

  function flushPending() {
    const roots = [...pendingRoots];
    pendingRoots = new Set();
    const texts = pendingTexts;
    pendingTexts = [];
    for (const el of roots) {
      try { scanRoot(el); } catch (e) { /* keep going */ }
    }
    for (const t of texts) {
      try { processTextNode(t); } catch (e) { /* keep going */ }
    }
    pump();
  }

  /* --------------------------- wipe and rescan ---------------------------- */

  function removeAllBadges() {
    queue.length = 0;
    for (const b of document.querySelectorAll('.deko-badge')) b.remove();
    for (const r of document.querySelectorAll('.deko-replaced')) {
      const orig = r.dataset.dekoOrig || '';
      r.replaceWith(document.createTextNode(orig));
    }
    for (const el of document.querySelectorAll('[data-deko-tip]')) {
      el.removeAttribute('data-deko-tip');
      el.removeAttribute('title');
    }
    processedText = new WeakSet();
  }

  let rescanTimer = null;
  function wipeAndRescan() {
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      removeAllBadges();
      if (effectiveEnabled() && !isSiteDisabled() && document.body) {
        scanRoot(document.body);
      }
    }, 200);
  }

  /* ------------------------------- init ---------------------------------- */

  function startObserver() {
    mo.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  function applyRates(cache) {
    if (cache && cache.rates && cache.rates.usdToToman) {
      rates = cache.rates;
      ratesMeta = cache;
      return true;
    }
    return false;
  }

  /* ------------------------- v2.2 live updates ----------------------------
   * The background broadcasts DEKO_RATES_UPDATED to every tab the moment a
   * refresh lands (alarm, popup refresh, or a page-load refresher). We only
   * wipe + rescan when the NUMBERS actually changed (cheap JSON compare) so
   * quiet polls never churn the page. While a change-driven rescan is in
   * flight, newly created badges get the "deko-live" glow so the user can
   * literally see the rates updating in real time.                          */

  let lastRatesJson = null;
  let liveFlashUntil = 0;

  /** order-independent stringify: key order may differ between a full pass
   *  and a cheap pass even when the VALUES are identical */
  function stableStringify(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
  }

  function ratesChanged(cache) {
    const j = cache && cache.rates ? stableStringify(cache.rates) : null;
    if (j == null || j === lastRatesJson) return false;
    lastRatesJson = j;
    return true;
  }

  function onLiveRates(cache, changed) {
    if (!applyRates(cache)) return;
    if (changed && ratesChanged(cache)) {
      liveFlashUntil = Date.now() + 4000;
      if (effectiveEnabled() && !isSiteDisabled()) wipeAndRescan();
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'DEKO_RATES_UPDATED') onLiveRates(msg.cache, msg.changed);
  });

  async function init() {
    const st = await chrome.storage.local.get([SETTINGS_KEY, RATES_CACHE_KEY]);
    settings = Object.assign({}, DEFAULT_SETTINGS, st[SETTINGS_KEY] || {});
    applyRates(st[RATES_CACHE_KEY] || null);
    if (st[RATES_CACHE_KEY]) ratesChanged(st[RATES_CACHE_KEY]); // prime the JSON baseline

    // Ask the service worker; fresh:'auto' also triggers a background live
    // pull when the cache is older than 3 minutes (page still paints from
    // the cached answer instantly, then updates via the live broadcast).
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'DEKO_GET_RATES', fresh: 'auto' });
      if (resp) {
        applyRates(resp);
        ratesChanged(resp);
      }
    } catch (e) { /* storage copy already loaded */ }

    if (effectiveEnabled() && !isSiteDisabled() && document.body) {
      scanRoot(document.body);
    }
    startObserver();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[SETTINGS_KEY]) {
        settings = Object.assign({}, DEFAULT_SETTINGS, changes[SETTINGS_KEY].newValue || {});
        wipeAndRescan();
      }
      if (changes[RATES_CACHE_KEY]) {
        const nv = changes[RATES_CACHE_KEY].newValue || null;
        const didChange = ratesChanged(nv);
        applyRates(nv);
        if (didChange && effectiveEnabled() && !isSiteDisabled()) {
          liveFlashUntil = Date.now() + 4000;
          wipeAndRescan();
        }
      }
    });
  }

  init();

  /* ------------------------- dev/test hook (inert) ------------------------
   * Only exposed when the URL hash asks for it — used by dev/test.html.     */
  if (location.hash === '#deko-test') {
    window.__deko2_test = {
      parseNumber,
      fmtTomanNum: (v) => fmtTomanNum(v) + ' ' + STR.toman,
      tomanFor,
      collectMatches,
      setRates: (r) => { rates = r; },
      getRates: () => rates,
      setSettings: (s) => { settings = Object.assign({}, DEFAULT_SETTINGS, s); },
      rescan: () => { removeAllBadges(); scanRoot(document.body); },
    };
  }
})();

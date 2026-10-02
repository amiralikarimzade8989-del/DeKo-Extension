'use strict';

/* ============================================================================
 * DeKo AI — دستیار هوشمند اختصاصی افزونه DeKo (v2.4.0)
 * ----------------------------------------------------------------------------
 * A DEDICATED offline assistant engine for this extension only. It answers
 * Persian (and basic English) currency questions using the extension's LIVE
 * rate cache — no server, no key, no privacy leak. The popup chat tab runs
 * this engine; if the user connects an OpenAI-compatible LLM in options, the
 * same chat upgrades to that LLM (with DeKoAI.SYSTEM_PROMPT + live rates).
 *
 * Engine capabilities:
 *   - convert foreign -> toman     «۱۰۰ دلار چنده؟» / "how much is 100 usd"
 *   - convert toman -> foreign     «۲۵ میلیون تومان چند یورو میشه؟»
 *   - single rate query            «نرخ پوند چنده؟»
 *   - all rates                    «همه نرخ‌ها رو بگو»
 *   - weekly trend                 «روند دلار چطوره؟»
 *   - profit/loss vs 7d history    «هفته پیش ۱۰۰۰ دلار خریده بودم، الان؟»
 *   - compare two currencies       «دلار یا یورو؟»
 *   - greeting / thanks / help / identity / graceful fallback
 *
 * Parsing: Persian+Arabic+Latin digits, ٫ decimal, ٬ and , thousands,
 * number words (یک..نهصد، نیم) with هزار/میلیون/میلیارد multipliers and «و»
 * compounds («دو میلیون و پانصد هزار»), currency aliases + $ € £ ¥ symbols,
 * ZWNJ/diacritics normalization, common typos (تومن، اورو…).
 *
 * Formatting: Persian digits ۰-۹, thousands «٬» (U+066C), decimal «٫» (U+066B),
 * compact «۲۵٫۴۷ میلیون» — same standard as the popup (fa-IR style).
 *
 * This file is DOM-free so the 10,000-question test suite can run it in Node:
 *   module.exports = DeKoAI  (when loaded by Node)
 * ==========================================================================*/

const DeKoAI = (function () {

  const VERSION = '2.4.0';

  /* ----------------------------- digits ----------------------------------- */

  const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

  function faDigits(s) {
    return String(s).replace(/\d/g, (d) => FA_DIGITS[+d]);
  }

  function toEnDigits(s) {
    return String(s)
      .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
      .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
  }

  /* --------------------------- formatting --------------------------------- */

  function groupThousands(intStr) {
    return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
  }

  /** 254700 -> «۲۵۴٬۷۰۰» (rounded integer, Persian digits) */
  function fmtFull(n) {
    if (!Number.isFinite(n)) return '—';
    const v = Math.round(n);
    const sign = v < 0 ? 'منفی ' : '';
    return sign + faDigits(groupThousands(String(Math.abs(v))));
  }

  /** 98.156 -> «۹۸٫۱۶» · 25 -> «۲۵» (maxDec decimals, zeros stripped) */
  function fmtDec(n, maxDec) {
    if (!Number.isFinite(n)) return '—';
    maxDec = maxDec == null ? 2 : maxDec;
    const neg = n < 0;
    const parts = Math.abs(n).toFixed(maxDec).split('.');
    const d = (parts[1] || '').replace(/0+$/, '');
    return (neg ? 'منفی ' : '') +
      faDigits(groupThousands(parts[0]) + (d ? '٫' + d : ''));
  }

  /** 25370000 -> «۲۵٫۳۷ میلیون» · 1200 -> «۱٫۲ هزار» · 900 -> «۹۰۰» */
  function fmtCompact(n) {
    if (!Number.isFinite(n)) return '—';
    const a = Math.abs(n);
    const sign = n < 0 ? 'منفی ' : '';
    if (a >= 1e9) return sign + fmtDec(a / 1e9) + ' میلیارد';
    if (a >= 1e6) return sign + fmtDec(a / 1e6) + ' میلیون';
    if (a >= 1e4) return sign + fmtDec(a / 1e3) + ' هزار';
    return sign + fmtFull(a);
  }

  /** 0.39 -> «۰٫۳۹٪» */
  function fmtPct(p) {
    if (!Number.isFinite(p)) return '';
    return fmtDec(Math.abs(p), 2) + '٪';
  }

  /* -------------------------- currency metadata ---------------------------- */

  const META = {
    USD: { name: 'دلار آمریکا', short: 'دلار' },
    EUR: { name: 'یورو', short: 'یورو' },
    GBP: { name: 'پوند انگلیس', short: 'پوند' },
    AED: { name: 'درهم امارات', short: 'درهم' },
    TRY: { name: 'لیر ترکیه', short: 'لیر' },
    CNY: { name: 'یوان چین', short: 'یوان' },
    CAD: { name: 'دلار کانادا', short: 'دلار کانادا' },
    AUD: { name: 'دلار استرالیا', short: 'دلار استرالیا' },
    JPY: { name: 'ین ژاپن', short: 'ین' },
    SAR: { name: 'ریال سعودی', short: 'ریال سعودی' },
    INR: { name: 'روپیه هند', short: 'روپیه' },
    CHF: { name: 'فرانک سوئیس', short: 'فرانک' },
    RUB: { name: 'روبل روسیه', short: 'روبل' },
  };

  const ORDER = ['USD', 'EUR', 'GBP', 'AED', 'TRY', 'CNY', 'CAD', 'AUD', 'JPY', 'SAR', 'INR', 'CHF', 'RUB'];

  /* aliases are matched against NORMALIZED tokens; first bigram wins */
  const ALIAS_BIGRAM = {
    'دلار آمریکا': 'USD', 'دلار امریکا': 'USD',
    'دلار کانادا': 'CAD', 'دلار کاناد': 'CAD',
    'دلار استرالیا': 'AUD', 'دلار استرالی': 'AUD',
    'پوند انگلیس': 'GBP',
    'درهم امارات': 'AED', 'درهم دبی': 'AED',
    'لیر ترکیه': 'TRY', 'تورک لیر': 'TRY',
    'یوان چین': 'CNY',
    'ین ژاپن': 'JPY',
    'ریال سعودی': 'SAR', 'ریال عربستان': 'SAR',
    'روپیه هند': 'INR',
    'فرانک سوئیس': 'CHF',
    'روبل روسیه': 'RUB',
    'تومان ایران': 'TOMAN',
  };
  const ALIAS_UNI = {
    'دلار': 'USD', 'usd': 'USD', '$': 'USD', 'دلارها': 'USD',
    'یورو': 'EUR', 'اورو': 'EUR', 'eur': 'EUR', '€': 'EUR',
    'پوند': 'GBP', 'gbp': 'GBP', '£': 'GBP',
    'درهم': 'AED', 'aed': 'AED',
    'لیر': 'TRY', 'try': 'TRY',
    'یوان': 'CNY', 'cny': 'CNY', 'رنمینبی': 'CNY',
    'cad': 'CAD',
    'aud': 'AUD',
    'ین': 'JPY', 'jpy': 'JPY', '¥': 'JPY',
    'ریال': 'SAR', 'سعودی': 'SAR', 'sar': 'SAR',
    'روپیه': 'INR', 'inr': 'INR',
    'فرانک': 'CHF', 'chf': 'CHF',
    'روبل': 'RUB', 'rub': 'RUB',
    'تومان': 'TOMAN', 'تومن': 'TOMAN', 'toman': 'TOMAN',
  };

  /* glued code after digits: "100usd" */
  const GLUED_CODE = /(\d)(usd|eur|gbp|aed|try|cny|cad|aud|jpy|sar|inr|chf|rub)$/;

  /* --------------------------- word numbers -------------------------------- */

  const WORD_NUM = {
    'صفر': 0, 'یک': 1, 'یه': 1, 'دو': 2, 'سه': 3, 'چهار': 4, 'چار': 4,
    'پنج': 5, 'شش': 6, 'هفت': 7, 'هشت': 8, 'نه': 9, 'ده': 10,
    'یازده': 11, 'دوازده': 12, 'سیزده': 13, 'چهارده': 14, 'پانزده': 15,
    'شانزده': 16, 'هفده': 17, 'هجده': 18, 'نوزده': 19,
    'بیست': 20, 'سی': 30, 'چهل': 40, 'پنجاه': 50, 'شصت': 60,
    'هفتاد': 70, 'هشتاد': 80, 'نود': 90,
    'صد': 100, 'یکصد': 100, 'دویست': 200, 'سیصد': 300, 'چهارصد': 400,
    'پانصد': 500, 'پنجصد': 500, 'ششصد': 600, 'هفتصد': 700,
    'هشتصد': 800, 'نهصد': 900, 'نیم': 0.5, 'ربع': 0.25,
  };
  const MULT = { 'هزار': 1e3, 'میلیون': 1e6, 'میلیارد': 1e9, 'ملیارد': 1e9 };

  /* ---------------------------- normalization ------------------------------ */

  function normalize(input) {
    let s = toEnDigits(String(input || ''));
    s = s.replace(/\u200c/g, ' ');                       // ZWNJ -> space
    s = s.replace(/[\u064B-\u0652\u0670\u0640]/g, '');   // diacritics + tatweel
    s = s.replace(/[يى]/g, 'ی').replace(/ك/g, 'ک');
    s = s.toLowerCase();
    s = s.replace(/تومن/g, 'تومان');
    s = s.replace(/[؟?!،؛:«»"'()\[\]{}…\-–—=+*#@$%^&]/g, (m) => (m === '$' ? ' $ ' : ' '));
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  /* token is a standalone number? ("12.99", "100", "2,500" -> already cleaned)
   * Persian decimal separator «٫» (U+066B) is mapped to "." here; «٬»/"," are
   * thousands separators and get dropped. */
  function numTokenValue(t) {
    const cleaned = t.replace(/[,٬]/g, '').replace(/٫/g, '.');
    const m = cleaned.match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  }

  /* ------------------------- amount cluster parser --------------------------
   * Scans the WHOLE token list and returns every "cluster": a maximal run of
   * {number|word-num|multiplier|و}. A cluster value = Σ (pending||1)*mult plus
   * trailing pending. Multiple clusters matter because Persian determiners
   * like «یک» in «یک هفته اخیر» are ALSO number-words — the real amount sits
   * in a different cluster, and the ADJACENCY rule in parse() picks it.      */
  function parseAmounts(toks) {
    const clusters = [];
    let i = 0;
    while (i < toks.length) {
      const t = toks[i];
      if (/\d/.test(t) || WORD_NUM[t] != null || MULT[t] != null) {
        let base = 0;      // completed multiplier terms
        let pending = 0;   // awaiting a multiplier (or final)
        let end = i;
        for (let j = i; j < toks.length; j++) {
          const w = toks[j];
          if (/\d/.test(w)) { pending += numTokenValue(w) || 0; end = j; continue; }
          if (WORD_NUM[w] != null) { pending += WORD_NUM[w]; end = j; continue; }
          if (MULT[w] != null) { base += (pending || 1) * MULT[w]; pending = 0; end = j; continue; }
          if (w === 'و' && j + 1 < toks.length &&
              (/\d/.test(toks[j + 1]) || WORD_NUM[toks[j + 1]] != null)) { end = j; continue; }
          break;
        }
        const value = base + pending;
        if (Number.isFinite(value) && value > 0) clusters.push({ value, start: i, end });
        i = end + 1;
      } else {
        i += 1;
      }
    }
    return clusters;
  }

  /* ------------------------- currency detection ---------------------------- */

  function detectCurrencies(toks) {
    const out = [];
    for (let i = 0; i < toks.length;) {
      const bi = i + 1 < toks.length ? toks[i] + ' ' + toks[i + 1] : null;
      if (bi && ALIAS_BIGRAM[bi]) {
        out.push({ code: ALIAS_BIGRAM[bi], i, len: 2 });
        i += 2; continue;
      }
      let code = ALIAS_UNI[toks[i]] || null;
      if (!code) {
        /* suffix forms: «دلاره» «تومانه» «دلارهای» */
        if (toks[i].length > 3 && toks[i].endsWith('های')) {
          code = ALIAS_UNI[toks[i].slice(0, -3)] || null;
        }
        if (!code && toks[i].length > 2 && toks[i].endsWith('ه')) {
          code = ALIAS_UNI[toks[i].slice(0, -1)] || null;
        }
      }
      if (!code) {
        const g = toks[i].match(GLUED_CODE);
        if (g) code = g[2].toUpperCase();
      }
      if (!code && /^\$/.test(toks[i])) code = 'USD';
      if (!code && /^€/.test(toks[i])) code = 'EUR';
      if (!code && /^£/.test(toks[i])) code = 'GBP';
      if (!code && /^¥/.test(toks[i])) code = 'JPY';
      if (code) { out.push({ code, i, len: 1 }); i += 1; continue; }
      i += 1;
    }
    return out;
  }

  /* ------------------------------ parse() ---------------------------------- */

  /* NOTE: JS \b only knows [A-Za-z0-9_] — Persian letters are "non-word" to
   * it, so \bسلام\b NEVER matches. All Persian boundary checks below are
   * either plain substrings (safe inside normalized text) or token tests. */
  const TREND_RE = /روند|بالا|پایین|وضعیت|نسبت به|تغییر|رشد|افت|هفته|دیروز|چند روز/;
  const PROFIT_RE = /خریده بودم|خریده بود|خریدم|بخرم|بفروشم|فروختم|سود|ضرر|سرمایه/;
  const ALL_RE = /نرخ ?ها|همه نرخ|لیست نرخ|تمام نرخ|همه ارز/;
  const COMPARE_RE = /مقایسه|کدوم بهتر|بهتره|ارزون ?تر|گران ?تر|گرون ?تر|ارزشمند ?تر/;
  const HELP_RE = /کمک|راهنما|چیکار میتونی|چه کارایی|چی بلدی|بلدی چی|میتونی چی|توانایی/;
  const WHO_RE = /تو کی|کی هستی|چیستی|اسمت چیه|معرفی کن|خودتو/;
  const THANKS_RE = /مرسی|ممنون|تشکر|سپاس|دستت درد|لطف کردی/;
  const GREET_TOKENS = ['سلام', 'درود', 'هی', 'های', 'خوبی'];

  function parse(input) {
    const norm = normalize(input);
    const toks = norm.split(' ').filter(Boolean);
    const mentions = detectCurrencies(toks);
    const clusters = parseAmounts(toks);

    const tomanM = mentions.filter((m) => m.code === 'TOMAN');
    const foreign = [];
    for (const m of mentions) {
      if (m.code !== 'TOMAN' && !foreign.some((f) => f.code === m.code)) foreign.push(m);
    }

    /* --- amount + its owning currency (ADJACENCY rule) ----------------------
     * «۱۰۰ دلار…» / «$ ۱۰۰» / «۵۰۰ تومان …» — the currency word must touch
     * the amount cluster. This is what keeps «وضعیت دلار توی یک هفته اخیر»
     * from mis-reading «یک» as "1 dollar".                                  */
    let amount = null;
    let src = null;
    outer:
    for (const cl of clusters) {
      for (const m of mentions) {
        if (m.i === cl.end + 1 || m.i + m.len - 1 === cl.start - 1) {
          amount = cl; src = m; break outer;
        }
      }
    }
    if (!amount && clusters.length) {
      /* no currency adjacent: prefer a multiplier cluster («۲ میلیون…»),
       * else the first cluster («۱۰۰ چنده؟» -> USD below) */
      amount = clusters.find((cl) => {
        for (let k = cl.start; k <= cl.end; k++) if (MULT[toks[k]]) return true;
        return false;
      }) || clusters[0];
    }

    /* time reference for profit / trend (plain substrings — see note above) */
    let timeRef = 'now';
    if (norm.includes('هفته پیش') || norm.includes('هفته قبل') || norm.includes('یک هفته')) timeRef = 'week';
    else if (norm.includes('دیروز')) timeRef = 'yesterday';

    /* --- chit-chat (only when there is no currency/amount to handle) ------- */
    if (!foreign.length && !tomanM.length && !amount) {
      if (ALL_RE.test(norm)) return { kind: 'rates-all', norm, toks, mentions, amount, timeRef };
      if (GREET_TOKENS.some((g) => toks.includes(g)) || norm.includes('بخیر')) {
        return { kind: 'greeting', norm, toks, mentions, amount, timeRef };
      }
      if (THANKS_RE.test(norm)) return { kind: 'thanks', norm, toks, mentions, amount, timeRef };
      if (WHO_RE.test(norm)) return { kind: 'who', norm, toks, mentions, amount, timeRef };
      if (HELP_RE.test(norm)) return { kind: 'help', norm, toks, mentions, amount, timeRef };
      return { kind: 'fallback', norm, toks, mentions, amount, timeRef };
    }

    /* --- compare two currencies -------------------------------------------- */
    if (foreign.length >= 2 && (COMPARE_RE.test(norm) || toks.includes('یا'))) {
      return {
        kind: 'compare', norm, toks, mentions, amount, timeRef,
        codes: [foreign[0].code, foreign[1].code],
      };
    }

    const primary = foreign.length ? foreign[0].code : null;

    /* --- profit / loss against 7-day history ------------------------------- */
    if (PROFIT_RE.test(norm) && amount && src && src.code !== 'TOMAN' && timeRef !== 'now') {
      return { kind: 'profit', norm, toks, mentions, amount, timeRef, code: src.code };
    }

    /* --- conversions (src already computed by the adjacency rule) ----------- */
    if (amount) {
      if (src && src.code === 'TOMAN') {
        const target = foreign.length ? foreign[0].code : 'USD';
        return { kind: 'reverse', norm, toks, mentions, amount, timeRef, code: target };
      }
      if (src) {
        return { kind: 'convert', norm, toks, mentions, amount, timeRef, code: src.code };
      }
      /* amount with NO adjacent currency:
       * - a currency IS mentioned somewhere + trend words -> trend
       *   («وضعیت دلار توی یک هفته اخیر» — «یک» is not an amount!)
       * - otherwise treat the bare amount as USD («۱۰۰ چنده؟») */
      if (primary && TREND_RE.test(norm)) {
        return { kind: 'trend', norm, toks, mentions, amount, timeRef, code: primary };
      }
      return { kind: 'convert', norm, toks, mentions, amount, timeRef, code: 'USD' };
    }

    /* --- no amount: rate / trend / compare-intent leftovers ----------------- */
    if (primary) {
      if (TREND_RE.test(norm)) return { kind: 'trend', norm, toks, mentions, amount, timeRef, code: primary };
      return { kind: 'rate', norm, toks, mentions, amount, timeRef, code: primary };
    }
    if (tomanM.length) {
      return { kind: 'toman-help', norm, toks, mentions, amount, timeRef };
    }
    if (TREND_RE.test(norm)) return { kind: 'trend', norm, toks, mentions, amount, timeRef, code: 'USD' };
    return { kind: 'fallback', norm, toks, mentions, amount, timeRef };
  }

  /* ------------------------------ answers ---------------------------------- */

  function relTime(ts) {
    if (!ts) return '';
    const d = Math.max(0, Date.now() - ts);
    if (d < 60000) return 'همین الان';
    const m = Math.floor(d / 60000);
    if (m < 60) return faDigits(m) + ' دقیقه پیش';
    const h = Math.floor(m / 60);
    if (h < 24) return faDigits(h) + ' ساعت پیش';
    return faDigits(Math.floor(h / 24)) + ' روز پیش';
  }

  function nameOf(code) { return (META[code] && META[code].name) || code; }

  function rateOf(ctx, code) {
    const r = ctx && ctx.rates;
    if (!r) return null;
    if (r.perCurrency && r.perCurrency[code] != null) return r.perCurrency[code];
    if (code === 'USD' && r.usdToToman != null) return r.usdToToman;
    return null;
  }

  function metaLine(ctx) {
    const t = relTime(ctx.updatedAt);
    return t ? '\n—\nبروزرسانی: ' + t : '';
  }

  const TXT = {
    greeting:
      'سلام! من DeKo AI هستم، دستیار اختصاصی افزونه DeKo. نرخ لحظه‌ای ارزها رو از بازار آزاد دارم.\nمثلاً بپرس: «۱۰۰ دلار چنده؟» یا «۲۵ میلیون تومان چند یورو میشه؟»',
    thanks: 'خواهش می‌کنم! هر وقت نرخ خواستی همین‌جا باشم.',
    who:
      'من DeKo AI هستم؛ دستیار هوشمند اختصاصی همین افزونه. با نرخ‌های زندهٔ بازار آزاد (arzdigital + tgju + er-api) کار می‌کنم و سؤال‌های تبدیل ارز به تومان رو جواب می‌دم. اطلاعاتت جایی ارسال نمی‌شه؛ همه‌چیز آفلاین داخل افزونه‌ست.',
    help:
      'کارهایی که بلدم:\n• تبدیل ارز به تومان: «۱۰۰ دلار چنده؟» · "how much is 50 eur"\n• تبدیل تومان به ارز: «۲۵ میلیون تومان چند دلاره؟»\n• نرخ تک‌ارز: «نرخ یورو چنده؟»\n• همه نرخ‌ها: «همه نرخ‌ها رو بگو»\n• روند هفت‌روزه: «روند دلار چطوره؟»\n• سود/ضرر: «هفته پیش ۱۰۰۰ دلار خریده بودم، الان چطوره؟»\n• مقایسه: «دلار یا یورو؟»',
    tomanHelp:
      'تومان رو به کدوم ارز تبدیل کنم؟ مثلاً بپرس:\n• «۱ میلیون تومان چند دلاره؟»\n• «۵ میلیون تومان چند یورو میشه؟»',
    fallback:
      'متوجه سؤالت نشدم! من دستیار ارز DeKo هستم. مثلاً این‌طوری بپرس:\n• ۱۰۰ دلار چنده؟\n• ۲۵ میلیون تومان چند یورو میشه؟\n• نرخ پوند چنده؟\n• روند دلار چطوره؟',
    norates:
      'هنوز نرخ‌ها دریافت نشده. یک لحظه صبر کن (یا دکمهٔ بروزرسانی رو بزن) و دوباره بپرس.',
  };

  function ansConvert(ctx, p) {
    const rate = rateOf(ctx, p.code);
    if (rate == null) return { kind: 'rate-na', text: 'نرخ ' + nameOf(p.code) + ' فعلاً در دسترس نیست.' };
    const t = p.amount.value * rate;
    let s = fmtFull(p.amount.value) + ' ' + nameOf(p.code) + ' = ' + fmtFull(t) + ' تومان';
    if (t >= 1e6) s += '\nیعنی حدود ' + fmtCompact(t) + ' تومان';
    s += '\n(نرخ: هر ' + (META[p.code] ? META[p.code].short : p.code) + ' ' + fmtFull(rate) + ' تومان)' + metaLine(ctx);
    return { kind: 'convert', text: s };
  }

  function ansReverse(ctx, p) {
    const rate = rateOf(ctx, p.code);
    if (rate == null) return { kind: 'rate-na', text: 'نرخ ' + nameOf(p.code) + ' فعلاً در دسترس نیست.' };
    const units = p.amount.value / rate;
    let s = fmtFull(p.amount.value) + ' تومان ≈ ' + fmtDec(units) + ' ' + nameOf(p.code);
    if (p.code === 'USD' && !foreignMention(p)) s += '\n(چون ارزی مشخص نکردی، به دلار حساب کردم)';
    s += '\n(نرخ: هر دلار ' + fmtFull(ctx.rates.usdToToman) + ' تومان)' + metaLine(ctx);
    return { kind: 'reverse', text: s };
  }

  function foreignMention(p) {
    return p.mentions.some((m) => m.code !== 'TOMAN');
  }

  function ansRate(ctx, p) {
    const rate = rateOf(ctx, p.code);
    if (rate == null) return { kind: 'rate-na', text: 'نرخ ' + nameOf(p.code) + ' فعلاً در دسترس نیست.' };
    const ch = ctx.changes && ctx.changes[p.code];
    let s = 'هر ' + nameOf(p.code) + ' الان ' + fmtFull(rate) + ' تومان';
    if (ch && Number.isFinite(ch.pct)) {
      s += ch.up === true ? ' (▲ ' : ch.up === false ? ' (▼ ' : ' (';
      s += fmtPct(ch.pct) + ' نسبت به دیروز)';
    }
    s += metaLine(ctx);
    return { kind: 'rate', text: s };
  }

  function ansAllRates(ctx) {
    const per = ctx.rates && ctx.rates.perCurrency ? ctx.rates.perCurrency : {};
    const lines = [];
    for (const c of ORDER) {
      const r = c === 'USD' ? (per.USD != null ? per.USD : ctx.rates.usdToToman) : per[c];
      if (r == null) continue;
      lines.push(nameOf(c) + ': ' + fmtFull(r) + ' تومان');
    }
    if (!lines.length) return { kind: 'norates', text: TXT.norates };
    return { kind: 'rates-all', text: 'نرخ لحظه‌ای بازار آزاد:\n' + lines.join('\n') + metaLine(ctx) };
  }

  function ansTrend(ctx, p) {
    const rate = rateOf(ctx, p.code);
    if (rate == null) return { kind: 'rate-na', text: 'نرخ ' + nameOf(p.code) + ' فعلاً در دسترس نیست.' };
    const ch = ctx.changes && ctx.changes[p.code];
    const hist = ctx.history && ctx.history[p.code];
    let s = 'روند ' + nameOf(p.code) + ':\nالان: ' + fmtFull(rate) + ' تومان';
    if (ch && Number.isFinite(ch.pct)) {
      s += ch.up === true ? ' (▲ ' + fmtPct(ch.pct) + ' نسبت به دیروز)'
        : ch.up === false ? ' (▼ ' + fmtPct(ch.pct) + ' نسبت به دیروز)' : '';
    }
    if (Array.isArray(hist) && hist.length >= 2) {
      const first = hist[0];
      const last = hist[hist.length - 1];
      const week = ((last - first) / first) * 100;
      s += '\n۷ روز اخیر: از ' + fmtFull(first) + ' تا ' + fmtFull(last) + ' تومان';
      s += week >= 0 ? '\nجمع‌بندی: حدود ' + fmtPct(week) + ' رشد ▲'
                     : '\nجمع‌بندی: حدود ' + fmtPct(week) + ' افت ▼';
    } else if (ch && Number.isFinite(ch.pct)) {
      s += ch.up === true ? '\nجمع‌بندی: بالارونده ▲' : ch.up === false ? '\nجمع‌بندی: پایین‌رونده ▼' : '';
    }
    s += metaLine(ctx);
    return { kind: 'trend', text: s };
  }

  function ansProfit(ctx, p) {
    const rate = rateOf(ctx, p.code);
    if (rate == null) return { kind: 'rate-na', text: 'نرخ ' + nameOf(p.code) + ' فعلاً در دسترس نیست.' };
    const hist = ctx.history && ctx.history[p.code];
    if (!Array.isArray(hist) || hist.length < 2) {
      return { kind: 'profit-na', text: 'تاریخچهٔ ۷ روزهٔ ' + nameOf(p.code) + ' فعلاً در دسترس نیست؛ بعد از اولین بروزرسانی کامل دوباره بپرس.' };
    }
    const past = p.timeRef === 'yesterday' ? hist[hist.length - 2] : hist[0];
    if (!Number.isFinite(past) || past <= 0) {
      return { kind: 'profit-na', text: 'تاریخچهٔ ' + nameOf(p.code) + ' کامل نیست.' };
    }
    const when = p.timeRef === 'yesterday' ? 'دیروز' : 'هفته پیش (' + faDigits(7) + ' روز قبل)';
    const cost = p.amount.value * past;
    const now = p.amount.value * rate;
    const diff = now - cost;
    const pct = (diff / cost) * 100;
    let s = fmtFull(p.amount.value) + ' ' + nameOf(p.code) + ' ' + when + ': ' + fmtFull(cost) + ' تومان';
    s += '\nالان: ' + fmtFull(now) + ' تومان';
    if (diff >= 0) {
      s += '\nسود: ' + fmtFull(diff) + ' تومان (▲ ' + fmtPct(pct) + ')';
    } else {
      s += '\nضرر: ' + fmtFull(Math.abs(diff)) + ' تومان (▼ ' + fmtPct(pct) + ')';
    }
    s += metaLine(ctx);
    return { kind: 'profit', text: s };
  }

  function ansCompare(ctx, p) {
    const lines = [];
    const vals = [];
    for (const c of p.codes) {
      const r = rateOf(ctx, c);
      if (r == null) return { kind: 'rate-na', text: 'نرخ ' + nameOf(c) + ' فعلاً در دسترس نیست.' };
      const ch = ctx.changes && ctx.changes[c];
      let line = nameOf(c) + ': ' + fmtFull(r) + ' تومان';
      if (ch && Number.isFinite(ch.pct)) {
        line += ch.up === true ? ' (▲ ' + fmtPct(ch.pct) + ')'
              : ch.up === false ? ' (▼ ' + fmtPct(ch.pct) + ')' : '';
      }
      lines.push(line);
      vals.push({ c, r });
    }
    vals.sort((a, b) => a.r - b.r);
    if (vals.length === 2) {
      lines.push('جمع‌بندی: ' + (META[vals[0].c] ? META[vals[0].c].short : vals[0].c) +
        ' ارزون‌تره، ' + (META[vals[1].c] ? META[vals[1].c].short : vals[1].c) + ' گرون‌تره.');
    }
    return { kind: 'compare', text: lines.join('\n') + metaLine(ctx) };
  }

  /* ------------------------------ answer() --------------------------------- */

  function answer(text, ctx) {
    const p = parse(text);
    switch (p.kind) {
      case 'greeting': return { kind: 'greeting', text: TXT.greeting };
      case 'thanks':   return { kind: 'thanks', text: TXT.thanks };
      case 'who':      return { kind: 'who', text: TXT.who };
      case 'help':     return { kind: 'help', text: TXT.help };
      case 'toman-help': return { kind: 'toman-help', text: TXT.tomanHelp };
      case 'fallback': return { kind: 'fallback', text: TXT.fallback };
    }
    if (!ctx || !ctx.rates || (ctx.rates.usdToToman == null && !ctx.rates.perCurrency)) {
      return { kind: 'norates', text: TXT.norates };
    }
    switch (p.kind) {
      case 'convert':    return ansConvert(ctx, p);
      case 'reverse':    return ansReverse(ctx, p);
      case 'rate':       return ansRate(ctx, p);
      case 'rates-all':  return ansAllRates(ctx);
      case 'trend':      return ansTrend(ctx, p);
      case 'profit':     return ansProfit(ctx, p);
      case 'compare':    return ansCompare(ctx, p);
      default:           return { kind: 'fallback', text: TXT.fallback };
    }
  }

  /* ---------------------- optional real-LLM bridge --------------------------
   * If the user connects an OpenAI-compatible endpoint in options, the popup
   * uses SYSTEM_PROMPT + live rates so the LLM answers as "DeKo AI" too.   */

  const SYSTEM_PROMPT =
    'تو «DeKo AI» هستی؛ دستیار تخصصی افزونهٔ مرورگری DeKo برای تبدیل ارز به تومان ایران. ' +
    'فقط دربارهٔ ارز، نرخ، تومان و موضوعات مالی مرتبط جواب بده؛ سؤال نامرتبط را مؤدبانه به موضوع برگردان. ' +
    'همیشه اعداد را با ارقام فارسی (۰۱۲۳۴۵۶۷۸۹)، جداکنندهٔ هزارگان «٬» و اعشار «٫» بنویس. ' +
    'واحد پیش‌فرض «تومان» است نه ریال. پاسخ کوتاه (حداکثر ۴ خط)، دوستانه و دقیق باشد؛ ' +
    'فقط از نرخ‌های زنده‌ای که در ادامه داده می‌شود استفاده کن و عدد از خودت نساز.';

  function buildLLMContext(cache) {
    if (!cache || !cache.rates) return '{}';
    return JSON.stringify({
      usdToToman: cache.rates.usdToToman,
      perCurrency: cache.rates.perCurrency,
      changes: cache.changes || {},
      updatedAt: cache.updatedAt ? new Date(cache.updatedAt).toISOString() : null,
      source: cache.source || null,
    });
  }

  /* ------------------------------- exports --------------------------------- */

  return {
    version: VERSION,
    answer,
    parse,
    normalize,
    fmtFull, fmtDec, fmtCompact, fmtPct, faDigits, toEnDigits,
    SYSTEM_PROMPT, buildLLMContext,
    _internals: { detectCurrencies, parseAmounts, WORD_NUM, MULT, ALIAS_UNI, ALIAS_BIGRAM, TXT },
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DeKoAI;
}

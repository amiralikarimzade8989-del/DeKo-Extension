# DeKo – Toman Converter (v2.5.0)

A Chrome (MV3) extension that detects foreign-currency prices on any page and
appends the **Iranian free-market Toman** equivalent right next to the original
price. The original price is never modified.

```
$100      ->  $100 (≈ ۲۵٫۴ میلیون تومان)
€106.99   ->  €106.99 (≈ ۳۰٫۸ میلیون تومان)
$10 - $20 ->  $10 - $20 (≈ ۲٫۵ تا ۵٫۱ میلیون تومان)
```

Vanilla JS. No build step. No framework. No tracking.

---

## Install (Load unpacked — 1 minute)

1. Download / extract this folder (the folder that directly contains `manifest.json`).
2. Open `chrome://extensions` in Chrome (or `edge://extensions` in Edge).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select that folder.
5. Done. Visit any site with foreign prices.

## What v2 fixes

- **The 1000× Amazon bug (v1):** Amazon splits one price across sibling spans
  (`a-price-whole` / `a-price-fraction`) and hides a decimal inside "whole".
  v1 composed `106..99`, which the number parser read as thousands → `10699`
  → prices shown 1000× too large. v2 prefers Amazon's accessible
  `.a-offscreen` full-price copy, strips the hidden trailing decimal, and
  rejects malformed number groups (`11..13` → invalid). Regression-tested.

## Rate providers (chain)

| Priority | Source | Unit | Role |
|---|---|---|---|
| AR | `arzdigital.com/currencies/` (server-rendered index page) | **Toman (native)** | **primary LIVE anchor (v2.5, user-requested)** — ONE page fetch carries ~90 currencies incl. ALL 16 DeKo codes as native free-market quotes; prices live inside `<span class="arz-irt-price">` rows in Persian digits |
| T | `api.tgju.org/v1/market/indicator/summary-table-data/{slug}?draw=1&start=0&length=8` | **Rial → /10 → Toman** | **primary LIVE anchor** — 12 NATIVE free-market quotes (USD EUR GBP AED TRY CNY CAD AUD JPY SAR INR CHF) in PARALLEL, plus daily change % and 7-day history. v2.5: fallback anchor + chips/sparklines supplier |
| A | `raw.githubusercontent.com/rate-json/default` data.json | Toman | daily free-market snapshot — fallback anchor + currency filler |
| B | `open.er-api.com/v6/latest/USD` | units per USD | cross-rate chain for every other currency |
| C | manual rates (options) | Toman | gap-filler; or full override |

All feeds were fetched and cross-validated at build time (2026-10-01).
v2.5 verified arzdigital live: USD ۲۵۸٬۷۰۰ EUR ۲۹۲٬۱۵۰ GBP ۳۴۲٬۰۹۰ AED ۷۱٬۱۱۰
TRY ۵٬۲۸۰ CNY ۳۸٬۵۸۰ (Toman) — every implied FX rate within ~1.1% of the
er-api global mid (AED/SAR show the real free-market premium), and arzdigital's
JPY is quoted **per 1 JPY** (implied USD/JPY 158.2 vs er-api 157.3). The old
validation note:
`tgju price_dollar_rl close = 2,547,000 Rial = 254,700 Toman`; provider A's
253,700 = the previous close. v2.3 verified the DataTables pagination
(`?draw=1&start=0&length=8` → ~1 KB instead of ~600 KB of full history) and
verified `price_jpy` is quoted **per 100 JPY** (cross-checked against
er-api: ratio 99.78 ≈ 100) — the divisor is applied at the parse boundary.

> Endpoint note: tgju's JSON API lives at
> `/v1/market/indicator/summary-table-data/{slug}`; the older
> `/v1/summary-table-data/{slug}` path returns 404.

Sanity rules: finite/positive values only; USD must sit inside plausible
absolute bounds; any move >30% vs a recent (<48h) cached value is rejected and
the previous value is kept. Failed refreshes keep serving the cache flagged
**stale**. Cache lives in `chrome.storage.local` under the `deko2_*` namespace.

## Live updates (v2.2+)

Rates are kept fresh **everywhere**, not just in the popup:

- `chrome.alarms` auto-refresh every **5 minutes**.
- Opening any page asks the service worker for rates with `fresh:'auto'` —
  if our last fetch ATTEMPT is older than 3 minutes a live pull starts
  immediately (the page still paints instantly from cache, then re-renders
  when fresh rates arrive). v2.5 measures the threshold by `lastAttempt`,
  not the source's own timestamp: arzdigital serves its index from a short
  server-side cache, so what matters is when WE last tried, and the popup
  status line ("بروزرسانی: همین الان") follows the same rule.
- v2.5 cheap passes (alarm / page-load kick) fetch **arzdigital only** —
  one ~110 KB (gzip) request refreshes ALL 16 currencies natively. tgju's
  12 parallel slug fetches run only on popup open / explicit refresh, to
  update the change-chips and sparklines; on cheap passes the last chips +
  sparklines are carried forward so the UI never loses data.
- Every successful refresh is **broadcast to all tabs**
  (`DEKO_RATES_UPDATED`); open pages wipe + re-render their badges only when
  the numbers really changed, and new badges pulse teal for a few seconds so
  you can see the update happening.
- Popup: full live refresh on open, silent auto-refresh every 60 s while
  open, animated count-up numbers, live source chips.

## DeKo AI assistant (v2.4) — ONE unified panel

The popup is a SINGLE unified panel (no tabs, like the top open-source
converter extensions): live USD hero + currency grid + the DeKo AI assistant
card embedded in the same flow + status + toggles.

- **DeKo AI** is a dedicated offline engine (`deko-ai.js`) that answers
  Persian/English currency questions from the LIVE rate cache:
  «۱۰۰ دلار چنده؟» · «۲۵ میلیون تومان چند یورو میشه؟» · «نرخ پوند؟» ·
  «روند دلار چطوره؟» · «هفته پیش ۱۰۰۰ دلار خریده بودم، الان؟» · «دلار یا یورو؟»
- Understands Persian/Arabic/Latin digits, ٫ decimals, ٬ thousands, number
  words («دو میلیون و پانصد هزار»), typos («تومن», «اورو», «دلاره»), and
  $ € £ ¥ symbols. Answers in Persian digits with ٬ / ٫ separators.
- Chat history persists locally (chrome.storage.local); never sent anywhere.
- **Optional real LLM:** in Options → "دستیار هوشمند DeKo AI" you can connect
  any OpenAI-compatible endpoint (e.g. OpenRouter). The chat then uses that
  model with DeKoAI.SYSTEM_PROMPT + the live rates injected; on any failure it
  silently falls back to the built-in engine. The API key stays in your browser.
- Quality gate: a seeded stress suite fires **exactly 10,000 generated
  questions** (conversions, reverse conversions, rates, trends, profit/loss,
  chit-chat, comparisons) — currently **10,000 / 10,000 correct**
  (`scripts/test_deko_ai_10k.js`).

## Persian numbers (v2.3)

- The **Vazirmatn** font (SIL OFL 1.1) ships inside the extension
  (`fonts/*.woff2`) and is used by the popup, options page AND the page
  badges (exposed via `web_accessible_resources`). No more ugly system-font
  Persian digits — crisp ۰-۹ with the standard ٬ thousands and ٫ decimal
  separators everywhere.
- Numbers are formatted with `Intl.NumberFormat('fa-IR')` — exactly what
  Iranian financial sites use.
- The popup shows a **daily change chip** (▲ green / ▼ red, from tgju's
  high/low class) and a **7-day sparkline** built from real closes for the
  dollar and every grid currency.

## Features

- Multi-currency: USD, EUR, GBP, AED, TRY, CNY, CAD, AUD, JPY, INR, CHF, RUB, SAR, NZD, KRW, SEK
- Symbols, codes and Persian words (`$ € £ ¥ ₹ ₺ 100 USD ۱۰۰ دلار`)
- Persian/Arabic digits, `1,299.99` / `1.299,99` / `1 299` formats, `k/M` and
  `هزار/میلیون/میلیارد` multipliers, ranges (`$10 - $20`, `از ۱۰ تا ۲۰ دلار`)
- Amazon split-price (`.a-price`) and generic symbol+number sibling splits
- Display modes: **append** (default) / **replace** / **tooltip-only**
- Persian or English digits; compact (`۳۰٫۸ میلیون`) or full number
- Popup **v2.3 (aurora pro, animated live)**: bundled **Vazirmatn** font +
  `fa-IR` number formatting, USD hero with **US flag chip**, **daily change
  chip (▲/▼)** and **7-day sparkline**, 6-currency grid with **twemoji flag
  chips, change chips and mini sparklines**, count-up number animations,
  staggered card entrance, aurora background, rotating conic hero border,
  floating flag, shimmer skeletons, sparkline draw-in animation, button
  ripples, toast notifications, value-flash on change, LTR source chips
  (tgju · rate-json · er-api), 60-second auto silent refresh with animated
  progress bar + countdown, `prefers-reduced-motion` respected
- Popup: master switch, per-site switch, stale warning, refresh-now button
- Options: display mode, digit style, compact, `$`/`¥` interpretation,
  manual rates + override, excluded sites
- SPA-safe: MutationObserver (300 ms debounce) + idle-time chunked scanning
- Dark-mode aware badge styling, RTL-isolated badges, `deko-` prefixed DOM

## Privacy

- No analytics, no accounts, no background tracking.
- The ONLY network calls are the three rate hosts above, made by the service
  worker. Your browsing history never leaves the browser.
- All rates are cached locally.

## Testing

Open `dev/test.html` in a browser (or load the extension and visit any page):
it contains a chrome-API shim, real-value fixtures (USD 253,700 / EUR 287,500,
cross-checked against tgju) and **33 assertions** — including the v1
regressions. Headless-Chromium result for this build: `ALL-PASS 33/33`.

Additional automated verification (real network, real extension load):

- background E2E **v2.5**: 22/22 — arzdigital anchors the cache, all 16
  currencies native, cache == independent live re-parse, dateModified
  freshness, JPY per-1 cross-check (<5%), cheap pass hits arzdigital ONLY,
  chips/history survive cheap passes, AR-down → tgju fallback, lastAttempt
  kick logic, 5-min alarm
- background E2E v2.3: 15/15 — 12 native tgju currencies, change % + history,
  broadcast, anti-churn, 5-min alarm
- popup UI: 19/19 + 17/17 — Vazirmatn loads, fa-IR digits, flags, chips,
  sparklines (now ending at the live value), count-up + flash, broadcast
  re-render, unified panel + DeKo AI
- content harness: 33/33 · DeKo AI stress: 10,000/10,000 questions
- real-extension E2E (`--load-extension`): badge renders with live arzdigital
  rate on a real http page with the bundled font loaded, real popup shows
  live USD ۲۵۸٬۷۰۰ (arzdigital), chips "arzdigital", status "همین الان

## Notes for developers

- `background.js` — provider chain, sanity checks, `chrome.alarms` **5-min**
  refresh, live tab broadcast, `DEKO_GET_RATES (fresh:'auto')` /
  `DEKO_REFRESH` messaging.
- `content.js` — detection engine. Persian UI strings are grouped at the top
  (`STR`) for future i18n.
- To add another provider: implement `providerX()` returning
  `{ per: {CUR: toman}, updatedAt, source }` and wire it into `refreshRates()`.
  Remember the unit: **everything is Toman** (1 Toman = 10 Rial).

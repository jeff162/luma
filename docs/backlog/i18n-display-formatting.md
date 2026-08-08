# Internationalization (display formatting)

**Status: partly landed 2026-08-08 — the currency half shipped; the date/number half has not.**
Tier 1 only — currency symbol + number/date *formatting*, not language translation. Tiers 2
(multi-currency) and 3 (translation) are explicitly out of scope here.

## What landed (2026-08-08), and where this file's plan was wrong

A **currency** setting shipped ahead of the rest of Tier 1, driven by a real need rather than the
speculative one this file was written against: a user with an all-AUD ledger, plus a connection-provider
bug that made the gap urgent (the SimpleFIN adapter compared account currencies against a hardcoded
`"USD"`, so a non-US user's entirely-correct accounts would have had every transaction discarded).

- The value lives in `services/ledger_currency.py`, read/written via `GET`/`PUT /api/currency`, surfaced
  as a **Currency** section in Settings. Provider adapters are *told* it per call (`ledger_currency` on
  `fetch_transactions_sync`); an account denominated differently has its rows dropped and reported.
  See `docs/data-model.md` → "the ledger holds one currency at a time".
- **The naming is deliberately narrow and expected to change.** It is called "Currency", not
  "Internationalization" or "Locale", because a section named for a category it does not yet cover
  promises settings that are not there. **Rename it when the date-format setting joins it** (decided with
  the user, 2026-08-08) — that is the moment the broader name starts being accurate.

Two things this file recommended that the implementation deliberately did **not** do:

- **Not `ui_preference`.** This file proposed the per-user preference infra. That is wrong for currency:
  `docs/data-model.md`'s dividing line puts per-user *chrome* in `ui_preference` and shared *data state*
  elsewhere, and the currency a ledger is denominated in is not a personal display choice — everyone in a
  workspace reads the same numbers, and a per-user copy would be orphaned by a restore into another
  profile. It lives in `import_workflow_state` (tenant-wide, carried by backups). **A date-format
  setting is the opposite case** and `ui_preference` is right for it: two people can legitimately prefer
  different date orders while looking at the same ledger. Do not "make them consistent" — they differ
  because the questions differ.
- **Not `Intl.NumberFormat(style: 'currency')`, yet.** Only the *symbol* is derived from `Intl`
  (`currencyDisplay: 'narrowSymbol'`, so an AUD ledger reads `$12.00` rather than `A$12.00`); the
  `en-US` grouping formatter is untouched. This file's recommendation to switch wholesale is still the
  right end state — it is what gets separators and symbol *placement* right (`1.234,56 €`) — but it
  changes the rendered string everywhere at once, so it belongs with the rest of Bucket A rather than
  riding a setting that only had to answer "which currency is this ledger in".

**Still open, in rough priority:** the `en-US` number formatter (separators/placement), the date-format
setting and `formatDate`/`monthLabel`, the ~9 raw ISO `{x.date}` renders, and all of Bucket B.

## Tier 1 — app-wide currency symbol + number/date format

**Context.** The app is hardwired to US display conventions: currency is a
literal `$` and an `Intl.NumberFormat('en-US', …)` in
[`moneyDisplay.js`](../../frontend/src/lib/moneyDisplay.js), and dates are a
hardcoded date-fns `'MMM d, yyyy'` in
[`utils.js`](../../frontend/src/lib/utils.js). The ask is *formatting* i18n —
currency symbol + decimal/thousands separators + date order — **not**
language translation. The intended shape is therefore a pair of explicit
**currency** and **date-format** settings (so the UI doesn't imply
translation it isn't doing), not a country/locale picker.

This is the cheap, high-value tier and is the realistic need for a
local-first personal-finance app. Deliberately *out of scope* here (recorded
so the boundary is clear):

- **Tier 2 — multi-currency** (a currency per account, mixed in one tenant).
  That's a data-model change (currency column on `account`, likely
  denormalized to `txn`, migrations, import mapping) plus the real problem:
  summaries/dashboard/trends all `SUM` amounts, and you can't meaningfully
  sum USD + EUR — so it needs either a one-currency-per-report rule or FX
  conversion (rates + as-of dates + a rate source). Don't fold this into
  Tier 1.
- **Tier 3 — language translation** (react-i18next + every UI string +
  ongoing translation upkeep). Fully separable; not part of this.

**Why deferred.** A feature nobody has asked for yet, and the formatting
work — while contained — isn't free. Tier 1 is worth doing as a unit when
someone actually wants non-US formatting; the bigger tiers should stay
gated behind real demand (a second-currency account; a non-English user).

**Where the setting lives.** Use the existing per-user/profile preference
infra (`ui_preference` + `useUserPreference` + `UserPreferencesContext`) —
the same model tag reports and panel geometry already use. One wrinkle: the
money/date helpers are module-level constants/functions today, so they need
to read the *active* setting rather than a baked-in constant. The four money
helpers (`formatMoneyMagnitude`, `formatSignedMoneyAmount`,
`formatTransactionAmount`, `formatSignedAxisTick`) already accept a
`currencySymbol` option and are the single chokepoint (~48 call sites funnel
through them), so the change concentrates there — feed them the active
currency/locale from context (or a set-once module config the preference
provider updates) instead of `MONEY_DISPLAY_CONFIG`'s defaults.

**The work splits cleanly into two buckets — keep them distinct.**

*Bucket A — display formatting (cosmetic; no correctness risk).*

- Currency: replace the `'$'` + `en-US` formatter with
  `Intl.NumberFormat(locale, { style: 'currency', currency })`. Prefer this
  over a bare symbol swap — it also gets decimal/thousands separators and
  symbol placement right (e.g. `1.234,56 €`), which swapping only the glyph
  would get wrong. The hand-rolled `k`-abbreviation in `formatSignedAxisTick`
  is the one spot that stays locale-naive and needs a small rethink.
- Dates: thread the chosen format into `formatDate`/`monthLabel` in
  `utils.js` (date-fns with a locale/format, or `Intl.DateTimeFormat`).
- **Audit beyond the central helpers.** A grep for `formatDate` *misses* a
  class of ~9 spots that render a raw `{x.date}` ISO string directly —
  clustered in the duplicate/import surfaces (`UnifiedDuplicatesDialog`,
  `ImportBatchDetail`, `DuplicateRowsDialog`, `TransactionDetail`, plus
  `Settings`/`Transactions`/`ImportExport`). These need routing through
  `formatDate` or they'll keep showing ISO after the user picks a format —
  exactly where "I set my format and half the app ignored it" bugs hide.

*Bucket B — human free-text input parsing (the only correctness risk).*

- The **Transactions quick filter** (`quick_filter`) is matched
  **server-side** in
  [`transactions.py`](../../backend/routers/transactions.py) (`_parse_quick_filter_date`,
  `_parse_quick_filter_year_month`, `_parse_quick_filter_amount`). Two
  locale-sensitive spots:
  - **Date order ambiguity** — the parser tries `%m/%d/%Y` *first*, so
    `02/01/2023` reads as Feb 1 (US), silently wrong for a DMY user who meant
    1 Feb. A format-string swap isn't enough; the *parse order* (MDY/DMY/YMD)
    must follow the chosen format. Keep ISO `%Y-%m-%d` always-accepted as the
    unambiguous fallback in every format, and document the rule for the
    ambiguous `01/02` case (follow the format order; ISO always works).
  - **Amount separators** — `_parse_quick_filter_amount` strips `,` as
    thousands and parses `.` as decimal; those roles flip in a `1.234,56`
    locale. Same input, wrong number. Needs locale-aware separator handling.
  - **Architectural note:** because this filter resolves in SQL, the locale
    has to reach the backend (pass it alongside `quick_filter`, or have the
    backend read the same stored preference). This is the one place Tier 1
    isn't purely frontend.
- **CSV amount parsing has the same separator hazard** (noted 2026-08-08, not
  previously recorded here). `import_export/core.py` and `amazon_import.py`
  both strip `$` and `,` unconditionally before parsing a number, so a `€`
  amount loses nothing but survives unrecognized, and a `1.234,56` amount
  parses as `1.234` — silently, as a hundredth of the real figure. The
  currency *setting* does not touch this: it says what the numbers mean, not
  how a file writes them. Note this is genuinely separate from the
  already-format-inferring **date** column parsing called out below; amounts
  get no such inference. Whether the fix is a locale-aware parser or a
  per-source amount-format option (alongside the existing amount-convention
  choice, which is where a user already answers questions of this shape) is
  undecided.

**What is *not* a hazard (verified, so it doesn't get over-engineered).**

- The **duplicate-resolution report's date drill-through** looks like a date
  filter but is safe: `UnifiedDuplicatesDialog` passes a row's *stored ISO*
  date (`matched.date` / `c.date`) as `dateStart`/`dateEnd` →
  `ImportBatchDetail` → backend `date_start`/`date_end` vs `t.date`. It's a
  machine-to-machine ISO round-trip with no human-format parsing, so it has
  **no ambiguity risk**. Its only Tier-1 touch is *display* — the raw ISO it
  renders (the matched-row dates and the `(filtered: 2023-02-01 …)` label)
  falls under Bucket A.
- The **FilterBar date range** is a picker whose stored value is ISO —
  locale-independent.
- **Import column date parsing** is a separate, already-format-inferring
  system — not part of this.

**Suggested order when picked up.**

- Add the currency + date-format preferences and the Settings controls.
- Bucket A first (cosmetic, low-risk): money helpers, then `utils.js`, then
  sweep the ~9 raw `{x.date}` renders.
- Bucket B second (correctness): thread the format to the backend, make the
  quick-filter date/amount parsers format-aware with ISO always accepted, and
  add tests for the ambiguous `01/02` and `1.234,56` cases.

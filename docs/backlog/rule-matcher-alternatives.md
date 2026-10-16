# Alternatives in a merchant matcher

**Not started.** Adds `any of these` to a rule's merchant matcher, so one rule can claim the several
descriptors one payee arrives under. Its purpose is to make the `display_name` fix below safe — see
*Sequencing*.

## The problem

A payee whose descriptor is unstable arrives as several strings: `NORTHGATE MKT`, `NRTHGT MARKET`,
`NORTHGATE #0412`. A matcher is an AND of `contains` clauses with no OR, so one rule cannot claim all
three. Today the only route is a side effect:

1. write one rule per variant, each renaming the row to a standard name;
2. write one more rule matching that standard name, carrying the category or `is_recurring`.

That works because `categorizer.rule_matches_row` builds its haystack from
`display_name + merchant_name + raw_name`, and `display_name` holds whatever a rule's `clean_name`
last wrote. So step 2's rule matches step 1's *output*.

Three things are wrong with it.

- **It is a feedback loop.** A row's matchable text changes after a rule runs, so a second
  categorization pass does not see what the first saw.
- **It is not reliable.** The standardized name competes with every other rule on `LENGTH(keyword)`,
  so an unrelated rule with a longer keyword can take the row from the rule the rename was for. This
  has already happened in a live ledger: rows renamed by a specific rule were categorized by a longer,
  generic descriptor rule instead.
- **It fans out.** N variants means N+1 rules that must be kept consistent by hand, which is the
  drift the Rules page's checkup partly surfaces.

How pervasive the loop is, measured rather than assumed: of the checkup's co-match findings on a live
ledger, two thirds were pairs that match *only* once a rename has been applied — no transaction matches
both rules on the text the importer delivered. Expect the checkup to look noisy until the
`display_name` fix lands, and read those findings as evidence of the loop rather than of rules that
need editing.

## The shape

A matcher becomes **a set of alternatives, then filters that every match must also satisfy**:

```
(alt₁ or alt₂ or alt₃) and filter₁ and filter₂
```

Chosen over the alternatives in *Rejected shapes* because it needs no mode flag: a rule written today
is exactly this form with an empty alternatives list, so every existing rule stays literally correct
and nothing has to be migrated semantically. It is two lists rather than an expression tree, and
because every branch carries the same filters, the specificity measure below is one minimum rather
than a walk over branches.

**The deliberate limit:** every alternative gets the same filters. "`alt₁` must also contain *delivery*
but `alt₂` need not" is not expressible, and should not be — those are different conditions and belong
in two rules.

## Canonical form and matcher identity

`_existing_rule_for_matcher` (`routers/rules`) keys a rule's identity on `keyword` + `match_expr` + the
full scope, so two spellings of one matcher must normalize to one form or a duplicate rule can be
created beside its twin.

- Alternatives are trimmed, lowercased, de-duplicated and **sorted**, as
  `normalize_match_clauses` already does for clauses. Order-independent, so sorting is the canonical
  form.
- **A single alternative folds into the filters.** `alternatives=[a], filters=[b]` and
  `alternatives=[], filters=[a,b]` are the same matcher. This mirrors `build_match_expr`'s existing
  rule that one clause stores no expr at all.
- Both lists empty is refused, as an empty matcher is refused today.
- `MAX_MATCH_CLAUSES` applies to each list.

### Storage

`match_expr` gains the alternatives beside the existing clauses rather than nesting them, so the
restriction is structural rather than a convention a later change could quietly break.

**Open: forward compatibility.** `match_expr_clause_texts` returns only `clauses`, so an older build
reading a rule written by a newer one would apply the filters and ignore the alternatives — matching
far more broadly rather than failing. That is a silent-break risk for the second install and for a
backup restored into an older build. Either version-mark the expr so an unknown shape makes the rule
refuse to fire, or accept the risk explicitly.

## Precedence

This is the part that cannot be deferred, because getting it wrong reorders rules silently.

`rule_specificity_order_sql` ranks on `LENGTH(keyword)`, where `keyword` for a multi-clause rule is the
canonical clause texts joined. For AND that is defensible — more and longer clauses mean a narrower
rule. **Under OR it inverts.** Extending `northgate` to `northgate` or `nrthgt` makes the rule match
*more* rows while lengthening the joined text, so it would sort as more specific, and would reorder
every rule around it.

A rule is as broad as its broadest alternative, so the ordering input is:

```
shortest alternative  +  all filters
```

`keyword` cannot carry that: it is also the LIKE-search target and what the UI displays, so it has to
hold every alternative. The ordering input therefore becomes a **stored column**, maintained on write,
with `rule_specificity_order_sql` reading it in place of `LENGTH(keyword)`.

**The property that makes this safe to land first:** for every rule that exists today the column equals
`LENGTH(keyword)` exactly, so the migration reorders nothing and can ship before any rule uses an
alternative. Compute it as the length of the same joined string the current code builds, with the
shortest alternative standing in for the alternative set, so the separator count matches and pure-AND
rules are bit-identical.

Per `docs/data-model.md` → *Schema evolution*, update `init_db` and register the `@migration(N)` that
backfills the column, bumping `CURRENT_VERSION`; register it last.

## Matching

`merchant_matcher_matches` gains one step before the existing clause loop: if the rule has
alternatives, at least one must be satisfied, by the same name-or-source-text test each clause already
uses. `_matcher_needles` keys its cache on `(keyword, match_expr)` and needs no change beyond
returning both lists.

## Rule checkup

`services/rule_overlaps.py` assumes a flat clause set in `_matcher_texts` and `_texts_nest`. Nesting
generalizes to: **X matches a subset of Y when Y's filters are covered by X's filters and every
alternative of Y is covered by some alternative of X.** Contained work, but it has to land with the
feature or the checkup will mis-report pairs involving an alternatives rule.

## UI

`RuleForm` already renders a repeating clause list with Add and a cap; this is a second list beside it,
not a new control and not an expression builder. `RuleSummary` renders a matcher as clause texts joined
by "and" and needs the "any of" group. The rule editor is already a large surface, so the addition
being one more list of the same kind is a constraint on the design, not an afterthought.

In-app help: *When two rules match the same transaction* describes the matcher and precedence, and
both change here.

## Sequencing

**This lands before the `display_name` fix, and that is the point of it.**

The fix is to drop `display_name` from `rule_matches_row`'s haystack, leaving `merchant_name`,
`raw_name` and the import evidence — matching the data as it arrives rather than data the app or the
user produced. Measured on a live ledger: `display_name` contributes text not already in
`merchant_name + raw_name` for 1 row in 9,707 import-sourced rows, against 761 of 1,866 rule-renamed
rows. It is almost purely a feedback path.

Taken on its own it would remove the only route to one-series-many-descriptors. With alternatives in
place, nothing needs the rename loop and the fix costs no capability.

Before that fix: dry-run it over the whole ledger and count every row whose winning rule changes and
every series whose membership changes. A rule-backed series' membership *is* its rule's matches
(`data-model.md` → *Rule-backed series*), so a matcher change moves series members as well as
categories.

## Rejected shapes

- **A builder on the recurring screen** that writes the N rename rules together. The rules still exist
  separately and still drift; it is narrower than the problem, since variant descriptors are not only a
  recurring concern; and it splits rule authoring across two surfaces.
- **A per-rule toggle between the incoming name and the ledger name**, with ledger-name rules applied
  in a second pass. It legitimizes the loop instead of removing it, and still needs N rename rules to
  produce the ledger name, so the fan-out and the drift both survive. For that it adds a phase to the
  engine, an axis to every rule, and a phase concept to the checkup.
- **An all-of / any-of toggle on one clause list.** Strictly less expressive than two lists — it cannot
  say "any of these *and* also this" — while being the more complex data model, because an existing
  rule's meaning would then depend on a flag.
- **General nesting** (`A and (B or C) and (D or E)`). The natural generalization, left out: it needs an
  expression-tree UI, makes specificity a walk over branches instead of one minimum, and the case that
  motivated this does not need it.

## Open

- Forward compatibility of `match_expr`, above.
- The stored column's name, and whether it belongs beside `keyword` or with the rule-hygiene columns.
- Whether alternatives should be offered to *Generate rules*, which currently proposes one rule per
  distinct name and is where variant descriptors first become visible.

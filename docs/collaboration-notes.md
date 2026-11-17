# Collaboration Notes

The principles that decide implementation choices across the app, and the reason behind each. Working
habits and tooling footguns are in [`agent-profile.md`](agent-profile.md); UI conventions are in
[`ui-patterns.md`](ui-patterns.md).

## Decision-Making Principles

**Calibrate care to blast radius.** How much process a decision gets (how hard to verify it, whether to
ask first, how much to surface before committing) scales with how reversible it is, how likely a wrong
result is to be noticed, and how costly it would be to undo. Cheap, reversible and visible: act, and say
what you did. Irreversible, hard to observe or expensive to unwind: prefer the design that is easier to
unwind where two are otherwise equal, surface the decision before committing, and verify to the point
of proof. A result merely consistent with success is not proof, and neither is a check never seen to
fail.

**The dial governs process, never quality.** Reversibility is a reason to ask and verify less, never to
accept a worse change. A local patch is often easy to undo *because* it does not integrate, which is
what makes it the wrong change. A correct fix that is large or crosses subsystems is a reason to surface
its scope, not to prefer the shallow one.

**Low observability is the default.** Most code here is not reviewed line by line, and UI or backend
defects are unlikely to be caught by reading. Review is not the backstop, so prove the behavior and flag
the non-obvious choices.

**Proof is a test where a test can judge the result, and the user where none can.** For UI behavior, a
headless spec run with `npm run ui:test*` or `npm run ui:smoke` is the proof path. Whether a screen
*looks* right goes to the user, with what to click and what correct looks like.

**A term with an everyday meaning and a narrower in-app one signals which is in force**, unless it
plainly reads as a term of art, because the reader arrives with the everyday sense. "Each account
belongs to at most one owner" is true of the `owner` table and false of people; "at most one of the
defined owners" is a claim about configuration. A login identity is a **user**, or a **member** where
the household is meant: never an "account", which is a bank account, and never a "profile", which on
the import side is a saved data source.

**A connection says which kind it is wherever nothing around it does.** A *provider connection* is the
app's link to a data provider (Plaid's app secret, a SimpleFIN bridge credential); an *account connection*
is one link through it to an institution (a Plaid bank login). Inside a provider's card "connection" alone
is clear. Elsewhere (help, the vault and restore results, docs) name the kind, because the two are created,
owned and replaced differently.

- **Prefer explicit user choice over hidden inference when a decision changes meaning.** A single strong
  match may be offered as a suggested default, visibly a suggestion; real ambiguity is left to the user.
- **Favor workflows that are understandable and reversible**: it should be possible to see what
  happened and back out of it without cleanup work.
- **Accept small asymmetries** when two workflows serve genuinely different intents.
- **Add defensive complexity only for a clear payoff.** Recovery for unusual or corrupt states can be
  noted without being built.
- **Do not carry runtime code that fixes up old data that does not matter**, because nothing ever says
  it is no longer needed. Where the old data matters, a one-time migration runs once and is done. Where
  carrying code is still right, give it an expiry (a version, a date or both) and remove it then.
- **When refusing an action is right, explain it in the app** rather than renaming or repairing
  silently.
- **A rule that applies across entry points is validated in the backend.**

## Working on the Code

- **Get it right the first time.** The bar is first-class code, not something that works and is
  iterated toward correct. If the right shape is not clear, investigate until it is.
- **Do a short design pass before changing a workflow** that touches generated state, persisted review
  state, rules, imports, categorization, or undo and return paths. Name every affected surface, then
  state the lifecycle in plain language: each state, what owns the rows, what owns any created rule,
  and what happens when the criteria are broadened or narrowed or the flow is backed out. If that cannot
  be stated crisply, keep investigating or ask before writing code.
- **Surface a semantic choice rather than working around it.** If a limitation would make an action
  mean less, more or something other than its label says, do not silently narrow, broaden or reroute
  it. A conservative interim behavior is named in the summary as a product decision, with the
  alternative left out.
- **Record a policy choice that reasonable people would make differently, with its alternatives.** Write
  down each option weighed and its case beside the rule in force, and keep the decision in one function
  whose inputs would serve the alternatives too, so a later reversal is a contained change rather than a
  hunt through every caller. *Rules and hand edits* in `data-model.md` is the model; no flag or plug-in
  framework is built until a second policy is actually wanted.
- **Treat an agreed decision as a pattern.** Extend it to the analogous paths where it obviously applies
  and is low-risk, and name those extensions in the summary so they can be confirmed or scoped back.
- **Do not bend a shared component to fix one page.** A new prop, overflow tweak or style override that
  exists only so one caller looks right means the approach is wrong. Extend the component deliberately
  with a clear contract, or solve it at the page level.
- **Add a lint rule by measuring it first.** Enable it as a warning, read the hits, fix the real ones
  that are cheap, and tune its options for false positives rather than restructuring correct code. Make
  it an error only once the existing hits are cleared, so it becomes a regression gate. Leave a noisy or
  low-value rule off, with a one-line comment saying why. A raw count can mislead: read what the hits
  are before judging the rule.

## Code Structure Preferences

- **Share what is meant to behave the same**, especially selectors, dialogs, mapping controls and other
  interaction-heavy UI. Page-specific state stays on the page.
- **Do not refactor purely for abstraction.** Shared code earns its place by reducing drift, repeated
  fixes or inconsistent behavior.
- **Merge duplicated code at the third copy, and weigh divergence risk.** Two copies may still need to
  diverge, and a forced abstraction that leaks is worse than the duplication it replaced.
- **Build efficiency in where it is also the simpler design**, because the version that avoids
  redundant work usually has fewer moving parts. When efficiency would add complexity for a payoff that
  cannot yet be measured, defer it and note it. Measure before restructuring for performance.

## Testing

- **Test by value**: recurrence-prone bugs, invariants and contracts, tricky conditions and
  cross-component interactions, not every one-off fix.
- **Weigh value and cost separately, and keep the two costs apart.** Build cost is paid once, and a
  valuable property justifies it however awkward the instrumentation; difficulty observing a property is
  not evidence it is unimportant. Run cost recurs on every suite run, so that is the one to be stingy
  about.
- **Structure does not substitute for a test** of a property whose violation would be silent. A test
  worth writing exercises what it claims: a fixture smaller than the behavior under test only catches the
  shapes that were inserted.
- **Round-trip, serialization, backup and migration tests need complete fixtures**: every relevant table
  and field, and the awkward shapes (self-referential and forward-reference foreign keys, nullable-but-set
  keys, merged rows), or a fixture built by driving the real creation flows. Assert the full result.
  `backend/tests/test_import_duplicate_detection.py` and `backend/tests/test_backup_restore.py` are the
  references.
- **Add a guard that fails on omission wherever one is possible**, such as deriving the table list from
  `sqlite_master` and asserting every table is in the backup payload.
- **Some properties are out of a unit runner's reach, so a green run says nothing about them.** jsdom
  does no layout, so chart geometry produces nothing to assert: two of the worst chart bugs here had
  every tooltip figure correct. A virtualized list renders only with stubbed geometry, keyed by row
  index so no row reports the viewport's height. An adapter's window cap, sign convention, pacing and
  budget are properties of the request, so the test inspects what was sent (`building-a-connector.md`).
- **Console warnings and how a component fits into the live app are only visible in a browser.** Keep
  the console clean so a new error stands out; React warnings usually mark a real bug. A first pass
  against the real app has repeatedly found several placement and wiring bugs in an hour, so it is
  required work, not a formality.

## Naming And Brand Hygiene

- **UI copy, comments and docstrings name no real product, company or bank** as flavor; use generic
  wording ("most banks"). An integration the code actually talks to is the exception, since there the
  name is the technical fact (Plaid).
- **Test data may use large, well-established vendors** (Amazon, Starbucks, Netflix). It avoids PII and
  niche or personal vendors: a local business, a government office tied to a real place, a product that
  mirrors the user's own accounts. Use generic names ("Rewards Card", "Cashback Card", "Legacy Card")
  and describe the scenario's shape rather than the real products.
- **`data/` holds the user's real data.** Read it to understand shapes, and never copy any of it into a
  tracked file; reproduce the shape with fabricated values.

## What belongs here

An entry earns its place when it decides an implementation choice on more than one task. Each is the
principle and its short reason.

What does not belong: a UI convention (`ui-patterns.md`), a working habit or tooling footgun
(`agent-profile.md`), a fact about one component or feature (a comment at that site, or the topic doc
that owns the feature), how to run the suites (`CONTRIBUTING.md`), or the story of how a principle was
arrived at.

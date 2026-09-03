# Import Source Field Registry — remaining work

**Status: the registry and both features built on it have shipped.** Captured import-source detail is
surfaced on the origin hover card and in the transaction detail's Origin block, and a rule can opt in to
matching it (`match_source_text`). What is described here is the unstarted remainder only; the shipped
model lives in `data-model.md` (`import_evidence_json`, and the rule action list) and `ui-patterns.md`
(the origin hover card, and the registry as the single seam).

## The seam this builds on

One declarative registry (`frontend/src/lib/importSourceFields.js`) resolves each import-source field
from either a first-class `txn` column or a path into `import_evidence_json`, tagged with a scope
(`name` / `text` / `meta`) that says which surfaces show it. It is dynamic-aware: the evidence's
`extra_text_fields` bag expands into rows labelled with the source file's own header, so a
source-specific column appears without being hardcoded, and a resolver that finds nothing drops its row.

## Remaining

- **Selectable report columns.** Offer registry fields as user-selectable transaction-report columns,
  reusing `useColumnPreference` and the pill-header table shell. Listed since the registry was designed;
  never committed to, and the case for it is weak enough that it may never be worth building — the
  origin hover already answers "what did the file say about this row?" without spending table width.
- **Structured rule matchers.** The shipped form is "the keyword appears anywhere in the source text".
  A structured `(field, op, value)` matcher — target one named field, choose the operator — was designed
  and deferred. It is the more precise tool and the more expensive one: it needs matcher identity to
  carry the field and operator, a UI for building the clause, and a story for a field that a given
  source does not have.

## Constraints these inherit

- **No new capture.** Both items work strictly with the fields already inventoried in `data-model.md`;
  widening what is captured is a separate decision with its own footprint cost.
- **The categorizer's perf contract governs anything touching the hot loop**
  (`backend/tests/test_categorizer_perf_contract.py`). The shipped source-text match stays cheap by
  gating the per-row evidence parse on the rule set actually containing a source-text rule; a structured
  matcher has to preserve that property rather than parse evidence for every row.
- **The registry is the single seam.** A feature consumes it rather than re-parsing evidence, which is
  what keeps one definition of "what fields does this row have" across the hover, the detail panel and
  the rule editor.

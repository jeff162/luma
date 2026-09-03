# Shared button audit & consolidation

**Deferred, design-system task.** Survey the button styles across the app and settle on a single shared
set (sizes + variants) that meets every need, then migrate the bespoke one-offs onto it. Not a quick
global tweak — spot-checking showed many existing buttons already look fine, so a blind resize of the
shared component would regress as much as it fixes.

## Why now / trigger

Came up while building the recurring-transactions page: the shared `Button` felt too large, but on
inspection the real issue is **drift** — there are already several divergent button treatments, and the
perceived "too large" is driven more by *fill weight and shadow* than by pixel size.

## Findings (so the next pass doesn't re-derive them)

- **Shared `Button`** (`frontend/src/components/ui.jsx`): default `fontSize 14 / padding 9×16`,
  `small` `13 / 6×12`, `borderRadius 8`. The **`ghost` variant carries a heavy drop shadow**
  (`0 8px 18px rgba(0,0,0,0.10)`) that reads "raised/heavy." Used **~192 times across 36 files**
  (~93 `ghost`, ~95 primary — most via the no-variant default, 4 `danger`). Variant styles are spread
  *after* a passed `style`, so per-instance overrides of `color`/`boxShadow` silently lose — a reason
  bespoke styles proliferated.
- **Bespoke divergences already in the wild:**
  - `pages/Rules.jsx` header buttons (`primaryHeaderButtonStyle` / `quietHeaderButtonStyle`): a **soft
    accent-tinted** primary (not solid), `fontSize 12 / padding 5×12`, flat. Reads clean/right-sized.
  - `pages/Recurring.jsx` `CardActionButton` (local, flat, `12 / 4×11`, **solid** primary) + a toned,
    shadow-free `NotRecurringSplit`. Introduced during the recurring work; the recurring page currently
    keeps these local buttons rather than the shared `Button`.
- **Key insight:** the Rules soft-12px button and the recurring solid-12px button have near-identical
  metrics but look very different — **solid vs. soft-tint fill** (and the ghost's drop shadow) drive the
  perception far more than font/padding. So the audit's central decision is *treatment*, not just size.
- **`disabled` was cosmetic until 2026-09-03, and is now real.** The shared `Button` dimmed the control
  and dropped its `onClick`/`onMouseDown`, but never set the DOM `disabled` attribute — so a button that
  looked unavailable stayed focusable, announced as enabled to a screen reader, and would still submit a
  form it sat in. Found while working on reimbursable expenses and fixed there; noted here because it is
  a property of the shared component rather than of that feature. The consequence for this audit is that
  a disabled `Button` now takes the browser's own disabled behaviour as well as the dimming, which is
  worth checking against whatever treatment the pass settles on.

## Open decisions for the task

- Primary buttons **solid** (bold accent fill) vs **soft-tinted** (outline + tint, like the Rules
  header) as the app default — likely the biggest lever.
- Whether to **flatten the `ghost` drop shadow** app-wide (93 buttons).
- Target size(s) — a single size, or keep a default/`small` hierarchy (~12–13px felt right).
- Reconcile the bespoke styles onto the shared set: `Rules.jsx` header buttons and the recurring
  `CardActionButton` / `NotRecurringSplit` should fold back into the shared `Button` once it's defined,
  so there's one implementation.

Until this is done, the recurring page deliberately carries its own toned buttons — that's the intended
look to generalize, and the divergence gets folded in here.

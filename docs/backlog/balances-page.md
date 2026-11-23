# Balances page: an arranged account table

## What it is

The account table in the Dashboard's Balances frame (`components/BalancesView.jsx`), arranged by hand:
accounts in a chosen order, a type allowed to appear in more than one section, sections collapsible, and
accounts or sections hidden. The two everyday checking accounts can sit on top, then the cards, then the
wallets, with the other checking accounts and savings below.

**Where it stands:** ready to build. No decisions owed.

## The arrangement is layout only

Arranging the table changes how it is laid out and nothing else. The charts keep one group per account
type however the table is split: a bridge step and a Trends series are still one type, and two checking
sections in the table are still one Checking bar.

In the table, each section is a unit of layout: it collapses on its own, and its subtotal is its own
accounts'. There is then no single figure for a split type in the table; the charts carry it.

## What is saved

One arrangement per user covering every account, as a user preference (`useUserPreference`): a list of
sections, each with an id, its type, its accounts in order, and whether it is collapsed, and the set of
hidden accounts. The owner filters only leave rows out.

The id gives a section a stable identity, so its collapsed state does not depend on which account happens
to head it. Whatever the table looks like when edit mode is left is what is saved.

The sections are kept to a few rules, so the saved list always describes a table that can be drawn:

- **An account dropped among its own type's rows** joins that section.
- **An account dropped among another type's rows** splits that section and starts one of its own type
  there, with a new id. The upper part of the split section keeps its id and state; the lower part takes
  a new id, open.
- **Two sections of one type that end up adjacent** merge, keeping the upper one's id and state, so two
  identical headings never sit one after the other.
- **A section left with no accounts** is removed.
- **A new account** lands at the end of the last section of its type, usually the "everything else" one,
  or in a new section at the end when its type has none.
- **Default:** one section per type in the order of `BALANCE_TYPES` (`lib/balanceTotals.js`), accounts by
  name within a type, which is the table as it is now.

## Behaviour

- **Hide works on an account or a section** (a section hides each of its accounts). Hidden is not listed;
  it still counts in the totals, unlike `exclude_from_balance_totals`, and the copy keeps the two apart. A
  hidden account comes back when it moved in what is shown: the bridge's period on Single period, the
  shown months on Trends. A "N hidden · show" line at the table's foot reveals the rest.
- **Edit mode from a gear on the table card**: drag handles on accounts and headings (a heading drags its
  section), an eye on each account and heading. Edit mode shows every section open.
- **Applies to the table in both modes.** A heading click drills into the whole type, even when the type
  is split, and the drilled table keeps the arranged order.
- **Colours stay the type's**, so a repeated heading has its bar's swatch.

## Obstacles

- **Every drag goes through `lib/pointerDrag.js`** (`ui-patterns.md` → *Dragging*), since the page is
  used on an iPad.
- **The Change column does not add down.** It is drawn as an arrow and an amount in each type's own
  direction (`describeBalanceChange`), so a section's subtotal is meaningful only because a section is one
  type; a section must never span two types.

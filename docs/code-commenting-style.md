# Code Commenting Style

This project uses a **system-level commenting style**. Comments should
help a reader understand *why the code exists* and *how to think about
it*, not restate what it does.

The underlying concern is that low-value comments create noise without
preserving the reasoning that actually prevents regressions. Luma
changes fastest around workflows, invariants, and shared UI behavior, so
comments need to capture the mental model behind those systems rather
than narrate obvious code.

---

## Contents

* [Core Principles](#core-principles)
* [Two Levels of Comments](#two-levels-of-comments)
* [Backend vs Frontend Guidance](#backend-vs-frontend-guidance)
* [When to Add Comments](#when-to-add-comments)
* [When NOT to Add Comments](#when-not-to-add-comments)
* [Style Guidelines](#style-guidelines)
* [Placement Rules](#placement-rules)
* [Examples](#examples)
* [Summary](#summary)

---

## Core Principles

* Comments explain **intent and design**, not implementation details
* Focus on **why**, not **what**
* Prefer **a few high-value comments** over many low-value ones
* Treat comments as a way to expose the **mental model** behind the code

---

## Two Levels of Comments

### 1. System-Level Comments (Most Important)

Use these when a file contains a **non-obvious conceptual model**, such as:

* a state model or state machine
* coordinated behavior across multiple functions or effects
* ordering, selection, or drag/drop systems
* persistence or synchronization logic
* business rules or invariants

**Guidelines:**

* Add **one comment per system**, not per function
* Place it at the **entry point of the system**, such as:

  * top of a component
  * above a key function
  * above an initialization `useEffect`
* Use short bullet points to describe:

  * what the system governs
  * key invariants or guarantees
  * important constraints

**Goal:**

> A reader should understand the system without reverse-engineering multiple functions.

This style favors system entry points because that is where a future
maintainer decides whether a change is safe. If the reasoning is only
implicit in several helper functions, the code is much easier to
accidentally "simplify" into a regression.

---

### 2. Local Comments (Use Sparingly)

Use these only when necessary, for:

* tricky or non-obvious logic
* workarounds or edge cases
* subtle interactions with APIs or UI behavior

**Guidelines:**

* Place directly above the relevant code
* Keep them short and specific
* Only include when the reasoning is not obvious

---

## Backend vs Frontend Guidance

This style applies to both frontend and backend code, but the focus differs:

### Frontend

System-level comments should explain:

* interaction models and UI behavior
* coordination between components, state, and effects
* user-facing workflows (e.g. drag/drop, selection, editing)
* persistence and synchronization with backend

Avoid commenting JSX structure or obvious rendering logic.

### Backend

System-level comments should explain:

* API contracts and differences between endpoints
* data semantics (e.g. how values are interpreted or normalized)
* invariants, constraints, and ordering rules
* filtering and aggregation logic that is not obvious from the query alone
* interactions between UI behavior and backend logic

Avoid commenting simple CRUD operations or obvious queries unless they enforce non-obvious rules.

In both cases, prioritize explaining **why the system behaves this way**, not how the code is written.

---

## When to Add Comments

Add a comment if:

* multiple parts of the file work together to implement a behavior
* there is an implicit model that is not immediately visible
* a future reader would ask "why is this done this way?"
* changing the code without understanding context could introduce bugs

---

## When NOT to Add Comments

Do **not**:

* restate what the code is doing
* comment obvious or self-explanatory logic
* add structural comments like:

  * "Render"
  * "Header"
  * "Row 1"
* add comments to every function or block
* use comments as filler

If unsure whether a comment adds value, **skip it**.

---

## Style Guidelines

* Prefer short bullet-point comments over paragraphs
* Keep wording direct and high-signal
* Avoid redundancy across comments
* Do not duplicate the same explanation in multiple places

---

## Placement Rules

* Place system-level comments at **system entry points**, not inside every function
* Avoid scattering related explanations across multiple locations
* Keep comments close to the code they explain, but not buried in it

---

## Examples

### Good (System-Level)

```js
// Drag-and-drop model:
// - Groups are ordered within sections (income/expense)
// - Categories are ordered within parent groups
// - Moves persist immediately via sort_order updates
// - Cross-group moves update both source and destination lists
```

---

### Good (Local)

```js
// Some picker close events fire before the popover is visible;
// ignore those to avoid canceling edit mode immediately.
```

---

### Bad

```js
// Loop through items
for (const item of items)
```

```js
// Set loading to true
setLoading(true)
```

---

## Summary

* Comment **systems, not lines**
* Explain **intent, not mechanics**
* Use **one comment per conceptual model**
* Keep comments **minimal but meaningful**

When done correctly, the codebase should feel **self-explanatory**,
with comments acting as guideposts rather than narration.

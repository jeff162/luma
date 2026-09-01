// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Enter-key behaviour for small, explicit-submit forms.
//
// Here rather than per dialog because this is the third place to want it — the sign-in screen has carried
// its own copy since the beginning, and a fourth divergent version is how "Enter works on some passphrase
// fields" happens. The rule the callers implement with it is the sign-in screen's: **Enter advances
// through the fields and submits from the last one**, so a multi-field prompt is completable from the
// keyboard without Tab, and a single-field one (the vault unlock) submits immediately.
//
// Note what is deliberately *not* offered: a "submit from anywhere" variant. These dialogs are guarded by
// their own validity checks and the caller passes the same guarded action its button calls, so an Enter
// that fires an action the button would refuse is not possible — but an Enter that fires a *destructive*
// action still is, and that is a judgement each caller has to make rather than inherit. The vault reset's
// typed confirmation is the worked example: it exists to make an irreversible action deliberate, so it
// takes no Enter handler at all.

export function onEnter(action) {
  return event => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    action()
  }
}

export function advanceOnEnter(ref) {
  return onEnter(() => ref.current?.focus())
}

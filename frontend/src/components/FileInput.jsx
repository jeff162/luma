// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef } from 'react'
import { canOpenWithPicker, openFiles } from '../lib/filePicker.js'

/*
 * A file input that reopens in the folder last used for its purpose (`pickerId`, one of `PICKER_IDS` in
 * `lib/filePicker.js`).
 *
 * It is still a real `<input type="file">`, taking the same props and reporting through the same `onChange`,
 * so a caller only swaps the tag. A click on it — the user's, or a caller's `ref.current.click()` from a
 * button of its own — opens the per-purpose picker instead of the browser's, and the files chosen there are
 * put into the input and announced with a `change` event, exactly as a choice in the plain dialog would be.
 * Where the browser has no such picker the click goes through and nothing differs from a plain input.
 * Drops and `setInputFiles` never click, so they are untouched.
 */
export default function FileInput({ pickerId, onClick, ref, ...props }) {
  // Set for the one click that falls through to the browser's own dialog after the picker failed.
  const passThrough = useRef(false)

  async function pick(input) {
    let files
    try {
      files = await openFiles({ id: pickerId, accept: props.accept, multiple: props.multiple })
    } catch {
      // A picker that refuses (rather than being cancelled) leaves the browser's dialog to do the job.
      passThrough.current = true
      input.click()
      return
    }
    if (!files?.length) return
    const transfer = new DataTransfer()
    for (const file of files) transfer.items.add(file)
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  return (
    <input
      {...props}
      ref={ref}
      type="file"
      onClick={e => {
        onClick?.(e)
        if (passThrough.current) { passThrough.current = false; return }
        if (e.defaultPrevented || !pickerId || !canOpenWithPicker()) return
        e.preventDefault()
        pick(e.currentTarget)
      }}
    />
  )
}

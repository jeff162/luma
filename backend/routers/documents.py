# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Attached documents — the API over the receipt/invoice store.

Four operations over one noun: list what a transaction carries, attach a file, fetch the bytes back,
and detach one. The store itself (`services/documents.py`) owns every decision about bytes — where a
file lives, how an upload is normalized, the write order that makes a crash survivable — so this
module is deliberately thin: it turns HTTP into those calls and back.

**The ingestion seam is format-agnostic on purpose.** A receipt arrives as a phone photo, a PDF the
garage emailed, a screenshot, or an image pasted out of a mail client. Every one of those paths is a
multipart upload of *(bytes, media type, filename)* by the time it reaches here, so there is one attach
endpoint rather than one per source, and adding a new way to pick a file never touches the backend.
Clipboard paste in particular is the entire "email your receipts in" story — no mailbox polling, no
receiving address, nothing that would put mail credentials in the vault.

**Serving bytes is where the care goes.** The file is served from disk with the media type recorded at
ingest, never one derived from the request, and with headers that stop a stored file from being treated
as active content by the browser. See `_document_response`.
"""

from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from backend.db.database import get_db
from backend.services.documents import (
    MAX_DOCUMENT_BYTES,
    DocumentRejected,
    attach_document,
    delete_document,
    delete_document_file,
    document_file_path,
    find_duplicate_attachment,
    list_documents,
    prepare_document,
)

router = APIRouter()


def _require_transaction(conn, txn_id: str) -> None:
    """A document hangs off a transaction, so an unknown one is a 404 rather than a foreign-key error.

    Trashed transactions are deliberately *not* excluded: the trash is the reversible stage, a trashed
    row is still viewable, and refusing to show its paperwork would make the documents look lost at the
    exact moment someone is deciding whether to restore it.
    """
    if not conn.execute("SELECT 1 FROM txn WHERE id = ?", (txn_id,)).fetchone():
        raise HTTPException(status_code=404, detail="No such transaction")


@router.get("/transaction/{txn_id}")
def list_transaction_documents(txn_id: str):
    with get_db() as conn:
        _require_transaction(conn, txn_id)
        return {"documents": list_documents(conn, txn_id)}


@router.post("/transaction/{txn_id}")
async def attach_transaction_document(
    txn_id: str,
    file: UploadFile = File(...),
    # A pasted image arrives with no filename of its own; the client names it something meaningful
    # rather than letting every paste land as "blob".
    filename: str | None = Form(None),
):
    """Attach one file to a transaction.

    The upload is read whole rather than spooled, which is the one place this feature deliberately does
    *not* stream: the per-file cap is ~25 MB, the bytes have to be resident anyway to be hashed and
    (for an image) re-encoded, and the alternative — a temp file to re-read twice — costs more than it
    saves at that size. The cap is enforced against what arrived, before anything decodes it, so a
    pathological upload is turned away without being handed to an image library.

    **An identical file already attached is reported, not stored twice.** Dropping the same receipt
    twice is ordinary behavior when nothing visibly happened fast enough, and the result would be two
    entries a person then has to tell apart by nothing at all. The response says which document it
    already is, so the UI can say so rather than raise an error about a file that is entirely correct.
    """
    payload = await file.read(MAX_DOCUMENT_BYTES + 1)
    try:
        prepared = prepare_document(payload, filename or file.filename, file.content_type)
    except DocumentRejected as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    with get_db() as conn:
        _require_transaction(conn, txn_id)
        existing = find_duplicate_attachment(conn, txn_id, prepared.sha256)
        if existing:
            return {"document": existing, "already_attached": True}
        return {"document": attach_document(conn, txn_id, prepared), "already_attached": False}


@router.get("/{document_id}/file")
def get_document_file(document_id: str, download: bool = False):
    """Serve a document's bytes — inline for the viewer, as a download when asked.

    `download` is what separates "show me this receipt" from "give me the file": the viewer renders it
    in place, while the download uses the original filename, which is the only thing that name is ever
    used for. It never reaches the filesystem — the store is keyed by id precisely so a user-supplied
    name is not path input.
    """
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, filename, mime_type FROM document WHERE id = ?", (document_id,)
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="No such document")
    path = document_file_path(row["id"])
    if not path.is_file():
        # The row exists and the file does not — the drift the file-first write order allows, and which
        # a restore reports rather than hides. Said plainly, because "your receipt is gone" and "the
        # server broke" call for different reactions from the person reading it.
        raise HTTPException(status_code=404, detail="This document's file is missing from the store.")
    return _document_response(path, row, download)


def _document_response(path, row, download: bool) -> FileResponse:
    """The response for stored bytes, with the headers a file store has to send.

    The media type is the one recorded at ingest from the file's own header — never guessed from the
    request or the filename — so a document is always served as what it actually is.

    `X-Content-Type-Options: nosniff` matters more here than anywhere else in the app: this is the one
    endpoint that returns bytes a user supplied, and without it a browser is free to disregard the
    declared type and re-interpret the content as something executable. `Content-Security-Policy:
    sandbox` is the second half of the same argument — a PDF viewer is a scripting host, and a stored
    document has no business running script against this origin.
    """
    disposition = "attachment" if download else "inline"
    return FileResponse(
        path,
        media_type=row["mime_type"],
        headers={
            "Content-Disposition": f'{disposition}; filename="{_ascii_filename(row["filename"])}"',
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'",
        },
    )


def _ascii_filename(filename: str) -> str:
    """A filename safe to put in a header value.

    Quotes and control characters would let a name break out of the quoted string and inject a header;
    non-ASCII is dropped rather than encoded because this is the fallback name a download is offered
    under, not a value anything parses back.
    """
    cleaned = "".join(ch for ch in (filename or "") if ch.isprintable() and ch not in '"\\' and ord(ch) < 128)
    return cleaned.strip() or "document"


@router.delete("/{document_id}")
def detach_document(document_id: str):
    """Detach a document: remove the row, then the file.

    Deliberately the reverse of ingest's order. Whichever half sits outside the transaction should be
    the one whose failure leaves *litter* rather than a dangling reference — on the way in that means
    the file first, and on the way out it means the row first. The file is unlinked only after the
    transaction commits, so a rolled-back delete cannot cost the bytes.
    """
    with get_db() as conn:
        if not delete_document(conn, document_id):
            raise HTTPException(status_code=404, detail="No such document")
    delete_document_file(document_id)
    return {"ok": True}

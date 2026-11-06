# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Attached documents — the API over the receipt/invoice store.

Operations over one noun: list what a transaction carries, attach a file, fetch the bytes back, rename,
move a document between a transaction and the stored set, and delete one. **Stored** documents — those
with no transaction yet — are the same rows with `txn_id` NULL, so everything but listing and attaching
treats the two alike. The store itself (`services/documents.py`) owns every decision about bytes — where a
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

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.db.database import get_db
from backend.services import database_health
from backend.services.restore_state import require_no_pending_restore
from backend.services.documents import (
    MAX_DOCUMENT_BYTES,
    DocumentMove,
    DocumentRejected,
    attach_document,
    delete_document,
    delete_document_file,
    document_file_path,
    find_duplicate_attachment,
    list_documents,
    list_stored_documents,
    move_document,
    prepare_document,
    rename_document,
    replace_document_text,
)

router = APIRouter()


class DocumentText(BaseModel):
    text: str


class DocumentName(BaseModel):
    filename: str


class DocumentTarget(BaseModel):
    txn_id: str


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


@router.get("/stored")
def list_stored():
    """The documents waiting for a transaction — an invoice kept before its charge has been imported."""
    with get_db() as conn:
        return {"documents": list_stored_documents(conn)}


@router.post("/stored")
async def store_document(file: UploadFile = File(...)):
    """Keep a document that has no transaction yet. The same ingest as attaching, including the duplicate
    check, which here asks whether the file is already among the stored ones."""
    prepared = await _prepare_upload(file)
    with get_db() as conn:
        require_no_pending_restore(conn, "adding a document")
        existing = find_duplicate_attachment(conn, None, prepared.sha256)
        if existing:
            return {"document": existing, "already_stored": True}
        return {"document": attach_document(conn, None, prepared), "already_stored": False}


async def _prepare_upload(file: UploadFile):
    """Read and normalize an upload. The name is the file's own: a client with a better one (a paste, which
    arrives as "image.png" or "blob") names the file it sends rather than passing a second field."""
    payload = await file.read(MAX_DOCUMENT_BYTES + 1)
    try:
        return prepare_document(payload, file.filename, file.content_type)
    except DocumentRejected as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/transaction/{txn_id}")
async def attach_transaction_document(txn_id: str, file: UploadFile = File(...)):
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
    prepared = await _prepare_upload(file)
    with get_db() as conn:
        require_no_pending_restore(conn, "adding a document")
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
    # Opened before answering, because the response's headers go out before its body is read: a file that
    # is there but cannot be opened would otherwise end as a dropped connection behind a 200, which a
    # viewer shows as a blank. Typically its owner is left over from data moved across from another user.
    try:
        with open(path, "rb"):
            pass
    except OSError as exc:
        user = database_health.server_user()
        raise HTTPException(status_code=500, detail={
            "code": "document_unreadable",
            "message": f"The server cannot read this document's file ({exc.strerror or exc}). It has to be "
                       f"readable by '{f'{user}' if user else ''}' on the server.",
        })
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


@router.put("/{document_id}/text")
def edit_document_text(document_id: str, body: DocumentText):
    """Edit a text document, which replaces it: the response is the document now in its place, under a
    new id (see `replace_document_text` for why). The old file goes only once the swap has committed."""
    with get_db() as conn:
        require_no_pending_restore(conn, "editing a document")
        try:
            document = replace_document_text(conn, document_id, body.text)
        except DocumentRejected as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if document is None:
            raise HTTPException(status_code=404, detail="No such document")
    delete_document_file(document_id)
    return {"document": document}


@router.patch("/{document_id}")
def rename(document_id: str, body: DocumentName):
    with get_db() as conn:
        try:
            document = rename_document(conn, document_id, body.filename)
        except DocumentRejected as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    if document is None:
        raise HTTPException(status_code=404, detail="No such document")
    return {"document": document}


@router.post("/{document_id}/attach")
def attach_stored_document(document_id: str, body: DocumentTarget):
    """Attach a stored document to a transaction.

    Only a *stored* document can be attached this way: moving one straight from one transaction to another
    is not something any surface offers, and refusing it keeps a mistaken request from quietly taking a
    receipt off the row it belongs to. The response says `already_attached` when the transaction already
    carried an identical file, in which case the stored copy is folded into it (see `move_document`).
    """
    with get_db() as conn:
        _require_transaction(conn, body.txn_id)
        current = conn.execute("SELECT txn_id FROM document WHERE id = ?", (document_id,)).fetchone()
        if current is None:
            raise HTTPException(status_code=404, detail="No such document")
        if current["txn_id"] is not None and current["txn_id"] != body.txn_id:
            raise HTTPException(status_code=409, detail="That document is attached to another transaction.")
        move = move_document(conn, document_id, body.txn_id)
    return _move_response(move, "already_attached")


@router.post("/{document_id}/detach")
def detach_document(document_id: str):
    """Take a document off its transaction and keep it among the stored ones — the undoable way to remove
    one, for a receipt attached to the wrong row. `already_stored` when an identical file was already
    stored, which the detached copy is folded into."""
    with get_db() as conn:
        move = move_document(conn, document_id, None)
    if move is None:
        raise HTTPException(status_code=404, detail="No such document")
    return _move_response(move, "already_stored")


def _move_response(move: DocumentMove, merged_key: str) -> dict:
    # The folded copy's row went with the transaction; its file goes only now that it has committed, for
    # the reason `delete_document_permanently` gives.
    if move.merged_id:
        delete_document_file(move.merged_id)
    return {"document": move.document, merged_key: bool(move.merged_id)}


@router.delete("/{document_id}")
def delete_document_permanently(document_id: str):
    """Delete a document, attached or stored: remove the row, then the file.

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

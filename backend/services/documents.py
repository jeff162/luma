# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The document store — receipts and invoices attached to a transaction, or stored until theirs arrives.

A transaction records that money moved and where it went; it does not record *what was bought*. A
document is the missing half for the rows where that matters (a repair bill, a service invoice, a
warranty-relevant purchase), and this module owns the bytes: where they live, how an upload is
normalized before it lands, and how a file is written so a torn write can never be mistaken for a
complete one.

**A document may be waiting for its transaction.** An invoice often arrives before the charge it
describes has been imported, so a document with `txn_id` NULL is *stored*: kept, viewable and backed up,
and attached later by setting `txn_id`. Nothing about the bytes differs between the two states, which is
why storing is a column value rather than a second store — attaching never moves a file.

**Files on disk, not blobs in the database.** The backup payload is JSON, so a blob would have to be
base64'd into it — a third larger, and a receipt that has to be held whole in memory to be encoded.
Files on disk keep bytes out of the JSON entirely, which is what lets a backup copy them straight
between disk and zip member with a fixed buffer, at any size. They ride the *data* backup as
additional members, because a document is transaction detail rather than a credential.

**The write order is the invariant.** File first, then the row: a file with no row is inert litter that
a sweep can reclaim, while a row with no file is a broken link on screen. The two cannot be one
transaction, so the ordering is what decides which failure mode a crash produces. Each file is written
to a temporary name and `os.replace()`d into place — atomic within a volume on both platforms — so a
half-written file is never visible under its real name.

**The digest is not bookkeeping.** `document.sha256` is what lets a restore tell a complete file from a
torn one and resume its documents phase, what makes a backup's integrity check cover the files rather
than only the JSON, and the natural key for noticing the same receipt was attached twice.

**Ingest is deliberately lossy for photographs.** A receipt shot at 12 MP is ~4 MB and carries nothing
above roughly 300 DPI at text size that any reader or extractor can use, so oversized images are
downscaled once, at ingest, and the original is not kept. PDFs pass through untouched: re-rendering one
needs far more machinery, and a digital invoice is small anyway with a text layer worth preserving
exactly.

**A document is a file, a photo, or text.** Text is a first-class kind rather than only something
extracted *from* a document: a receipt forwarded by email is most naturally pasted, and the design
treats that paste as the whole of the email story (no mailbox, no credentials). Its `text_source` is
`verbatim`, which is deliberately not an extraction tier — nothing was interpreted, so a later pass must
never treat it as weaker output to be improved on.

**Text extraction is tiered, and only the free tier is here.** A PDF's own text layer is exact, local
and costs nothing, so it runs at ingest for every PDF. OCR for photographs and line-item extraction
are separate tiers with real costs (a system binary; a per-call API key) and are deliberately absent —
`text_source` records which tier produced what is stored, so a document extracted by a weaker tier
stays identifiable when a better one arrives.

See `docs/data-model.md` -> Attached documents for the invariants and the reasoning behind each -- the
write order, the digest, why ingest is lossy for photographs and lossless for PDFs, and why the per-file
cap is generous rather than rationing.
"""

from __future__ import annotations

import hashlib
import io
import os
import re
import sqlite3
import tempfile
import time
import uuid
from dataclasses import dataclass
from email import policy as email_policy
from email.parser import BytesParser
from html.parser import HTMLParser
from pathlib import Path
from typing import Optional

from PIL import Image, ImageOps, UnidentifiedImageError
from pypdf import PdfReader

from backend.app_logging import log_warning
from backend.db.database import current_db_path
from backend.time_utils import utcnow_iso

# The directory documents live in, relative to the data database. Named once here because the backup
# and the restore sweep both have to agree with ingest about where a file is.
DOCUMENTS_DIR_NAME = "documents"

# A generous per-file ceiling rather than a ration. It exists to stop pathology — a 40 MB flatbed scan
# of a one-page invoice — not to make the user economize, because a cap that rejects is a dead end for
# someone photographing a receipt with the phone they own. Images rarely reach it: they are downscaled
# below, which is why this mostly bites scanned PDFs.
MAX_DOCUMENT_BYTES = 25 * 1024 * 1024

# Long edge an oversized image is reduced to, and the quality it is re-encoded at. ~1600px at q80 turns
# a ~4 MB phone photo into ~300 KB while staying legible and staying above what OCR can use (which gains
# nothing past roughly 300 DPI at text size).
IMAGE_LONG_EDGE_PX = 1600
IMAGE_JPEG_QUALITY = 80

# Below this an image is stored as delivered. Re-encoding a small image spends CPU and a generation of
# quality to save bytes that were never the problem — and screenshots, which arrive small and carry
# crisp text, are exactly the case JPEG treats worst.
IMAGE_PASSTHROUGH_BYTES = 1024 * 1024

# What may be attached. The set is deliberately short: these are the forms a receipt actually arrives
# in, and every one is something the viewer can render. Text is here because a receipt forwarded by
# email is pasted rather than saved first — see the module docstring.
PDF_MIME_TYPE = "application/pdf"
TEXT_MIME_TYPE = "text/plain"
HTML_MIME_TYPE = "text/html"
# An exported email. Accepted as an *upload* but never stored as one — see `_email_to_document`,
# which converts it at ingest, so nothing downstream has to know this format exists.
EMAIL_MIME_TYPE = "message/rfc822"
# Each stored image type, with the one Pillow decoder that may open it. Opening with only that decoder
# keeps a file from reaching Pillow's other parsers by what its bytes claim, which is where most of its
# security fixes have landed.
IMAGE_DECODERS = {
    "image/jpeg": "JPEG",
    "image/png": "PNG",
    "image/webp": "WEBP",
    "image/gif": "GIF",
    "image/tiff": "TIFF",
    "image/bmp": "BMP",
}
IMAGE_MIME_TYPES = frozenset(IMAGE_DECODERS)
SUPPORTED_MIME_TYPES = frozenset({PDF_MIME_TYPE, TEXT_MIME_TYPE, HTML_MIME_TYPE}) | IMAGE_MIME_TYPES
# What an upload may *arrive* as, which is one wider than what may be stored.
ACCEPTED_UPLOAD_MIME_TYPES = SUPPORTED_MIME_TYPES | {EMAIL_MIME_TYPE}

# Leading bytes that identify a format regardless of what the upload claimed. The declared content type
# comes from the browser (or from a paste, where it may be absent entirely), so it is a hint; the file's
# own header is what decides. Ordered longest-first is unnecessary here — no prefix is a prefix of
# another — but the table stays explicit rather than deriving the type from the filename extension,
# which the user can rename to anything.
_MAGIC_PREFIXES = (
    (b"%PDF-", PDF_MIME_TYPE),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"BM", "image/bmp"),
    (b"II*\x00", "image/tiff"),
    (b"MM\x00*", "image/tiff"),
)

# Buffer for moving bytes between a file and a digest. Matches the backup's own chunk size for the same
# reason: big enough that a large document is not a syscall storm, small enough to be the whole of the
# memory held at once.
CHUNK_BYTES = 1 << 20

# How recently a file must have been written to be spared by an incremental sweep. It covers the gap
# between an ingest writing the file and committing its row — milliseconds in practice, but a gap in
# which the file is legitimately unreferenced and must not be mistaken for litter.
INGEST_GRACE_SECONDS = 60.0


class DocumentRejected(Exception):
    """An upload that cannot become a document — too large, empty, or a format not accepted.

    Raised rather than returned because every caller's answer is the same: tell the user why, and
    store nothing. The router translates it into a 400 with this message, which is written to be read
    by the person who dropped the file.
    """


@dataclass(frozen=True)
class PreparedDocument:
    """An upload normalized into exactly what the store and the `document` row need.

    `data` is what actually gets written, which is not necessarily what arrived: an oversized image has
    already been downscaled by the time this exists. `byte_size` and `sha256` therefore describe the
    stored bytes, never the upload — they are what a restore compares a file against, so they have to
    match what is on disk.
    """

    data: bytes
    filename: str
    mime_type: str
    byte_size: int
    sha256: str


def documents_dir() -> Path:
    """Where documents are kept: a `documents/` directory beside the data database.

    Derived from the database's own path rather than from `DATA_DIR` directly, so the two always agree.
    `DATA_DIR` anchors both databases and is the normal way this is set, but `DB_PATH` overrides it for
    the data database alone — an install carrying databases named before a rename does exactly that —
    and documents belong with the ledger that references them, not with whatever directory the
    environment happened to name. It is also what gives each test its own store for free, since tests
    point the database at a temporary directory.
    """
    return Path(current_db_path()).parent / DOCUMENTS_DIR_NAME


def document_file_path(document_id: str) -> Path:
    """The stored file for a document id.

    Flat and extensionless, keyed by id alone: the layout matches the backup's `documents/<id>` members
    one-for-one, and the original filename and media type stay on the row, where they are display and
    `Content-Type` rather than filesystem trust.

    **The id is validated here rather than trusted.** Ids this app mints are UUIDs and could not escape
    the directory, but not every id reaching this function was minted here: a *restore* takes them from
    the archive's `document` rows, and a backup is a file that may have come from somewhere else — the
    app already treats one as possibly foreign. An id of `../../something` would otherwise turn a restore
    into an arbitrary file write. Validating at this choke point covers every caller at once, which is
    the reason it lives here and not in the restore.
    """
    if not is_safe_document_id(document_id):
        raise ValueError(f"unsafe document id: {document_id!r}")
    return documents_dir() / document_id


def is_safe_document_id(document_id) -> bool:
    """Whether an id may be used as a filename: a non-empty plain name, no separators, no dot entries.

    Deliberately a shape test rather than a UUID test. The ids in use are UUIDs, but the property that
    matters is only that the value stays inside the directory, and an id format that widens later should
    not have to come back here.
    """
    if not isinstance(document_id, str) or not document_id or len(document_id) > 255:
        return False
    if document_id in (".", ".."):
        return False
    return not any(sep in document_id for sep in ("/", "\\", "\0"))


def new_document_id() -> str:
    return str(uuid.uuid4())


def _looks_like_text(data: bytes) -> bool:
    """Whether these bytes are plain text.

    Text is the one accepted format with no magic number, so it is identified by *decoding* rather than
    by a signature — which is the honest test anyway: a thing is text if it reads as text. A NUL byte
    rules it out immediately, because no plain text contains one and every binary format this might be
    confused with does.
    """
    if b"\x00" in data:
        return False
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


# Headers that only a real message carries, and which a pasted receipt or a stray text file will not.
# Matched at the very start, where RFC 5322 requires the header block to be — a message quoted *inside*
# a text file has them indented or prefixed, and must stay a text file.
_EMAIL_HEADER_PREFIXES = (
    b"Received:", b"Return-Path:", b"Delivered-To:", b"Message-ID:", b"MIME-Version:",
    b"From:", b"Date:", b"Subject:", b"To:", b"X-",
)


def _looks_like_email(data: bytes) -> bool:
    """Whether these bytes are an exported email.

    `.eml` has no signature, so this reads the first line for a header a message must have. It requires
    a *header* rather than merely accepting the declared type because browsers are inconsistent about
    what they call an `.eml` — `message/rfc822` on some, `application/octet-stream` or nothing at all on
    others — and a format identified only by what the upload claimed is not identified.
    """
    head = data[:128].lstrip()
    if not any(head.startswith(prefix) for prefix in _EMAIL_HEADER_PREFIXES):
        return False
    # A header line is `Name: value`, so the colon has to arrive before any whitespace does. This is
    # what keeps a text file that merely opens with the word "From" from being read as a message.
    line = head.split(b"\n", 1)[0]
    colon = line.find(b":")
    return colon > 0 and b" " not in line[:colon]


def _email_to_document(data: bytes, filename: Optional[str]) -> tuple[bytes, str, str]:
    """Turn an exported email into the document it contains: `(bytes, media type, filename)`.

    **Converted at ingest rather than stored as a message.** No browser renders `.eml`, so keeping the
    original would mean a document that could never be viewed — and the seam this feature is built on is
    that every path produces *(bytes, mime type, filename)* and nothing downstream knows where they came
    from. Taking the message apart here is what keeps that true.

    The HTML part is preferred over the plain one for the same reason a rich paste is: it carries the
    table the sender laid out, where the plain alternative is that table flattened. Inline `cid:` images
    will not render — the sandbox CSP blocks every subresource, which is also what stops an email's
    tracking pixels firing — so an image-heavy receipt arrives with gaps. That is a real limitation and
    the honest trade for not fetching anything an email points at.

    The **subject** becomes the filename, because an exported message is often named opaquely by whatever
    produced it while the subject is the thing a person would recognize a year later.
    """
    try:
        message = BytesParser(policy=email_policy.default).parsebytes(data)
        body = message.get_body(preferencelist=("html", "plain"))
        content = body.get_content() if body is not None else None
    except Exception:
        content = None
    if not content or not content.strip():
        raise DocumentRejected("That email has no readable message body to attach.")

    is_html = body.get_content_type() == HTML_MIME_TYPE
    subject = ""
    try:
        subject = str(message.get("Subject") or "").strip()
    except Exception:
        subject = ""
    stem = _safe_filename(subject) if subject else _safe_filename(filename).rsplit(".", 1)[0]
    return (
        content.encode("utf-8"),
        HTML_MIME_TYPE if is_html else TEXT_MIME_TYPE,
        f"{stem or 'Email'}.{'html' if is_html else 'txt'}",
    )


def _sniff_mime_type(data: bytes, declared: Optional[str]) -> Optional[str]:
    """The media type to record, decided from the bytes and falling back to what the upload claimed.

    The header wins because the declared type is unreliable in both directions: a clipboard paste may
    carry none at all, and a browser will happily label a file from its extension. A declared type is
    still worth keeping for the formats with no usable magic number (WebP is RIFF-framed, so its marker
    sits at offset 8), which is why this falls through rather than rejecting outright.

    **Text is checked last, and only when it was claimed.** Decoding as UTF-8 is a weak signal — plenty
    of binary files happen to decode — so it is used to *confirm* a text upload rather than to classify
    an unknown one. Anything genuinely unidentifiable stays unidentified and is refused, which is the
    right outcome: this is a receipt store, not a general file dump.
    """
    for prefix, mime_type in _MAGIC_PREFIXES:
        if data.startswith(prefix):
            return mime_type
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if _looks_like_email(data):
        return EMAIL_MIME_TYPE
    declared = (declared or "").split(";")[0].strip().lower()
    if declared in (TEXT_MIME_TYPE, HTML_MIME_TYPE):
        return declared if _looks_like_text(data) else None
    if declared.startswith("text/"):
        return TEXT_MIME_TYPE if _looks_like_text(data) else None
    return declared or None


def _safe_filename(filename: Optional[str]) -> str:
    """The upload's name reduced to something safe to store and show.

    Path components are stripped rather than escaped: the name is never used to locate the file (the id
    is), so nothing is lost by discarding directories, and keeping them would leave a value that *looks*
    like a path to anything that later treats it as one.
    """
    name = (filename or "").replace("\\", "/").split("/")[-1].strip()
    return name[:255] or "document"


def _downscale_image(data: bytes, mime_type: str) -> tuple[bytes, str]:
    """Reduce an oversized image once, at ingest, returning the bytes to store and their media type.

    Three rules, each answering a case where the obvious version of this is wrong:

    - **Orientation is applied before anything else.** A phone photo is usually stored unrotated with
      an EXIF orientation tag, and re-encoding drops EXIF — so a naive resize saves an image that
      viewers no longer know to turn, and the receipt lands sideways.
    - **An image with transparency stays PNG.** Flattening alpha onto a background is not a quality
      trade, it changes the picture, and a screenshot with a transparent margin is a plausible receipt.
    - **A result larger than the input is discarded.** Small already-optimized images exist, and
      "downscaling" one into something bigger is pure loss.

    A file Pillow cannot read is returned untouched rather than refused: it passed the format check
    above, so the honest failure is a document that was stored as delivered, not a rejected receipt.
    """
    try:
        with Image.open(io.BytesIO(data), formats=[IMAGE_DECODERS[mime_type]]) as image:
            image = ImageOps.exif_transpose(image)
            has_alpha = image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info
            if max(image.size) > IMAGE_LONG_EDGE_PX:
                image.thumbnail((IMAGE_LONG_EDGE_PX, IMAGE_LONG_EDGE_PX), Image.LANCZOS)
            buffer = io.BytesIO()
            if has_alpha:
                image.save(buffer, format="PNG", optimize=True)
                out_type = "image/png"
            else:
                image.convert("RGB").save(buffer, format="JPEG", quality=IMAGE_JPEG_QUALITY, optimize=True)
                out_type = "image/jpeg"
    except (UnidentifiedImageError, OSError, ValueError):
        return data, mime_type

    reduced = buffer.getvalue()
    return (reduced, out_type) if len(reduced) < len(data) else (data, mime_type)


def prepare_document(data: bytes, filename: Optional[str], declared_mime_type: Optional[str]) -> PreparedDocument:
    """Validate and normalize an upload into the bytes that will be stored.

    The order matters: the cap is checked against what *arrived*, before any re-encoding, so a
    pathological upload is turned away without being decoded — an image bomb must not be handed to
    Pillow to find out how big it is.
    """
    if not data:
        raise DocumentRejected("That file is empty.")
    if len(data) > MAX_DOCUMENT_BYTES:
        limit_mb = MAX_DOCUMENT_BYTES // (1024 * 1024)
        raise DocumentRejected(f"That file is larger than the {limit_mb} MB limit for an attached document.")

    mime_type = _sniff_mime_type(data, declared_mime_type)
    if mime_type not in ACCEPTED_UPLOAD_MIME_TYPES:
        raise DocumentRejected("A document has to be a PDF, an image, text, an HTML file, or an exported email.")
    if mime_type == EMAIL_MIME_TYPE:
        # Becomes the document it carries, so everything below this line sees an ordinary HTML or text
        # upload and no later stage needs to know an email was involved.
        data, mime_type, filename = _email_to_document(data, filename)

    if mime_type in IMAGE_MIME_TYPES and len(data) > IMAGE_PASSTHROUGH_BYTES:
        data, mime_type = _downscale_image(data, mime_type)
    # PDFs and text pass through byte-for-byte: there is nothing to gain by rewriting either, and for
    # text the stored bytes are what the person actually pasted.

    return PreparedDocument(
        data=data,
        filename=_safe_filename(filename),
        mime_type=mime_type,
        byte_size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
    )


# Provenance stamped on `document.text_source`, naming the tier that produced the text. Recorded rather
# than inferred from the media type because the tiers are not interchangeable in reliability — a PDF's
# own text layer is exact, OCR is a guess — and anything reading the text later (a search result's
# confidence, a decision to re-extract when a better tier becomes available) needs to know which it got.
TEXT_SOURCE_PDF_LAYER = "pdf_text"
# The document *is* text — pasted out of a mail client, most often. Nothing was extracted and nothing
# was interpreted, which is why this is a distinct value rather than reusing an extraction tier: it is
# the most trustworthy text the store can hold, and a later re-extraction pass must never treat it as a
# weaker tier's output to be improved upon.
TEXT_SOURCE_VERBATIM = "verbatim"
# The document is HTML — a receipt copied out of an email, which keeps the table the mail client drew.
# Its searchable text is the markup with the tags taken out: derived, but from the document's own words
# rather than from interpreting a picture of them, so it sits with the PDF text layer in reliability.
TEXT_SOURCE_HTML_TEXT = "html_text"

# Below this, a PDF's "text layer" is treated as absent rather than empty. A scanned invoice run through
# a PDF wrapper commonly yields a handful of stray characters from page furniture, and calling that
# extraction would mean recording a document as searched when nothing searchable was found — which is
# the state that later has to be told apart from a real extraction to know whether OCR is worth offering.
MIN_MEANINGFUL_TEXT_CHARS = 16

# A ceiling on stored text. Receipts are short; a pathological PDF is not, and the text column feeds a
# search index rather than a reader, so there is nothing to gain from keeping a novel. Truncation is
# silent because the alternative — refusing the document — would lose the file over its text.
MAX_EXTRACTED_TEXT_CHARS = 200_000


def extract_text(data: bytes, mime_type: str) -> tuple[Optional[str], Optional[str]]:
    """Pull whatever text a document carries, returning `(text, text_source)`.

    **Tier 1 only: a PDF's own text layer.** A digital invoice — the emailed garage bill, most utility
    and service invoices — already carries real text, so this is exact rather than interpreted, needs no
    network call and no configuration, and covers the whole class of documents that arrive as PDFs.
    Photographs return `(None, None)`: reading those is OCR, which is a declared capability behind a
    system binary and deliberately not part of this tier.

    `(None, None)` is a real answer, not a failure. It means *no text was obtained*, which is distinct
    from a document whose text is genuinely empty, and it is what tells a later pass that this document
    is a candidate for a tier that does not exist yet. A PDF this cannot parse returns it too: a
    document whose text could not be read is still a perfectly good document, and refusing the
    attachment over it would trade the file for its index entry.
    """
    if mime_type == HTML_MIME_TYPE:
        text = _collapse_whitespace(html_to_text(data.decode("utf-8", errors="replace")))
        return (text[:MAX_EXTRACTED_TEXT_CHARS] or None), (TEXT_SOURCE_HTML_TEXT if text else None)
    if mime_type == TEXT_MIME_TYPE:
        # No extraction step: the bytes are the text. Decoded leniently because this has already been
        # confirmed as text and a stray undecodable byte is not worth losing a receipt over.
        text = _collapse_whitespace(data.decode("utf-8", errors="replace"))
        return (text[:MAX_EXTRACTED_TEXT_CHARS] or None), (TEXT_SOURCE_VERBATIM if text else None)
    if mime_type != PDF_MIME_TYPE:
        return None, None
    try:
        reader = PdfReader(io.BytesIO(data))
        pages = [page.extract_text() or "" for page in reader.pages]
    except Exception:
        # Deliberately broad: pypdf raises a wide and version-dependent range on malformed files, and
        # every one of them means the same thing here — no text layer could be read.
        return None, None

    text = _collapse_whitespace("\n".join(pages))
    if len(text) < MIN_MEANINGFUL_TEXT_CHARS:
        return None, None
    return text[:MAX_EXTRACTED_TEXT_CHARS], TEXT_SOURCE_PDF_LAYER


class _HtmlTextExtractor(HTMLParser):
    """Markup in, text out, with a receipt's rows still reading as rows — enough to index, not to re-render.

    What it has to get right and a naive tag-strip does not:

    - **Script and style bodies are text to a parser but not to a reader**, so their content is dropped; a
      receipt whose search hits were all CSS selectors would be worse than one with no text at all.
    - **Whitespace in the markup is not layout.** Source newlines collapse to spaces, as a browser treats
      them, and only elements produce line breaks (except inside `<pre>`, where the text *is* the layout).
    - **A table row is one line, cells tab-separated.** That is what keeps an amount beside the item it
      prices, and it has to hold against how receipts are actually written: the item name sits in a
      `<div>` *inside* its cell, so a cell's content is gathered on its own and only its edges are
      trimmed. Breaks inside a cell survive (a work order's notes stay on their lines, with the price on
      the last), while the block wrapped around a lone item name no longer splits its row in two.
    - **Cells close themselves.** HTML lets `</td>` and `</tr>` go unwritten, so a cell also ends at the
      next cell or row *of its own table*. Each open cell records the table depth it was opened at, which is
      what stops an inner row from closing the outer cell a whole itemized table sits in — email is laid
      out in tables, so the receipt is usually exactly such a cell.
    """

    _SKIP = {"script", "style", "head", "title"}
    _BREAK = {"br", "p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "thead", "tbody", "tfoot"}
    _CELL = {"td", "th"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        # The document's text, then one buffer per open cell, innermost last.
        self._buffers: list[list[str]] = [[]]
        self._cell_depths: list[int] = []
        self._table_depth = 0
        self._skipping = 0
        self._preformatted = 0

    def _emit(self, text: str) -> None:
        self._buffers[-1].append(text)

    def _close_cells(self, depth: int) -> None:
        while self._cell_depths and self._cell_depths[-1] >= depth:
            self._cell_depths.pop()
            content = "".join(self._buffers.pop()).strip()
            if content:
                self._emit("\t" + content)

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skipping += 1
        elif tag == "table":
            self._table_depth += 1
            self._emit("\n")
        elif tag == "tr":
            self._close_cells(self._table_depth)
            self._emit("\n")
        elif tag in self._CELL:
            self._close_cells(self._table_depth)
            self._cell_depths.append(self._table_depth)
            self._buffers.append([])
        elif tag == "pre":
            self._preformatted += 1
            self._emit("\n")
        elif tag in self._BREAK:
            self._emit("\n")

    def handle_endtag(self, tag):
        if tag in self._SKIP:
            self._skipping = max(0, self._skipping - 1)
        elif tag in self._CELL:
            self._close_cells(self._table_depth)
        elif tag in ("tr", "table"):
            self._close_cells(self._table_depth)
            if tag == "table":
                self._table_depth = max(0, self._table_depth - 1)
            self._emit("\n")
        elif tag == "pre":
            self._preformatted = max(0, self._preformatted - 1)
            self._emit("\n")
        elif tag in self._BREAK:
            self._emit("\n")

    def handle_data(self, data):
        if self._skipping:
            return
        self._emit(data if self._preformatted else re.sub(r"\s+", " ", data))

    def text(self) -> str:
        self._close_cells(0)
        return "".join(self._buffers[0])


def html_to_text(markup: str) -> str:
    """The text inside HTML markup, rows on their own lines with tab-separated cells and whitespace left
    untidied. Parser-based rather than a regex over angle brackets, which is wrong on attributes, comments
    and entities alike — and this runs on markup from an email, so it meets every malformed shape a mail
    client can produce."""
    parser = _HtmlTextExtractor()
    try:
        parser.feed(markup)
        parser.close()
    except Exception:
        # Deliberately broad: a document whose text cannot be read is still a perfectly good document,
        # and losing the attachment over unparseable markup would trade the file for its index entry.
        return parser.text()
    return parser.text()


def _collapse_whitespace(text: str) -> str:
    """Normalize extracted text to single-spaced lines with no blank runs.

    PDF extraction emits the page's *layout* — column padding, and a blank line per visual gap — which
    is noise to a search index and inflates what gets stored. The line structure is kept because it is
    what makes an itemized invoice readable when the text is shown back to someone.
    """
    lines = [" ".join(line.split()) for line in text.splitlines()]
    return "\n".join(line for line in lines if line).strip()


def write_document_file(document_id: str, data: bytes) -> None:
    """Write a document's bytes into the store, atomically.

    Temporary name then `os.replace()`, so the file is either absent or complete under its real name —
    never a truncated file that a later digest check would have to catch. The temporary lands in the
    documents directory rather than the system temp directory so the replace stays within one volume,
    which is what makes it atomic.
    """
    target = document_file_path(document_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, staged = tempfile.mkstemp(dir=str(target.parent), prefix=".incoming-")
    try:
        with os.fdopen(handle, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(staged, target)
    except BaseException:
        Path(staged).unlink(missing_ok=True)
        raise


def copy_document_file_from(document_id: str, source) -> str:
    """Stream a document into the store from an open binary source, returning its digest.

    The restore's counterpart to `write_document_file`: a document arrives as a zip member that may be
    any size, so it is copied with a fixed buffer and digested on the way past rather than read whole.
    The digest is returned rather than checked here — the caller holds the ledger's expected value, and
    what it does about a mismatch (report it, keep the ledger) is its decision, not the store's.
    """
    target = document_file_path(document_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    handle, staged = tempfile.mkstemp(dir=str(target.parent), prefix=".incoming-")
    try:
        with os.fdopen(handle, "wb") as out:
            while True:
                chunk = source.read(CHUNK_BYTES)
                if not chunk:
                    break
                digest.update(chunk)
                out.write(chunk)
            out.flush()
            os.fsync(out.fileno())
        os.replace(staged, target)
    except BaseException:
        Path(staged).unlink(missing_ok=True)
        raise
    return digest.hexdigest()


def file_digest(path: Path) -> Optional[str]:
    """The sha256 of a stored file, or None if it is not there. Read in chunks, since this runs over
    every document during a restore sweep and one of them may be large."""
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as handle:
            while True:
                chunk = handle.read(CHUNK_BYTES)
                if not chunk:
                    break
                digest.update(chunk)
    except FileNotFoundError:
        return None
    return digest.hexdigest()


def delete_document_file(document_id: str) -> bool:
    """Remove a document's file, returning whether it is gone. Absent is success: the row is what says a
    document exists, and a delete that has to reconcile with a file already gone is the ordinary
    consequence of the file-first write order.

    Every caller runs this after the row's removal has committed, so a file that cannot be removed now
    is left as litter for the next sweep rather than raised: Windows refuses to delete a file any handle
    holds open, such as a viewer still reading it, and raising would report a completed delete as a
    server error."""
    try:
        document_file_path(document_id).unlink(missing_ok=True)
    except PermissionError as exc:
        log_warning(f"[documents] left {document_id} for the next sweep: {exc}")
        return False
    return True


def stored_document_ids() -> set[str]:
    """Every document id with a file in the store.

    Dot-prefixed entries are skipped: an interrupted write leaves a `.incoming-` temporary, and it is
    not a document — treating one as an id would make the sweep below delete a file that a concurrent
    ingest is still writing.
    """
    directory = documents_dir()
    if not directory.is_dir():
        return set()
    return {
        entry.name
        for entry in directory.iterdir()
        if entry.is_file() and not entry.name.startswith(".")
    }


def sweep_unreferenced_files(conn: sqlite3.Connection, min_age_seconds: float = 0.0) -> list[str]:
    """Delete stored files the ledger no longer references, returning the ids removed.

    This is the destructive half of everything that removes documents — a purged transaction, a cleared
    demo dataset, a restore replacing the ledger — deliberately expressed as *derive it from the current
    ledger* rather than as a delete beside each row. Two reasons: the file-first write order means litter
    is a normal outcome that something has to reclaim anyway, and a restore that is interrupted must
    leave inert extra files rather than having already deleted originals it cannot get back.

    `min_age_seconds` is what keeps that write order from turning into a race. An ingest writes the file
    and *then* the row, so between those two steps a file legitimately has no row — and a sweep running
    in another request at that instant would delete the document being attached. Callers that can
    overlap an ingest pass `INGEST_GRACE_SECONDS` to leave recent files alone; a genuinely orphaned one
    is simply reclaimed by the next sweep. Restore passes nothing, and should: it has just replaced the
    entire ledger, so every unreferenced file is unreferenced by definition, and concurrent ingest is not
    a legal state during one.
    """
    referenced = {row["id"] for row in conn.execute("SELECT id FROM document")}
    cutoff = time.time() - min_age_seconds if min_age_seconds else None
    removed = []
    for document_id in sorted(stored_document_ids() - referenced):
        path = document_file_path(document_id)
        if cutoff is not None:
            try:
                if path.stat().st_mtime > cutoff:
                    continue
            except FileNotFoundError:
                continue
        if delete_document_file(document_id):
            removed.append(document_id)
    return removed


DOCUMENT_ROW_COLUMNS = "id, txn_id, filename, mime_type, byte_size, sha256, created_at, text_source"


def _document_row(row: sqlite3.Row) -> dict:
    """One document as the API describes it. `text` is deliberately not included — it can be hundreds of
    kilobytes and no surface renders it, so shipping it with every list would put an invoice's full text
    into the payload of a transaction that merely shows a paperclip. `text_source` is included because
    "was anything extracted, and by what" is exactly what a caller needs to decide what to offer."""
    return dict(row)


def list_documents(conn: sqlite3.Connection, txn_id: str) -> list[dict]:
    return [
        _document_row(row)
        for row in conn.execute(
            f"SELECT {DOCUMENT_ROW_COLUMNS} FROM document WHERE txn_id = ? ORDER BY created_at, rowid",
            (txn_id,),
        )
    ]


def list_stored_documents(conn: sqlite3.Connection) -> list[dict]:
    """The documents waiting for a transaction, newest first — the order someone looking for the invoice
    that just arrived wants, where a transaction's own list reads in the order things were attached."""
    return [
        _document_row(row)
        for row in conn.execute(
            f"SELECT {DOCUMENT_ROW_COLUMNS} FROM document WHERE txn_id IS NULL "
            "ORDER BY created_at DESC, rowid DESC"
        )
    ]


def get_document(conn: sqlite3.Connection, document_id: str) -> Optional[dict]:
    row = conn.execute(f"SELECT {DOCUMENT_ROW_COLUMNS} FROM document WHERE id = ?", (document_id,)).fetchone()
    return _document_row(row) if row else None


# What the ledger needs to know about a document, as against what the detail panel does. Enough to name
# it, pick a viewer for it, and open it — and deliberately not `text`, which can run to hundreds of
# kilobytes that no list surface renders.
DOCUMENT_LIST_COLUMNS = "id, txn_id, filename, mime_type"


def documents_map_for(conn: sqlite3.Connection, txn_ids) -> dict[str, list[dict]]:
    """The documents on each of these transactions, keyed by transaction.

    Carried inline on the list feed rather than fetched per row when the indicator is clicked, which is
    the same call `split_parts` made and for the same reason: the ledger opens these straight from the
    row, and a fetch there would put a loading state inside an interaction that should be instant.
    Resolved for the whole page in one query — a request per line is the thing being avoided.
    """
    ids = [txn_id for txn_id in txn_ids if txn_id]
    if not ids:
        return {}
    placeholders = ",".join("?" for _ in ids)
    grouped: dict[str, list[dict]] = {}
    for row in conn.execute(
        f"SELECT {DOCUMENT_LIST_COLUMNS} FROM document WHERE txn_id IN ({placeholders}) "
        "ORDER BY created_at, rowid",
        ids,
    ):
        entry = dict(row)
        grouped.setdefault(entry.pop("txn_id"), []).append(entry)
    return grouped


# Markers FTS5 puts around each matched term in an excerpt. Control characters, so they cannot collide with
# extracted text in practice; they are split out here and never reach the client.
_EXCERPT_OPEN = "\x02"
_EXCERPT_CLOSE = "\x03"
# How many tokens of context an excerpt carries, matches included. Enough to recognise the line on the
# receipt, short enough for a row tooltip.
_EXCERPT_TOKENS = 14


def document_match_excerpts(conn: sqlite3.Connection, fts_query: str, txn_ids) -> dict[str, list[dict]]:
    """For each document on these transactions that matches `fts_query`, the passage it matched in.

    Keyed by document id. A passage is a list of `{text, hit}` segments, `hit` marking the terms the query
    matched, so a client can highlight them without parsing markers. The terms are whole tokens: a prefix
    search for `75` highlights `75D15`, which is what the index matched. Asks the same question as the list
    filter's `DOCUMENT_MATCH_SQL`, so every row marked `matched_document` has at least one passage.
    """
    ids = [txn_id for txn_id in txn_ids if txn_id]
    if not ids or not fts_query:
        return {}
    placeholders = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"SELECT d.id, snippet(document_fts, 0, ?, ?, '…', ?) AS excerpt "
        "FROM document_fts JOIN document d ON d.rowid = document_fts.rowid "
        f"WHERE document_fts MATCH ? AND d.txn_id IN ({placeholders})",
        [_EXCERPT_OPEN, _EXCERPT_CLOSE, _EXCERPT_TOKENS, fts_query, *ids],
    )
    return {row["id"]: _excerpt_segments(row["excerpt"] or "") for row in rows}


def _excerpt_segments(excerpt: str) -> list[dict]:
    # Whitespace is collapsed because a passage from a PDF or a receipt layout carries its line breaks
    # and column padding, which mean nothing once it is one line in a tooltip.
    segments = []
    for i, piece in enumerate(re.split(f"[{_EXCERPT_OPEN}{_EXCERPT_CLOSE}]", excerpt)):
        text = re.sub(r"\s+", " ", piece)
        if text:
            segments.append({"text": text, "hit": i % 2 == 1})
    return segments


def find_duplicate_attachment(
    conn: sqlite3.Connection, txn_id: Optional[str], sha256: str, exclude_id: Optional[str] = None,
) -> Optional[dict]:
    """An identical file already on this transaction — or already stored, for `txn_id` None — if there is one.

    The digest earns its keep here: attaching the same receipt twice is a real thing people do — the
    file gets dropped, nothing visibly happens fast enough, and it gets dropped again — and the result
    is two identical entries that the user then has to tell apart by nothing. Reported to the caller as
    the existing document rather than rejected outright, so the answer can be "this is already
    attached" instead of an error about a file that is, after all, exactly right.

    `IS` rather than `=`, so the stored set (NULL) is one more place a document can already be. `exclude_id`
    is the document being moved, which must not find itself.
    """
    row = conn.execute(
        f"SELECT {DOCUMENT_ROW_COLUMNS} FROM document WHERE txn_id IS ? AND sha256 = ? AND id IS NOT ? LIMIT 1",
        (txn_id, sha256, exclude_id),
    ).fetchone()
    return _document_row(row) if row else None


@dataclass(frozen=True)
class DocumentMove:
    """Where a moved document ended up. `document` is what now stands at the destination; `merged_id`, when
    set, is the moved document's own id, whose row was dropped because an identical file was already there
    — its file is the caller's to remove once the transaction commits."""

    document: dict
    merged_id: Optional[str] = None


def move_document(conn: sqlite3.Connection, document_id: str, txn_id: Optional[str]) -> Optional[DocumentMove]:
    """Put a document on a transaction, or back among the stored ones for `txn_id` None. None when there is
    no such document.

    Only the row changes: the file is keyed by id, so attaching and detaching never touch the bytes.

    **Arriving where an identical file already is folds the two together** rather than making a second
    entry, for the reason the duplicate check on upload gives — two copies of one receipt are two entries
    to tell apart by nothing. The copy already there is kept, so its name wins; the moved one is removed.
    """
    current = get_document(conn, document_id)
    if current is None:
        return None
    if current["txn_id"] == txn_id:
        return DocumentMove(current)
    existing = find_duplicate_attachment(conn, txn_id, current["sha256"], exclude_id=document_id)
    if existing:
        delete_document(conn, document_id)
        return DocumentMove(existing, merged_id=document_id)
    conn.execute("UPDATE document SET txn_id = ? WHERE id = ?", (txn_id, document_id))
    return DocumentMove(get_document(conn, document_id))


def rename_document(conn: sqlite3.Connection, document_id: str, filename: str) -> Optional[dict]:
    """Give a document a new name, returning it (None when there is no such document).

    The name is display and download text only — the file is keyed by id — so it goes through the same
    reduction an upload's name does and nothing else. An empty name is refused rather than defaulted: the
    list would show "document" for something the user just deliberately cleared.
    """
    cleaned = _safe_filename(filename) if (filename or "").strip() else ""
    if not cleaned:
        raise DocumentRejected("A document needs a name.")
    cursor = conn.execute("UPDATE document SET filename = ? WHERE id = ?", (cleaned, document_id))
    if not cursor.rowcount:
        return None
    return get_document(conn, document_id)


def attach_document(conn: sqlite3.Connection, txn_id: Optional[str], prepared: PreparedDocument) -> dict:
    """Store a prepared upload and record it against a transaction — or as stored, for `txn_id` None —
    returning the new document row.

    **File first, then the row**, which is the invariant this whole module is arranged around: a crash
    between the two leaves inert litter a sweep reclaims, never a row pointing at nothing. The caller
    owns the transaction, so the row lands with whatever else that request is doing.

    Text extraction happens here rather than in a later pass because tier 1 is local, fast and exact —
    there is nothing to schedule. A document whose text could not be read is stored all the same; the
    file is the point and the index is the bonus.
    """
    return _store_document(conn, txn_id, prepared, utcnow_iso())


def replace_document_text(conn: sqlite3.Connection, document_id: str, text: str) -> Optional[dict]:
    """Replace a text document's content, returning the document that now stands in its place (None when
    there is no such document).

    **An edit is a new document in the old one's place, not a rewrite of its file.** Rewriting in place
    cannot keep the store's one invariant: the row's digest describes the file on disk, and file and row
    cannot change together, so there would be a moment where they disagree — and a crash in it leaves a
    document that a restore and a backup both read as torn. As a replacement it is ordinary ingest: the new
    file is written first, then the new row goes in and the old one comes out in the caller's transaction,
    and the old file is removed only after that commits (by the router, or by the next sweep if the
    request dies first). The cost is that **the document's id changes**, so anything holding the old one
    has to swap it — the ledger row's own copy of its documents above all.

    The name and `created_at` carry over, so the document keeps its place in the list and is still the
    same entry to the person looking at it. There is deliberately no duplicate check against the other
    documents on the transaction: that check exists for the same file dropped twice by accident, and an edit
    is a deliberate statement of what the text should be.

    Only `text/plain` is editable. A PDF or a photograph is not text to edit, and HTML is not edited either:
    its formatting is the reason it was kept, and editing markup safely is out of proportion to trimming a
    receipt.
    """
    row = conn.execute(
        "SELECT txn_id, filename, mime_type, created_at FROM document WHERE id = ?", (document_id,)
    ).fetchone()
    if not row:
        return None
    if row["mime_type"] != TEXT_MIME_TYPE:
        raise DocumentRejected("Only a text document can be edited.")
    data = text.encode("utf-8")
    if not data.strip():
        raise DocumentRejected("A text document cannot be empty. Remove it instead.")
    if len(data) > MAX_DOCUMENT_BYTES:
        limit_mb = MAX_DOCUMENT_BYTES // (1024 * 1024)
        raise DocumentRejected(f"That text is larger than the {limit_mb} MB limit for an attached document.")

    prepared = PreparedDocument(
        data=data,
        filename=row["filename"],
        mime_type=TEXT_MIME_TYPE,
        byte_size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
    )
    conn.execute("DELETE FROM document WHERE id = ?", (document_id,))
    return _store_document(conn, row["txn_id"], prepared, row["created_at"])


def _store_document(
    conn: sqlite3.Connection, txn_id: Optional[str], prepared: PreparedDocument, created_at: str,
) -> dict:
    """Write the file, then insert the row — the order both attaching and replacing depend on."""
    document_id = new_document_id()
    text, text_source = extract_text(prepared.data, prepared.mime_type)
    write_document_file(document_id, prepared.data)
    conn.execute(
        "INSERT INTO document (id, txn_id, filename, mime_type, byte_size, sha256, created_at, text, text_source) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (document_id, txn_id, prepared.filename, prepared.mime_type, prepared.byte_size,
         prepared.sha256, created_at, text, text_source),
    )
    return get_document(conn, document_id)


def delete_document(conn: sqlite3.Connection, document_id: str) -> bool:
    """Remove a document, row and file. False when there was no such row.

    Row first here, the reverse of ingest, and for the same reason: whichever operation is *not* in the
    transaction should be the one whose failure leaves litter rather than a dangling reference. The
    file is deleted after the caller's transaction commits — see the router — so a rolled-back delete
    cannot cost the file.
    """
    cursor = conn.execute("DELETE FROM document WHERE id = ?", (document_id,))
    return bool(cursor.rowcount)


def missing_document_ids(conn: sqlite3.Connection) -> list[str]:
    """Documents the ledger claims that have no complete file behind them.

    The comparison is against the recorded digest, not merely the file's presence, because the case
    worth catching is a *torn* file — an interrupted restore or a crash mid-write — which a presence
    test walks straight past. This is the same one-pass comparison a resumed restore uses to decide
    what is left to write, which is why there is no progress cursor anywhere in this design.
    """
    pending = []
    for row in conn.execute("SELECT id, sha256 FROM document ORDER BY rowid"):
        # An id that could not name a file has no file, so it is pending by definition — reported rather
        # than raised, because this runs over a whole ledger and one bad row must not stop the report.
        if not is_safe_document_id(row["id"]):
            pending.append(row["id"])
            continue
        if file_digest(document_file_path(row["id"])) != row["sha256"]:
            pending.append(row["id"])
    return pending

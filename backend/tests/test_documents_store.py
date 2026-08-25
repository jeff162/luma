"""
The document store: normalizing an upload, writing it atomically, and reconciling files against rows.

The store is the half of attachments that is *not* transactional — files and rows commit separately —
so the tests that matter here are the ones about the seam between them: what a torn write leaves
behind, what the digest is able to catch, and which direction of drift each reconciliation helper is
supposed to fix. The happy path is cheap to cover and is not where this can hurt anyone.

Every test points the database at its own temporary directory, which is also what gives it a private
document store — `documents_dir()` derives from the database path for exactly that reason.
"""

from __future__ import annotations

import hashlib
import io
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.tests._pdf_fixture import make_text_pdf
from backend.services.documents import (
    IMAGE_LONG_EDGE_PX,
    IMAGE_PASSTHROUGH_BYTES,
    MAX_DOCUMENT_BYTES,
    TEXT_SOURCE_PDF_LAYER,
    DocumentRejected,
    copy_document_file_from,
    delete_document_file,
    document_file_path,
    documents_dir,
    extract_text,
    file_digest,
    missing_document_ids,
    new_document_id,
    prepare_document,
    stored_document_ids,
    sweep_unreferenced_files,
    write_document_file,
)

# A one-page PDF small enough to inline. Only the header is load-bearing for the store (it is what the
# sniffer keys on); nothing here parses the structure.
PDF_BYTES = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"


def make_image_bytes(width: int, height: int, fmt: str = "JPEG", mode: str = "RGB") -> bytes:
    """A real encoded image of a given size. Noise rather than flat color, because a solid image
    compresses to almost nothing and would make every size assertion below meaningless."""
    import random

    random.seed(width * height)
    image = Image.new(mode, (width, height))
    image.putdata([
        tuple(random.randrange(256) for _ in range(len(mode)))
        for _ in range(width * height)
    ])
    buffer = io.BytesIO()
    image.save(buffer, format=fmt)
    return buffer.getvalue()


class DocumentStoreTestCase(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        db_path = str(Path(self.tempdir.name) / "documents-tests.db")
        init_db(db_path)
        token = set_current_db_path(db_path)
        self.addCleanup(reset_current_db_path, token)
        # A real transaction to hang documents off: the FK is enforced, so a bare document row is not a
        # state the schema allows and a fixture that skipped this would be testing a shape that cannot
        # exist.
        with get_db() as conn:
            conn.execute(
                "INSERT INTO account (id, name, display_name) VALUES ('acct-1', 'Everyday', 'Everyday')"
            )
            conn.execute(
                "INSERT INTO txn (id, account_id, amount, date) VALUES ('txn-1', 'acct-1', -42.5, '2026-08-01')"
            )

    def insert_document(self, conn, document_id, sha256, txn_id="txn-1"):
        conn.execute(
            "INSERT INTO document (id, txn_id, filename, mime_type, byte_size, sha256, created_at) "
            "VALUES (?, ?, 'receipt.pdf', 'application/pdf', 1, ?, '2026-08-24T00:00:00Z')",
            (document_id, txn_id, sha256),
        )


class PrepareDocumentTests(DocumentStoreTestCase):
    def test_pdf_passes_through_byte_for_byte(self):
        # A digital invoice's text layer is the thing tier-1 extraction reads, so re-encoding a PDF
        # would destroy the reason to prefer one.
        prepared = prepare_document(PDF_BYTES, "invoice.pdf", "application/pdf")
        self.assertEqual(prepared.data, PDF_BYTES)
        self.assertEqual(prepared.mime_type, "application/pdf")
        self.assertEqual(prepared.byte_size, len(PDF_BYTES))
        self.assertEqual(prepared.sha256, hashlib.sha256(PDF_BYTES).hexdigest())

    def test_header_beats_a_wrong_declared_content_type(self):
        # A browser labels a file from its extension and a clipboard paste may declare nothing at all,
        # so the bytes decide. Storing the declared type would mean serving a PDF as an image later.
        prepared = prepare_document(PDF_BYTES, "receipt.jpg", "image/jpeg")
        self.assertEqual(prepared.mime_type, "application/pdf")

    def test_oversized_photo_is_downscaled_once_at_ingest(self):
        original = make_image_bytes(3000, 2000)
        self.assertGreater(len(original), IMAGE_PASSTHROUGH_BYTES)
        prepared = prepare_document(original, "receipt.jpg", "image/jpeg")

        self.assertLess(prepared.byte_size, len(original))
        with Image.open(io.BytesIO(prepared.data)) as stored:
            self.assertLessEqual(max(stored.size), IMAGE_LONG_EDGE_PX)
        # The recorded size and digest describe what is stored, not what arrived — a restore compares a
        # file on disk against them, so a digest of the upload would fail every document it touched.
        self.assertEqual(prepared.byte_size, len(prepared.data))
        self.assertEqual(prepared.sha256, hashlib.sha256(prepared.data).hexdigest())

    def test_small_image_is_stored_as_delivered(self):
        original = make_image_bytes(400, 300, fmt="PNG")
        self.assertLess(len(original), IMAGE_PASSTHROUGH_BYTES)
        prepared = prepare_document(original, "screenshot.png", "image/png")
        # Re-encoding here would spend a generation of quality on a file whose size was never a problem,
        # and a screenshot's crisp text is what JPEG treats worst.
        self.assertEqual(prepared.data, original)
        self.assertEqual(prepared.mime_type, "image/png")

    def test_transparency_survives_downscaling(self):
        original = make_image_bytes(2400, 1800, fmt="PNG", mode="RGBA")
        prepared = prepare_document(original, "receipt.png", "image/png")
        # Flattening alpha onto a background is not a quality trade, it changes the picture — so an
        # image with transparency stays PNG rather than being re-encoded to JPEG.
        self.assertEqual(prepared.mime_type, "image/png")
        with Image.open(io.BytesIO(prepared.data)) as stored:
            self.assertIn("A", stored.mode)

    def test_rejects_empty_oversized_and_unsupported(self):
        with self.assertRaises(DocumentRejected):
            prepare_document(b"", "empty.pdf", "application/pdf")
        with self.assertRaises(DocumentRejected):
            prepare_document(b"%PDF-" + b"\0" * MAX_DOCUMENT_BYTES, "huge.pdf", "application/pdf")
        with self.assertRaises(DocumentRejected):
            prepare_document(b"MZ\x90\x00 not a receipt", "setup.exe", "application/octet-stream")

    def test_filename_is_reduced_to_a_leaf_name(self):
        # The name is display and download-filename only; the store is keyed by id. Keeping path
        # components would leave a value that *looks* like a path to whatever handles it next.
        prepared = prepare_document(PDF_BYTES, "../../etc/passwd", "application/pdf")
        self.assertEqual(prepared.filename, "passwd")
        self.assertEqual(prepare_document(PDF_BYTES, r"C:\Users\x\bill.pdf", None).filename, "bill.pdf")
        self.assertEqual(prepare_document(PDF_BYTES, "", None).filename, "document")


class ExtractTextTests(unittest.TestCase):
    """Tier 1 — a digital PDF's own text layer, and everything that is deliberately not it."""

    def test_a_digital_pdf_yields_its_text_and_names_the_tier(self):
        text, source = extract_text(make_text_pdf(["ACME Auto Repair", "Front brake pads"]), "application/pdf")
        self.assertIn("brake pads", text)
        self.assertEqual(source, TEXT_SOURCE_PDF_LAYER)

    def test_layout_whitespace_is_collapsed_but_lines_are_kept(self):
        # Extraction emits the page's layout — column padding and a blank line per visual gap — which is
        # noise to an index. Line structure survives because it is what makes an itemized bill readable.
        text, _ = extract_text(make_text_pdf(["Item      one", "", "Item      two"]), "application/pdf")
        self.assertEqual(text, "Item one\nItem two")

    def test_an_image_is_not_attempted(self):
        # Reading a photograph is OCR, a later tier behind a system binary. `None` says no text was
        # obtained, which is distinct from text that is genuinely empty.
        self.assertEqual(extract_text(make_image_bytes(200, 200), "image/jpeg"), (None, None))

    def test_an_unreadable_pdf_yields_no_text_rather_than_raising(self):
        # A document whose text cannot be read is still a perfectly good document; refusing the
        # attachment over it would trade the file for its index entry.
        self.assertEqual(extract_text(b"%PDF-1.4\nnot really a pdf\n%%EOF", "application/pdf"), (None, None))

    def test_a_scan_wrapped_in_a_pdf_reads_as_no_text_layer(self):
        # A scanned invoice commonly yields a few stray characters from page furniture. Recording that
        # as an extraction would mark the document searched when nothing searchable was found — the
        # state that later has to be told apart from a real one to know whether OCR is worth offering.
        text, source = extract_text(make_text_pdf(["x"]), "application/pdf")
        self.assertIsNone(text)
        self.assertIsNone(source)


class WriteAndReconcileTests(DocumentStoreTestCase):
    def test_write_then_read_round_trips_and_leaves_no_temporaries(self):
        document_id = new_document_id()
        write_document_file(document_id, PDF_BYTES)

        path = document_file_path(document_id)
        self.assertEqual(path.read_bytes(), PDF_BYTES)
        self.assertEqual(file_digest(path), hashlib.sha256(PDF_BYTES).hexdigest())
        # The staging temporary is replaced into place, not left beside the file it produced.
        self.assertEqual({entry.name for entry in documents_dir().iterdir()}, {document_id})

    def test_a_failed_write_leaves_neither_a_file_nor_a_temporary(self):
        # The atomic-replace contract stated as a failure: an ingest that dies mid-write must not leave
        # a truncated file under the real name, because everything downstream treats presence as intact.
        document_id = new_document_id()
        write_document_file(new_document_id(), PDF_BYTES)  # a neighbor, so the directory already exists

        class Exploding(io.RawIOBase):
            def read(self, size=-1):
                raise OSError("disk went away")

        with self.assertRaises(OSError):
            copy_document_file_from(document_id, Exploding())

        self.assertFalse(document_file_path(document_id).exists())
        self.assertEqual(
            [entry.name for entry in documents_dir().iterdir() if entry.name.startswith(".incoming-")],
            [],
        )

    def test_copy_from_a_stream_digests_what_it_wrote(self):
        document_id = new_document_id()
        payload = make_image_bytes(200, 200)
        digest = copy_document_file_from(document_id, io.BytesIO(payload))
        self.assertEqual(digest, hashlib.sha256(payload).hexdigest())
        self.assertEqual(document_file_path(document_id).read_bytes(), payload)

    def test_stored_ids_ignore_in_flight_temporaries(self):
        document_id = new_document_id()
        write_document_file(document_id, PDF_BYTES)
        (documents_dir() / ".incoming-abc123").write_bytes(b"half a file")
        # A temporary is not a document. Reading one as an id would make the sweep below delete a file
        # a concurrent ingest is still writing.
        self.assertEqual(stored_document_ids(), {document_id})

    def test_sweep_removes_only_files_the_ledger_no_longer_references(self):
        kept, orphan = new_document_id(), new_document_id()
        write_document_file(kept, PDF_BYTES)
        write_document_file(orphan, PDF_BYTES)

        with get_db() as conn:
            self.insert_document(conn, kept, hashlib.sha256(PDF_BYTES).hexdigest())
            removed = sweep_unreferenced_files(conn)

        self.assertEqual(removed, [orphan])
        self.assertTrue(document_file_path(kept).exists())
        self.assertFalse(document_file_path(orphan).exists())

    def test_missing_ids_catch_a_torn_file_not_just_an_absent_one(self):
        absent, torn, intact = new_document_id(), new_document_id(), new_document_id()
        write_document_file(torn, PDF_BYTES[: len(PDF_BYTES) // 2])
        write_document_file(intact, PDF_BYTES)

        with get_db() as conn:
            for document_id in (absent, torn, intact):
                self.insert_document(conn, document_id, hashlib.sha256(PDF_BYTES).hexdigest())
            pending = missing_document_ids(conn)

        # Comparing digests rather than testing for presence is the whole point: a half-written file is
        # exactly what an interrupted restore leaves, and a presence check walks straight past it.
        self.assertCountEqual(pending, [absent, torn])

    def test_an_id_that_could_escape_the_directory_is_refused(self):
        # Ids this app mints are UUIDs, but a *restore* takes them from the archive's rows, and a backup
        # may have come from somewhere else. Without this, a hand-edited archive turns a restore into an
        # arbitrary file write.
        for hostile in ("../../etc/passwd", "..", ".", "", "a/b", "a\\b", "a\0b"):
            with self.assertRaises(ValueError, msg=f"{hostile!r} was accepted as a document id"):
                document_file_path(hostile)

    def test_an_unusable_id_is_reported_as_missing_rather_than_raising(self):
        # One bad row must not stop the report it appears in — the same rule that keeps a corrupt
        # document from costing the ledger it was attached to.
        with get_db() as conn:
            self.insert_document(conn, "../escape", hashlib.sha256(PDF_BYTES).hexdigest())
            self.assertEqual(missing_document_ids(conn), ["../escape"])

    def test_delete_is_idempotent(self):
        # The file-first write order makes "file already gone" an ordinary state, not an error.
        document_id = new_document_id()
        write_document_file(document_id, PDF_BYTES)
        delete_document_file(document_id)
        delete_document_file(document_id)
        self.assertFalse(document_file_path(document_id).exists())


if __name__ == "__main__":
    unittest.main()

"""Attaching, storing, serving, moving, deleting and searching documents.

The store's own invariants live in `test_documents_store.py`; this covers the API over it and the one
thing that only exists once both halves are wired together — that text pulled out of a PDF at ingest is
reachable from the ledger's quick filter.

Two areas get disproportionate attention because they are where this feature can actually hurt someone:
the headers a stored file is served under (this is the only endpoint that returns bytes a user
supplied), and what the search box does with input that is not a well-formed query.
"""

from __future__ import annotations

import asyncio
import io
import unittest
import uuid
from pathlib import Path
import tempfile

from fastapi import HTTPException, UploadFile

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.documents import (
    DocumentName,
    DocumentTarget,
    DocumentText,
    attach_stored_document,
    attach_transaction_document,
    delete_document_permanently,
    detach_document,
    edit_document_text,
    get_document_file,
    list_stored,
    list_transaction_documents,
    rename,
    store_document,
)
from backend.routers.transactions import list_transactions
from backend.services.documents import document_file_path
from backend.tests._pdf_fixture import make_text_pdf
from backend.tests.test_documents_store import make_image_bytes

INVOICE_LINES = ["ACME Auto Repair", "Replaced front brake pads and rotors", "Total 249.50"]


def _upload(content: bytes, filename: str, content_type: str) -> UploadFile:
    return UploadFile(
        file=io.BytesIO(content),
        filename=filename,
        headers={"content-type": content_type},
    )


class DocumentsApiTestCase(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.db_path = str(Path(self.tempdir.name) / "documents-api.db")
        init_db(self.db_path)
        token = set_current_db_path(self.db_path)
        self.addCleanup(reset_current_db_path, token)
        with get_db() as conn:
            conn.execute("INSERT INTO account (id, name, display_name) VALUES ('acct', 'Everyday', 'Everyday')")
            for txn_id, payee, amount, date in (
                ("txn-repair", "Garage", -249.50, "2026-03-14"),
                ("txn-coffee", "Cafe", -4.75, "2026-03-15"),
            ):
                conn.execute(
                    "INSERT INTO txn (id, account_id, amount, date, merchant_name, display_name, raw_name) "
                    "VALUES (?, 'acct', ?, ?, ?, ?, ?)",
                    (txn_id, amount, date, payee, payee, payee),
                )

    def attach(self, txn_id, content, filename, content_type):
        return asyncio.run(attach_transaction_document(txn_id, file=_upload(content, filename, content_type)))

    def store(self, content, filename, content_type):
        return asyncio.run(store_document(file=_upload(content, filename, content_type)))

    def list_rows(self, value):
        return self._list(value)["transactions"]

    def quick_filter(self, value):
        return [row["id"] for row in self._list(value)["transactions"]]

    def _list(self, value):
        return list_transactions(
            month=None, date_start=None, date_end=None, import_batch_id=None,
            sort_by="date", sort_dir="desc", account_id=None, category_id=None,
            direction=None, view=None, search=None, quick_filter=value,
            include_trashed=False, limit=50, offset=0,
        )


class AttachAndServeTests(DocumentsApiTestCase):
    def test_attaching_a_pdf_stores_it_and_extracts_its_text(self):
        pdf = make_text_pdf(INVOICE_LINES)
        result = self.attach("txn-repair", pdf, "invoice.pdf", "application/pdf")

        document = result["document"]
        self.assertFalse(result["already_attached"])
        self.assertEqual(document["mime_type"], "application/pdf")
        self.assertEqual(document["filename"], "invoice.pdf")
        # A digital PDF carries real text, so tier 1 is exact rather than interpreted — and says so,
        # since the tiers differ in reliability and anything reading the text later needs to know which.
        self.assertEqual(document["text_source"], "pdf_text")
        self.assertEqual(document_file_path(document["id"]).read_bytes(), pdf)
        with get_db() as conn:
            stored = conn.execute("SELECT text FROM document WHERE id = ?", (document["id"],)).fetchone()
        self.assertIn("brake pads", stored["text"])

    def test_a_photograph_is_stored_without_text_rather_than_refused(self):
        # No text is a real answer, not a failure: OCR is a later tier behind a system binary, and the
        # file is the point — an image whose text cannot be read is still a perfectly good receipt.
        result = self.attach("txn-coffee", make_image_bytes(300, 400), "receipt.jpg", "image/jpeg")
        self.assertIsNone(result["document"]["text_source"])
        self.assertTrue(document_file_path(result["document"]["id"]).is_file())

    def test_several_documents_hang_off_one_transaction_in_attach_order(self):
        # A repair arrives as an estimate and then a final invoice. Nothing constrains this to one, and
        # the order shown is the order they were attached.
        first = self.attach("txn-repair", make_text_pdf(["Estimate 210.00"]), "estimate.pdf", "application/pdf")
        second = self.attach("txn-repair", make_text_pdf(INVOICE_LINES), "invoice.pdf", "application/pdf")

        listed = list_transaction_documents("txn-repair")["documents"]
        expected = [first["document"]["id"], second["document"]["id"]]
        actual = [d["id"] for d in listed]
        if actual != expected:
            # Diagnostics for a known intermittent (~1 in 11 full-suite runs; never in 60 runs of this
            # file alone, so it needs the parallel suite). The listing orders by `created_at, rowid`, and
            # this table is two rows old in a per-test temp database — so rowid is 1 and 2, the tiebreaker
            # cannot be what failed, and the inversion has to be in `created_at` itself. Both are dumped
            # because the three candidate explanations are told apart by nothing else: equal timestamps
            # (a tie the rowid should then have settled), an inverted pair (the wall clock moved backwards
            # mid-run), or rowids that are not what a fresh table should hold. Delete this block with the
            # fix; a bare assertEqual here reports only that the order was wrong, which is what left the
            # cause unknown for as long as it has been.
            with get_db() as conn:
                rows = conn.execute(
                    "SELECT rowid AS rid, id, created_at FROM document WHERE txn_id = 'txn-repair' "
                    "ORDER BY rid"
                ).fetchall()
            detail = "; ".join(
                f"rowid={r['rid']} id={r['id']} created_at={r['created_at']!r}" for r in rows
            )
            self.fail(
                f"documents listed out of attach order: expected {expected}, got {actual} — "
                f"rows by rowid: {detail}"
            )

    def test_the_same_file_twice_is_reported_rather_than_stored_twice(self):
        # Dropping a receipt twice is ordinary when nothing visibly happened fast enough. Two identical
        # entries the user then has to tell apart by nothing is the outcome worth preventing.
        pdf = make_text_pdf(INVOICE_LINES)
        first = self.attach("txn-repair", pdf, "invoice.pdf", "application/pdf")
        again = self.attach("txn-repair", pdf, "invoice-copy.pdf", "application/pdf")

        self.assertTrue(again["already_attached"])
        self.assertEqual(again["document"]["id"], first["document"]["id"])
        self.assertEqual(len(list_transaction_documents("txn-repair")["documents"]), 1)

    def test_the_same_file_on_a_different_transaction_is_a_different_document(self):
        # The digest identifies a *duplicate attach*, not a globally unique file: one invoice legitimately
        # covering two charges is a real thing, and dedupe is scoped to the transaction for that reason.
        pdf = make_text_pdf(INVOICE_LINES)
        first = self.attach("txn-repair", pdf, "invoice.pdf", "application/pdf")
        other = self.attach("txn-coffee", pdf, "invoice.pdf", "application/pdf")

        self.assertFalse(other["already_attached"])
        self.assertNotEqual(other["document"]["id"], first["document"]["id"])

    def test_an_unsupported_file_is_refused_with_a_reason(self):
        with self.assertRaises(HTTPException) as ctx:
            self.attach("txn-repair", b"MZ\x90\x00 not a receipt", "setup.exe", "application/octet-stream")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("PDF, an image, text, an HTML file, or an exported email", ctx.exception.detail)

    def test_pasted_text_is_a_document_and_is_searchable_immediately(self):
        # The email story: a receipt forwarded by mail is pasted rather than saved first. No extraction
        # step runs — the bytes *are* the text — which is why the source is `verbatim` and not a tier.
        body = "ACME Auto Repair\nReplaced front brake pads and rotors\nTotal 249.50"
        result = self.attach("txn-repair", body.encode(), "Pasted receipt.txt", "text/plain")

        self.assertEqual(result["document"]["mime_type"], "text/plain")
        self.assertEqual(result["document"]["text_source"], "verbatim")
        self.assertEqual(self.quick_filter("doc:rotors"), ["txn-repair"])

    def test_html_pasted_from_an_email_keeps_its_markup_and_is_searchable(self):
        # A receipt copied out of an email carries its table as text/html. Storing that rather than the
        # flattened plain flavour is what keeps an amount beside the thing it is the price of; the search
        # text is the same markup with its tags taken out.
        markup = (
            "<table><tr><td>Professional Tune Up</td><td>1</td><td>$350.00</td></tr>"
            "<tr><td>EDDY merxx white</td><td>1</td><td>$0.00</td></tr></table>"
            "<style>td { color: red }</style>"
        )
        result = self.attach("txn-repair", markup.encode(), "Pasted receipt.html", "text/html")

        self.assertEqual(result["document"]["mime_type"], "text/html")
        self.assertEqual(result["document"]["text_source"], "html_text")
        self.assertEqual(self.quick_filter("doc:merxx"), ["txn-repair"])
        with get_db() as conn:
            text = conn.execute("SELECT text FROM document").fetchone()["text"]
        # Cells stay on their row, so the price is still next to what it prices.
        self.assertIn("Professional Tune Up 1 $350.00", text)
        # Stylesheet bodies are text to a parser and noise to a reader.
        self.assertNotIn("color", text)

    def test_a_saved_email_becomes_the_document_it_carries(self):
        # An exported .eml is the one receipt source a clipboard quirk cannot defeat, and no browser
        # renders one — so it is converted at ingest and nothing downstream knows an email was involved.
        # The HTML part wins over the plain one for the same reason a rich paste does: it holds the table
        # the sender laid out, where the plain alternative is that table flattened.
        raw = (
            "Return-Path: <shop@example.invalid>\r\n"
            "Subject: Work order #8123 quote\r\n"
            "MIME-Version: 1.0\r\n"
            'Content-Type: multipart/alternative; boundary="b1"\r\n\r\n'
            "--b1\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n"
            "Professional Tune Up\r\n1\t$350.00\r\n"
            "--b1\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n"
            "<table><tr><td>EDDY merxx white</td><td>1</td><td>$0.00</td></tr></table>\r\n"
            "--b1--\r\n"
        )
        result = self.attach("txn-repair", raw.encode(), "download.eml", "message/rfc822")

        document = result["document"]
        self.assertEqual(document["mime_type"], "text/html")
        # The subject names it: an exported message is usually named opaquely by whatever produced it.
        self.assertEqual(document["filename"], "Work order #8123 quote.html")
        self.assertEqual(document["text_source"], "html_text")
        self.assertEqual(self.quick_filter("doc:merxx"), ["txn-repair"])

    def test_binary_claiming_to_be_text_is_still_refused(self):
        # Decoding is used to *confirm* a text upload, never to classify an unknown one — otherwise the
        # receipt store becomes a general file dump for anything that happens to decode.
        with self.assertRaises(HTTPException) as ctx:
            self.attach("txn-repair", b"\x00\x01\x02 binary", "notes.txt", "text/plain")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_attaching_to_an_unknown_transaction_is_a_404(self):
        with self.assertRaises(HTTPException) as ctx:
            self.attach(str(uuid.uuid4()), make_text_pdf(["x y z"]), "a.pdf", "application/pdf")
        self.assertEqual(ctx.exception.status_code, 404)

    def test_documents_stay_reachable_while_their_transaction_is_in_the_trash(self):
        # The trash is the reversible stage. Hiding the paperwork at the moment someone is deciding
        # whether to restore the row would make it look already lost.
        self.attach("txn-repair", make_text_pdf(INVOICE_LINES), "invoice.pdf", "application/pdf")
        with get_db() as conn:
            conn.execute("UPDATE txn SET trashed_at = '2026-03-20T00:00:00Z' WHERE id = 'txn-repair'")
        self.assertEqual(len(list_transaction_documents("txn-repair")["documents"]), 1)


class ServeAndDetachTests(DocumentsApiTestCase):
    def test_the_file_is_served_as_what_it_is_with_the_headers_a_file_store_owes(self):
        pdf = make_text_pdf(INVOICE_LINES)
        document = self.attach("txn-repair", pdf, "invoice.pdf", "application/pdf")["document"]

        response = get_document_file(document["id"])

        self.assertEqual(response.media_type, "application/pdf")
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        # This is the one endpoint returning bytes a user supplied. Without nosniff a browser may
        # reinterpret the content as something executable; the sandbox CSP is the second half of the
        # same argument, since a PDF viewer is a scripting host.
        self.assertIn("sandbox", response.headers["content-security-policy"])
        self.assertIn("inline", response.headers["content-disposition"])

    def test_asking_for_a_download_offers_the_original_filename(self):
        document = self.attach(
            "txn-repair", make_text_pdf(INVOICE_LINES), "invoice.pdf", "application/pdf"
        )["document"]
        response = get_document_file(document["id"], download=True)
        self.assertIn("attachment", response.headers["content-disposition"])
        self.assertIn('filename="invoice.pdf"', response.headers["content-disposition"])

    def test_a_filename_cannot_inject_a_header(self):
        # The name is echoed into Content-Disposition, so a quote in it would end the quoted string and
        # let the rest be read as header syntax.
        document = self.attach(
            "txn-coffee", make_image_bytes(200, 200), 'ev"il\r\nX-Injected: yes.jpg', "image/jpeg",
        )["document"]
        disposition = get_document_file(document["id"]).headers["content-disposition"]
        self.assertNotIn('"', disposition.split("filename=", 1)[1][1:-1])
        self.assertNotIn("\n", disposition)

    def test_a_row_whose_file_vanished_says_so_rather_than_failing_opaquely(self):
        # The drift the file-first write order allows. "Your receipt is gone" and "the server broke"
        # call for different reactions from whoever reads it.
        document = self.attach(
            "txn-repair", make_text_pdf(INVOICE_LINES), "invoice.pdf", "application/pdf"
        )["document"]
        document_file_path(document["id"]).unlink()

        with self.assertRaises(HTTPException) as ctx:
            get_document_file(document["id"])
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("missing from the store", ctx.exception.detail)

    def test_deleting_removes_the_row_and_the_file(self):
        document = self.attach(
            "txn-repair", make_text_pdf(INVOICE_LINES), "invoice.pdf", "application/pdf"
        )["document"]
        path = document_file_path(document["id"])

        self.assertEqual(delete_document_permanently(document["id"]), {"ok": True})

        self.assertFalse(path.exists())
        self.assertEqual(list_transaction_documents("txn-repair")["documents"], [])
        with self.assertRaises(HTTPException) as ctx:
            delete_document_permanently(document["id"])
        self.assertEqual(ctx.exception.status_code, 404)


class EditTextTests(DocumentsApiTestCase):
    """Editing an attached text document, which replaces it rather than rewriting its file."""

    def attach_text(self, content, filename="Pasted 2026-03-14.txt"):
        return self.attach("txn-repair", content.encode(), filename, "text/plain")["document"]

    def edit(self, document_id, text):
        return edit_document_text(document_id, DocumentText(text=text))["document"]

    def test_an_edit_replaces_the_document_under_a_new_id_in_the_same_place(self):
        first = self.attach_text("Brake pads 249.50\nThanks for your business, see signature below")
        second = self.attach_text("Rotor resurfacing 80.00", filename="second.txt")

        edited = self.edit(first["id"], "Brake pads 249.50")

        # A new id, because the file cannot be rewritten in place without a moment where its digest and
        # its row disagree; the old file goes once the swap has committed.
        self.assertNotEqual(edited["id"], first["id"])
        self.assertFalse(document_file_path(first["id"]).exists())
        self.assertEqual(document_file_path(edited["id"]).read_bytes(), b"Brake pads 249.50")
        # Still the same entry to the person looking at the list: same name, same place.
        self.assertEqual(edited["filename"], first["filename"])
        self.assertEqual(edited["created_at"], first["created_at"])
        self.assertEqual(edited["text_source"], "verbatim")
        listed = list_transaction_documents("txn-repair")["documents"]
        self.assertEqual([doc["id"] for doc in listed], [edited["id"], second["id"]])

    def test_search_follows_the_edit(self):
        document = self.attach_text("Brake pads and a signature from the service advisor")
        self.edit(document["id"], "Brake pads only")

        self.assertEqual(self.quick_filter("doc:advisor"), [])
        self.assertEqual(self.quick_filter("doc:only"), ["txn-repair"])

    def test_an_edit_matching_another_document_is_saved_all_the_same(self):
        # The duplicate check is for the same file dropped twice by accident; an edit is deliberate.
        self.attach_text("Brake pads 249.50")
        draft = self.attach_text("Brake pads 249.50 plus notes", filename="draft.txt")

        edited = self.edit(draft["id"], "Brake pads 249.50")

        self.assertEqual(len(list_transaction_documents("txn-repair")["documents"]), 2)
        self.assertTrue(document_file_path(edited["id"]).exists())

    def test_only_text_documents_can_be_edited_and_a_refusal_changes_nothing(self):
        pdf = self.attach("txn-repair", make_text_pdf(INVOICE_LINES), "invoice.pdf", "application/pdf")["document"]
        html = self.attach("txn-repair", b"<table><tr><td>Tube</td></tr></table>", "r.html", "text/html")["document"]

        for document in (pdf, html):
            with self.assertRaises(HTTPException) as ctx:
                self.edit(document["id"], "replacement")
            self.assertEqual(ctx.exception.status_code, 400)
            self.assertTrue(document_file_path(document["id"]).exists())
        self.assertEqual(len(list_transaction_documents("txn-repair")["documents"]), 2)

    def test_an_edit_to_nothing_is_refused_rather_than_leaving_an_empty_document(self):
        document = self.attach_text("Brake pads 249.50")
        with self.assertRaises(HTTPException) as ctx:
            self.edit(document["id"], "  \n ")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(list_transaction_documents("txn-repair")["documents"][0]["id"], document["id"])

    def test_editing_an_unknown_document_is_a_404(self):
        with self.assertRaises(HTTPException) as ctx:
            self.edit(str(uuid.uuid4()), "anything")
        self.assertEqual(ctx.exception.status_code, 404)


class DocumentSearchTests(DocumentsApiTestCase):
    def setUp(self):
        super().setUp()
        self.attach("txn-repair", make_text_pdf(INVOICE_LINES), "invoice.pdf", "application/pdf")

    def test_doc_prefix_finds_the_transaction_by_words_inside_its_receipt(self):
        # The whole point of the feature: the fact that answers "what was actually done to the car"
        # exists only on the document, and is now reachable from the ledger.
        self.assertEqual(self.quick_filter("doc:brake"), ["txn-repair"])
        self.assertEqual(self.quick_filter("doc:rotors"), ["txn-repair"])

    def test_terms_match_by_prefix_and_several_terms_are_an_and(self):
        # Every other quick-filter facet is a substring match, so exact-word-only here would behave
        # differently from the box it shares.
        self.assertEqual(self.quick_filter("doc:brak"), ["txn-repair"])
        self.assertEqual(self.quick_filter("doc:brake rotors"), ["txn-repair"])
        self.assertEqual(self.quick_filter("doc:brake espresso"), [])

    def test_the_plain_search_box_reaches_inside_documents_and_says_so(self):
        # Searching a word that exists only inside an attached receipt has to work from the box people
        # actually type in — the first thing anyone does after attaching one. The objection to folding
        # it in was that the hit has no visible cause, so the row carries the cause instead: rows that
        # matched this way are flagged, and the ledger marks them.
        rows = self.list_rows("brake")
        self.assertEqual([r["id"] for r in rows], ["txn-repair"])
        self.assertTrue(rows[0]["matched_document"])

    def test_a_row_matched_on_a_visible_field_is_not_flagged_as_a_document_match(self):
        # The flag is a *reason*, so it must not fire for a row the search found by its payee. Marking
        # one would send the reader looking for an attachment that had nothing to do with the match.
        rows = self.list_rows("Garage")
        self.assertEqual([r["id"] for r in rows], ["txn-repair"])
        self.assertFalse(rows[0]["matched_document"])

    def test_a_field_scoped_search_carries_no_document_reason_at_all(self):
        # `merchant:` has no document component, so its rows must not be projected as document matches.
        rows = self.list_rows("merchant:Garage")
        self.assertEqual([r["id"] for r in rows], ["txn-repair"])
        self.assertNotIn("matched_document", rows[0])

    def test_doc_prefix_still_searches_documents_only(self):
        # The prefix keeps its own job: documents *only*, so a term that appears on the row but not in
        # any attachment finds nothing.
        self.assertEqual(self.quick_filter("doc:Garage"), [])

    def test_a_term_that_appears_in_no_document_matches_nothing(self):
        self.assertEqual(self.quick_filter("doc:espresso"), [])

    def test_query_syntax_typed_into_the_box_is_treated_as_text(self):
        # FTS5 MATCH is a query language: unbalanced quotes and bare operators raise, which would
        # surface as a 500 from an ordinary typo. Every token is quoted, so these are searches, not
        # syntax — and `AND`, a real word on a real receipt, searches for itself.
        for probe in ('doc:"unbalanced', "doc:*", "doc:AND", "doc:^", "doc:(west)", "doc:a:b"):
            with self.subTest(probe=probe):
                self.assertIsInstance(self.quick_filter(probe), list)
        self.assertEqual(self.quick_filter("doc:repair"), ["txn-repair"])

    def test_the_ledger_row_carries_its_documents_for_the_marker(self):
        result = list_transactions(
            month=None, date_start=None, date_end=None, import_batch_id=None,
            sort_by="date", sort_dir="desc", account_id=None, category_id=None,
            direction=None, view=None, search=None, quick_filter=None,
            include_trashed=False, limit=50, offset=0,
        )
        by_id = {row["id"]: row for row in result["transactions"]}
        self.assertEqual(by_id["txn-repair"]["document_count"], 1)
        self.assertEqual(by_id["txn-coffee"]["document_count"], 0)
        self.assertEqual(by_id["txn-coffee"]["documents"], [])

        # Enough to name a document, choose a viewer for it and open it — carried inline so the ledger's
        # marker opens without a fetch.
        attached = by_id["txn-repair"]["documents"][0]
        self.assertEqual(attached["filename"], "invoice.pdf")
        self.assertEqual(attached["mime_type"], "application/pdf")
        # Never the extracted text: it can run to hundreds of kilobytes and no list surface renders it.
        self.assertNotIn("text", attached)

    def test_deleting_a_document_takes_it_out_of_the_index(self):
        document = list_transaction_documents("txn-repair")["documents"][0]
        delete_document_permanently(document["id"])
        self.assertEqual(self.quick_filter("doc:brake"), [])

    def test_a_detached_document_no_longer_finds_its_former_transaction(self):
        # The index follows the row's text, and a stored document's text belongs to no transaction — so the
        # ledger search must stop returning the row it was taken off.
        document = list_transaction_documents("txn-repair")["documents"][0]
        detach_document(document["id"])
        self.assertEqual(self.quick_filter("doc:brake"), [])

    def test_purging_the_transaction_takes_its_document_out_of_the_index(self):
        # The index is maintained by triggers precisely because this delete is a cascade no application
        # code sees. An index that missed it would keep returning a transaction that no longer exists.
        with get_db() as conn:
            conn.execute("DELETE FROM txn WHERE id = 'txn-repair'")
        self.assertEqual(self.quick_filter("doc:brake"), [])


class StoredDocumentTests(DocumentsApiTestCase):
    """Documents kept before their transaction exists, and moved on and off one."""

    def stored_ids(self):
        return [d["id"] for d in list_stored()["documents"]]

    def test_a_stored_document_belongs_to_no_transaction_and_is_served_like_any_other(self):
        pdf = make_text_pdf(INVOICE_LINES)
        document = self.store(pdf, "invoice.pdf", "application/pdf")["document"]

        self.assertIsNone(document["txn_id"])
        self.assertEqual(self.stored_ids(), [document["id"]])
        self.assertEqual(Path(get_document_file(document["id"]).path), document_file_path(document["id"]))
        # Not on any ledger row, so it must not make one match a search either.
        self.assertEqual(self.quick_filter("doc:brake"), [])

    def test_storing_the_same_file_twice_is_reported_rather_than_stored_twice(self):
        pdf = make_text_pdf(INVOICE_LINES)
        first = self.store(pdf, "invoice.pdf", "application/pdf")
        again = self.store(pdf, "invoice (1).pdf", "application/pdf")

        self.assertTrue(again["already_stored"])
        self.assertEqual(again["document"]["id"], first["document"]["id"])
        self.assertEqual(len(self.stored_ids()), 1)

    def test_attaching_a_stored_document_moves_it_without_touching_the_file(self):
        pdf = make_text_pdf(INVOICE_LINES)
        document = self.store(pdf, "invoice.pdf", "application/pdf")["document"]

        result = attach_stored_document(document["id"], DocumentTarget(txn_id="txn-repair"))

        self.assertFalse(result["already_attached"])
        self.assertEqual(result["document"]["id"], document["id"])
        self.assertEqual(result["document"]["txn_id"], "txn-repair")
        self.assertEqual(self.stored_ids(), [])
        self.assertEqual([d["id"] for d in list_transaction_documents("txn-repair")["documents"]], [document["id"]])
        self.assertEqual(document_file_path(document["id"]).read_bytes(), pdf)
        # Search follows the move: the text now explains a ledger row.
        self.assertEqual(self.quick_filter("doc:brake"), ["txn-repair"])

    def test_detaching_returns_a_document_to_the_store_intact(self):
        # The undoable way off a transaction, for a receipt attached to the wrong row.
        document = self.attach("txn-repair", make_text_pdf(INVOICE_LINES), "invoice.pdf", "application/pdf")["document"]

        result = detach_document(document["id"])

        self.assertEqual(result, {"document": {**document, "txn_id": None}, "already_stored": False})
        self.assertEqual(list_transaction_documents("txn-repair")["documents"], [])
        self.assertEqual(self.stored_ids(), [document["id"]])
        attach_stored_document(document["id"], DocumentTarget(txn_id="txn-coffee"))
        self.assertEqual([d["id"] for d in list_transaction_documents("txn-coffee")["documents"]], [document["id"]])

    def test_a_move_onto_an_identical_file_folds_the_moved_copy_into_it(self):
        pdf = make_text_pdf(INVOICE_LINES)
        attached = self.attach("txn-repair", pdf, "invoice.pdf", "application/pdf")["document"]
        stored = self.store(pdf, "invoice-from-email.pdf", "application/pdf")["document"]

        result = attach_stored_document(stored["id"], DocumentTarget(txn_id="txn-repair"))

        # The copy already on the transaction stays, under its own name; the stored one is gone, file too.
        self.assertTrue(result["already_attached"])
        self.assertEqual(result["document"]["id"], attached["id"])
        self.assertEqual([d["id"] for d in list_transaction_documents("txn-repair")["documents"]], [attached["id"]])
        self.assertEqual(self.stored_ids(), [])
        self.assertFalse(document_file_path(stored["id"]).exists())
        self.assertTrue(document_file_path(attached["id"]).exists())

    def test_detaching_onto_an_identical_stored_file_folds_it_the_same_way(self):
        pdf = make_text_pdf(INVOICE_LINES)
        stored = self.store(pdf, "invoice.pdf", "application/pdf")["document"]
        attached = self.attach("txn-repair", pdf, "invoice.pdf", "application/pdf")["document"]

        result = detach_document(attached["id"])

        self.assertTrue(result["already_stored"])
        self.assertEqual(self.stored_ids(), [stored["id"]])
        self.assertFalse(document_file_path(attached["id"]).exists())

    def test_a_document_on_another_transaction_cannot_be_taken_by_attaching(self):
        # No surface moves a receipt straight between transactions; a request that tries must not quietly
        # take it off the row it is on.
        document = self.attach("txn-repair", make_text_pdf(INVOICE_LINES), "invoice.pdf", "application/pdf")["document"]

        with self.assertRaises(HTTPException) as ctx:
            attach_stored_document(document["id"], DocumentTarget(txn_id="txn-coffee"))

        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual([d["id"] for d in list_transaction_documents("txn-repair")["documents"]], [document["id"]])

    def test_attaching_needs_a_real_document_and_a_real_transaction(self):
        document = self.store(make_text_pdf(INVOICE_LINES), "invoice.pdf", "application/pdf")["document"]
        for document_id, txn_id in ((document["id"], "no-such-txn"), ("no-such-document", "txn-repair")):
            with self.assertRaises(HTTPException) as ctx:
                attach_stored_document(document_id, DocumentTarget(txn_id=txn_id))
            self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(self.stored_ids(), [document["id"]])

    def test_a_stored_text_document_can_be_edited_and_stays_stored(self):
        document = self.store(b"Brake pads 249.50", "documentation.txt", "text/plain")["document"]

        replacement = edit_document_text(document["id"], DocumentText(text="Brake pads 249.50 (final)"))["document"]

        self.assertIsNone(replacement["txn_id"])
        self.assertEqual(self.stored_ids(), [replacement["id"]])

    def test_deleting_a_stored_document_removes_it_and_its_file(self):
        document = self.store(make_text_pdf(INVOICE_LINES), "invoice.pdf", "application/pdf")["document"]
        delete_document_permanently(document["id"])
        self.assertEqual(self.stored_ids(), [])
        self.assertFalse(document_file_path(document["id"]).exists())


class RenameTests(DocumentsApiTestCase):
    def test_a_document_can_be_renamed_attached_or_stored(self):
        attached = self.attach("txn-repair", make_text_pdf(INVOICE_LINES), "invoice.pdf", "application/pdf")["document"]
        stored = self.store(b"Brake pads 249.50", "documentation.txt", "text/plain")["document"]

        self.assertEqual(rename(attached["id"], DocumentName(filename="Brake job.pdf"))["document"]["filename"], "Brake job.pdf")
        self.assertEqual(rename(stored["id"], DocumentName(filename="  Garage quote.txt "))["document"]["filename"],
                         "Garage quote.txt")
        # The download offers the new name, which is the one thing a name is used for besides display.
        self.assertIn('filename="Brake job.pdf"', get_document_file(attached["id"], download=True).headers["content-disposition"])

    def test_a_name_is_reduced_like_an_uploads_and_cannot_be_emptied(self):
        document = self.store(b"Brake pads 249.50", "documentation.txt", "text/plain")["document"]

        self.assertEqual(rename(document["id"], DocumentName(filename="../../etc/quote.txt"))["document"]["filename"], "quote.txt")
        for blank in ("", "   "):
            with self.assertRaises(HTTPException) as ctx:
                rename(document["id"], DocumentName(filename=blank))
            self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(list_stored()["documents"][0]["filename"], "quote.txt")

    def test_renaming_an_unknown_document_is_a_404(self):
        with self.assertRaises(HTTPException) as ctx:
            rename("no-such-document", DocumentName(filename="x.pdf"))
        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()

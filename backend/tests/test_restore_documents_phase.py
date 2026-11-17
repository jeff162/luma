"""The restore's documents phase, and the marker that makes it survivable.

A restore commits the ledger atomically and then writes files, which are not transactional. Everything
here is about that gap: what the marker says while a restore is in flight, what it says afterwards, what
it refuses in between, and whether an interrupted phase can actually be finished.

The failure this guards against is not loud. A restore that commits and then dies leaves a ledger full
of attachments with no files behind them and nothing recording why — every one of them a broken link,
indistinguishable from data loss.
"""

from __future__ import annotations

import asyncio
import io
import uuid
import zipfile
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

from backend.db.database import get_db
from backend.routers.import_export.backup import (
    RESTORE_PHASE_DOCUMENTS,
    RESTORE_PHASE_STAGING,
    resume_restore_documents,
    restore_backup_file,
    restore_from_archive,
    restore_state_status,
    write_backup_archive,
)
from backend.services.documents import document_file_path, write_document_file
from backend.services.restore_state import (
    get_restore_state,
    require_no_pending_restore,
    set_restore_state,
)
from backend.tests.test_backup_restore import UPLOAD_REQUEST, BackupFixtureTestCase


class RestoreDocumentsPhaseTests(BackupFixtureTestCase):
    def _write_archive(self) -> bytes:
        with self._use_db_path():
            with get_db() as conn:
                buf = io.BytesIO()
                write_backup_archive(conn, buf)
        return buf.getvalue()

    def _staged_archive(self, archive_bytes: bytes) -> str:
        """The archive on disk, standing in for the staging file a real upload leaves behind."""
        path = Path(self.tempdir.name) / f"staged-{uuid.uuid4()}.zip"
        path.write_bytes(archive_bytes)
        return str(path)

    def _state(self):
        with self._use_db_path():
            with get_db() as conn:
                return get_restore_state(conn)

    def test_a_completed_restore_leaves_no_marker_and_no_staged_artifact(self):
        # The ordinary path: the phase runs to completion inside the same request, so by the time the
        # caller sees a result there is nothing outstanding and the staged copy of their backup — which
        # only existed so an interruption could be resumed — is gone.
        #
        # Driven through the upload endpoint rather than `restore_from_archive`, because the endpoint is
        # what opens the staging file and therefore what deletes it. Asserting the deletion anywhere
        # further in would be asserting it of something that no longer owns the handle.
        self._seed_complete()
        archive = self._write_archive()

        with self._use_db_path():
            asyncio.new_event_loop().run_until_complete(restore_backup_file(
                request=UPLOAD_REQUEST,
                file=self._upload(archive, "luma_backup.zip"),
                private_key_file=None,
                private_key_passphrase=None,
                force=False,
            ))

        self.assertIsNone(self._state())
        self.assertEqual(list(Path(self.tempdir.name).glob(".restore-staging-*")), [])

    def test_the_phase_does_not_delete_an_archive_its_caller_still_holds_open(self):
        # The Windows bug this ordering exists for. `_restore_documents` used to unlink the staged
        # artifact itself, as its last act — while the caller's `ZipFile` was still open on that very
        # file. POSIX allows that (the name goes, the inode lives until the handle closes); Windows
        # refuses it with WinError 32 and reported a restore that had fully committed as a 500.
        #
        # The suite does not run on Windows, so the rule is emulated: a delete aimed at a file this test
        # still holds open raises exactly as Windows would. Nothing here is platform-specific — the
        # invariant is that the phase never deletes what its caller is holding, whoever enforces it.
        self._seed_complete()
        staged = self._staged_archive(self._write_archive())
        real_unlink = Path.unlink
        held = []

        def windows_unlink(target, *args, **kwargs):
            if str(target) == staged and any(not handle.closed for handle in held):
                raise PermissionError(
                    32, "The process cannot access the file because it is being used by another process"
                )
            return real_unlink(target, *args, **kwargs)

        with self._use_db_path(), mock.patch.object(Path, "unlink", windows_unlink):
            with open(staged, "rb") as handle:
                held.append(handle)
                with zipfile.ZipFile(handle) as zf:
                    restore_from_archive(zf, force=False, artifact_path=staged)

        # Committed and finished: the marker is clear, so the artifact is released for its owner to
        # delete — which on the real path is the endpoint, once its handle is closed.
        self.assertIsNone(self._state())
        Path(staged).unlink(missing_ok=True)

    def test_an_interrupted_phase_leaves_a_marker_naming_what_is_owed(self):
        # The crash case, simulated by committing the ledger and then not running the documents phase.
        # What must survive is the *documents_pending* marker: the ledger is live and correct, and the
        # only record that its files are not all there is this row.
        self._seed_complete()
        staged = self._staged_archive(self._write_archive())

        with self._use_db_path():
            # Model a restore onto a machine that does not already hold the files. Without this the
            # fixture's own file is still on disk — correctly, since the directory is deliberately not
            # cleared up front — and only the one it never had would be outstanding.
            document_file_path(self.present_document).unlink()
            with zipfile.ZipFile(staged) as zf:
                self._restore_without_documents(zf, staged)

            with get_db() as conn:
                state = get_restore_state(conn)
            self.assertEqual(state["phase"], RESTORE_PHASE_DOCUMENTS)
            self.assertEqual(state["artifact_path"], staged)

            status = restore_state_status()
        self.assertEqual(status["phase"], RESTORE_PHASE_DOCUMENTS)
        # Both documents are outstanding: the ledger names them, the store has neither.
        self.assertEqual(status["documents_pending"], 2)
        self.assertTrue(status["artifact_available"])

    def test_resuming_writes_the_documents_and_clears_the_marker(self):
        self._seed_complete()
        staged = self._staged_archive(self._write_archive())

        with self._use_db_path():
            document_file_path(self.present_document).unlink()
            with zipfile.ZipFile(staged) as zf:
                self._restore_without_documents(zf, staged)
            # Nothing on disk yet — the resume has to do the whole phase from the staged artifact.
            self.assertFalse(document_file_path(self.present_document).exists())

            result = resume_restore_documents()

            # The attached document and the stored one.
            self.assertEqual(result["documents"]["restored"], 2)
            self.assertEqual(document_file_path(self.present_document).read_bytes(), self.document_bytes)
        self.assertIsNone(self._state())
        # The staged artifact is released only once the phase it existed for is over.
        self.assertFalse(Path(staged).exists())

    def test_a_pending_phase_refuses_the_operations_that_would_race_it(self):
        # An import, a sync or a second restore during the gap either races the file writes or is erased
        # by the sweep that ends the phase, which reconciles the directory against the ledger.
        with self._use_db_path():
            with get_db() as conn:
                set_restore_state(conn, RESTORE_PHASE_DOCUMENTS, "/tmp/whatever.zip", "id@when")
            with get_db() as conn:
                with self.assertRaises(HTTPException) as ctx:
                    require_no_pending_restore(conn, "importing")
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(ctx.exception.detail["code"], "restore_documents_pending")

    def test_a_pending_phase_refuses_a_document_upload_before_it_writes_a_file(self):
        # The phase ends with a sweep that keeps no grace period, so a file an upload writes before its row
        # lands would be swept from under it.
        from fastapi import UploadFile
        from starlette.datastructures import Headers

        from backend.routers.documents import store_document
        from backend.services.documents import stored_document_ids

        with self._use_db_path():
            with get_db() as conn:
                set_restore_state(conn, RESTORE_PHASE_DOCUMENTS, "/tmp/whatever.zip", "id@when")
            before = stored_document_ids()
            upload = UploadFile(file=io.BytesIO(b"Receipt for one coffee"), filename="receipt.txt",
                                headers=Headers({"content-type": "text/plain"}))
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(store_document(upload))
            self.assertEqual(stored_document_ids(), before)
        self.assertEqual(ctx.exception.detail["code"], "restore_documents_pending")

    def test_a_second_restore_is_refused_while_one_is_in_flight(self):
        self._seed_complete()
        archive = self._write_archive()
        with self._use_db_path():
            with get_db() as conn:
                set_restore_state(conn, RESTORE_PHASE_STAGING, None, "id@when")
            with self.assertRaises(HTTPException) as ctx:
                with zipfile.ZipFile(io.BytesIO(archive)) as zf:
                    restore_from_archive(zf, force=True)
        self.assertEqual(ctx.exception.status_code, 409)

    def test_a_failed_restore_releases_the_slot_because_nothing_was_changed(self):
        # `staging` means the restore never committed, so the row is stale rather than informative:
        # leaving it would lock the app out of restoring at all after one bad archive.
        self._seed_complete()
        broken = self._rewrite_member(self._write_archive(), "sections/owners.ndjson", b"not json\n")

        with self.assertRaises(HTTPException):
            with self._use_db_path():
                with zipfile.ZipFile(io.BytesIO(broken)) as zf:
                    restore_from_archive(zf, force=True)

        self.assertIsNone(self._state())

    def test_resuming_without_the_artifact_says_so_instead_of_guessing(self):
        # Resuming needs the source. If it is gone, the honest answer is to ask for the same backup
        # again — silently filling the document directory from a different artifact is the outcome the
        # recorded identity exists to prevent.
        with self._use_db_path():
            with get_db() as conn:
                set_restore_state(conn, RESTORE_PHASE_DOCUMENTS, "/nonexistent/backup.zip", "id@when")
            with self.assertRaises(HTTPException) as ctx:
                resume_restore_documents()
        self.assertEqual(ctx.exception.detail["code"], "artifact_missing")

    def test_resuming_with_nothing_pending_is_refused(self):
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                resume_restore_documents()
        self.assertEqual(ctx.exception.detail["code"], "no_documents_pending")

    def test_resuming_only_writes_what_is_actually_missing(self):
        # There is no progress cursor anywhere in this design: "what is left" is a comparison between
        # the committed ledger and the directory. This pins that it catches a *torn* file, which a
        # position counter would skip straight past.
        self._seed_complete()
        staged = self._staged_archive(self._write_archive())

        with self._use_db_path():
            with zipfile.ZipFile(staged) as zf:
                self._restore_without_documents(zf, staged)
            # Half-written, as an interrupted phase would leave it.
            write_document_file(self.present_document, self.document_bytes[:5])
            with get_db():
                pending_before = restore_state_status()["documents_pending"]

            resume_restore_documents()

            self.assertEqual(document_file_path(self.present_document).read_bytes(), self.document_bytes)
        self.assertEqual(pending_before, 2)

    def _restore_without_documents(self, zf, staged):
        """A restore that commits its ledger and then stops — the crash the marker exists for.

        Deliberately not mocked at the function level: this replays the real sequence (preflight, claim
        the slot, run the sections, which writes `documents_pending` inside its own transaction) and
        simply never calls the documents phase, which is exactly what an interruption looks like.
        """
        from backend.routers.import_export.backup import (
            _begin_restore,
            _read_archive_meta,
            _restore_preflight,
            _restore_sections,
            read_archive_section,
            verify_archive_members,
        )

        meta = _read_archive_meta(zf)
        verify_archive_members(zf, meta)
        _restore_preflight(meta, True)
        _begin_restore(meta, staged)
        with get_db() as conn:
            _restore_sections(conn, meta, lambda section: read_archive_section(zf, section),
                              meta.get("version"), preference_owners=set())

    @staticmethod
    def _rewrite_member(archive_bytes: bytes, member: str, content: bytes) -> bytes:
        out = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as src, zipfile.ZipFile(out, "w") as dst:
            for name in src.namelist():
                dst.writestr(name, content if name == member else src.read(name))
        return out.getvalue()

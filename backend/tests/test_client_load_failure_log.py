"""
`POST /api/diagnostics/log/client`: a browser reporting that a view's load failed.

It is the one place a signed-in user's input reaches the server log, so the protections are what is
pinned: a note is one line of printable text, marked as client-reported, and a user's notes are
rate-limited, since the log is capped and a flood would rotate the real errors out of it.
"""

import unittest
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

from backend.routers import diagnostics


def _request(user_id="u1"):
    return SimpleNamespace(state=SimpleNamespace(user={"id": user_id}))


class ClientLoadFailureLogTests(unittest.TestCase):
    def setUp(self):
        diagnostics._client_notes.clear()
        self.warning = mock.patch.object(diagnostics, "log_warning").start()
        self.error = mock.patch.object(diagnostics, "log_error").start()
        self.addCleanup(mock.patch.stopall)

    def test_a_note_is_one_marked_line(self):
        body = diagnostics.ClientLoadFailure(
            view="Net worth", path="/accounts/net-worth/monthly", status=500,
            message="boom\nERROR uvicorn.error: Traceback (most recent call last): x", recovered=False,
        )
        diagnostics.log_client_load_failure(body, _request())
        self.warning.assert_not_called()
        line = self.error.call_args.args[0]
        self.assertTrue(line.startswith("[client-reported] Net worth failed to load"))
        self.assertNotIn("\n", line)
        self.assertNotIn(" ", line)

    def test_a_recovered_load_is_a_warning(self):
        body = diagnostics.ClientLoadFailure(view="Trends", recovered=True)
        diagnostics.log_client_load_failure(body, _request())
        self.error.assert_not_called()
        self.assertIn("succeeded on retry", self.warning.call_args.args[0])

    def test_fields_are_capped(self):
        body = diagnostics.ClientLoadFailure(view="v" * 5000, message="m" * 5000, recovered=True)
        diagnostics.log_client_load_failure(body, _request())
        self.assertLess(len(self.warning.call_args.args[0]), 1000)

    def test_a_flood_is_dropped_per_user(self):
        body = diagnostics.ClientLoadFailure(view="Trends", recovered=True)
        for _ in range(diagnostics.CLIENT_NOTE_LIMIT):
            diagnostics.log_client_load_failure(body, _request("u1"))
        with self.assertRaises(HTTPException) as raised:
            diagnostics.log_client_load_failure(body, _request("u1"))
        self.assertEqual(raised.exception.status_code, 429)
        self.assertEqual(self.warning.call_count, diagnostics.CLIENT_NOTE_LIMIT)
        # Another user's notes are not held back by the first one's.
        diagnostics.log_client_load_failure(body, _request("u2"))
        self.assertEqual(self.warning.call_count, diagnostics.CLIENT_NOTE_LIMIT + 1)


if __name__ == "__main__":
    unittest.main()

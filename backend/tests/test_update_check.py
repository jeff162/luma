"""
Checking for a new version (`services/update_check.py`), through the full stack.

The release list is never contacted: every test stands in for `_fetch_latest_tag`, and the ones about
*whether* a request is made count the calls to that stand-in.
"""

from __future__ import annotations

import unittest
import urllib.error
from unittest import mock

from backend import runtime_config
from backend.services import update_check
from backend.tests._api_client import api_client


class UpdateCheckTests(unittest.TestCase):
    def setUp(self):
        client_cm = api_client()
        self.client, _ = client_cm.__enter__()
        self.addCleanup(client_cm.__exit__, None, None, None)
        version = mock.patch.object(runtime_config, "APP_VERSION", "1.2.0")
        version.start()
        self.addCleanup(version.stop)
        fetch = mock.patch.object(update_check, "_fetch_latest_tag", return_value="v1.2.0")
        self.fetch = fetch.start()
        self.addCleanup(fetch.stop)

    def _enable(self):
        self.assertEqual(
            self.client.post("/api/app/update-check/settings", json={"enabled": True}).status_code, 200)

    def _auto(self) -> dict:
        response = self.client.post("/api/app/update-check/auto")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def _task(self) -> dict | None:
        tasks = self.client.get("/api/tasks").json()["tasks"]
        return next((t for t in tasks if t["id"] == "update_available"), None)

    def _age_the_watermark(self):
        update_check.set_app_setting(update_check.ATTEMPTED_AT_KEY, "2000-01-01T00:00:00")

    def test_nothing_is_requested_until_the_check_is_switched_on(self):
        self.assertFalse(self._auto()["enabled"])
        self.fetch.assert_not_called()

    def test_the_interval_limits_requests_even_after_a_failure(self):
        self._enable()
        self.fetch.side_effect = urllib.error.URLError("no route out")
        self._auto()
        self._auto()
        self.assertEqual(self.fetch.call_count, 1)
        self._age_the_watermark()
        self._auto()
        self.assertEqual(self.fetch.call_count, 2)

    def test_a_newer_release_raises_a_task_and_the_same_or_an_older_one_does_not(self):
        self._enable()
        self.assertIsNone(self._auto()["available_version"])
        self.assertIsNone(self._task())
        for tag, expected in (("v1.1.9", None), ("v1.10.0", "1.10.0")):
            self.fetch.return_value = tag
            self._age_the_watermark()
            self.assertEqual(self._auto()["available_version"], expected)
        self.assertIsNotNone(self._task())

    def test_dismissing_covers_one_release_and_the_next_one_returns(self):
        self._enable()
        self.fetch.return_value = "v1.3.0"
        self._auto()
        key = self._task()["dismiss_key"]
        self.assertEqual(self.client.post(f"/api/tasks/dismiss/{key}").status_code, 200)
        self.assertIsNone(self._task())
        self.fetch.return_value = "v1.4.0"
        self._age_the_watermark()
        self._auto()
        self.assertIsNotNone(self._task())

    def test_an_answer_that_is_not_a_version_is_ignored_and_keeps_what_was_known(self):
        self._enable()
        self.fetch.return_value = "v1.3.0"
        self._auto()
        for bad in ("", "latest", "v1.3", "v9.9.9-rc1", "https://example.com/v9.9.9"):
            self.fetch.return_value = bad
            ran = self.client.post("/api/app/update-check/run").json()
            self.assertFalse(ran["reached"])
            self.assertEqual(ran["available_version"], "1.3.0")

    def test_check_now_works_with_the_automatic_check_off_but_raises_no_task(self):
        self.fetch.return_value = "v1.3.0"
        ran = self.client.post("/api/app/update-check/run").json()
        self.assertTrue(ran["reached"])
        self.assertEqual(ran["available_version"], "1.3.0")
        self.assertIsNone(self._task())


if __name__ == "__main__":
    unittest.main()

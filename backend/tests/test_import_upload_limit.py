"""
The import file-size ceiling (`core.MAX_IMPORT_FILE_BYTES`) on an uploaded file.

Pinned on the preview, the first thing a dropped file reaches: a file past the ceiling is refused with a
message naming it, and one at the ceiling is still read.
"""

from __future__ import annotations

import unittest
from unittest import mock

from backend.routers.import_export import core
from backend.tests._api_client import api_client

CSV = b"Date,Description,Amount\n2026-01-02,Coffee,-4.50\n"


class ImportUploadLimitTest(unittest.TestCase):
    def _preview(self, ceiling):
        with mock.patch.object(core, "MAX_IMPORT_FILE_BYTES", ceiling), api_client() as (client, _):
            return client.post("/api/import-export/preview", files={"file": ("statement.csv", CSV, "text/csv")})

    def test_a_file_past_the_ceiling_is_refused_by_name(self):
        refused = self._preview(len(CSV) - 1)
        self.assertEqual(refused.status_code, 413)
        self.assertIn("statement.csv", refused.json()["detail"])

    def test_a_file_at_the_ceiling_is_read(self):
        self.assertEqual(self._preview(len(CSV)).status_code, 200)


if __name__ == "__main__":
    unittest.main()

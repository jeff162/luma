"""`safe_json_dict` over both shapes a stored blob reaches a reader in.

These blobs nest. A `config_snapshot` or a `column_map` comes out of the database as text, and every
member of it is a real `dict` once that outer parse has happened — so the same walk meets both forms,
and a helper that only accepted text answered `{}` for the parsed one. That failure is silent by
construction, because an empty mapping is indistinguishable from a legitimately-absent blob, and it
was live in three unrelated subsystems at once: the imported-category scope filter read back as
unset (so a restriction to one owner applied the file's categories to everyone), a data source could
never find a historical batch to adopt, and a batch's created single account never reached the client.
A fourth place had already hit it and worked around it locally, which is why the tolerance now lives
in the helper instead.
"""

from __future__ import annotations

import unittest

from backend.json_utils import safe_json_dict


class SafeJsonDictTests(unittest.TestCase):
    def test_a_parsed_mapping_passes_through(self):
        self.assertEqual(safe_json_dict({"scope_mode": "filtered"}), {"scope_mode": "filtered"})

    def test_a_json_object_is_parsed(self):
        self.assertEqual(safe_json_dict('{"scope_mode": "filtered"}'), {"scope_mode": "filtered"})

    def test_the_result_is_the_caller_s_to_mutate(self):
        """Callers edit what they get back (the profile update path rewrites a column map in place), and
        with a string argument they always received a fresh dict. A mapping argument must not hand back
        the caller's own object, or an edit to the copy would reach through to the source."""
        source = {"date": "Date"}
        returned = safe_json_dict(source)
        returned["date"] = "Posted"
        self.assertEqual(source["date"], "Date")

    def test_absent_and_empty_are_an_empty_dict(self):
        for value in (None, "", {}, "null"):
            with self.subTest(value=value):
                self.assertEqual(safe_json_dict(value), {})

    def test_a_non_object_payload_is_normalized_away(self):
        """The point of the helper: a caller may treat the result as a mapping without re-checking."""
        for value in ("[1, 2]", '"text"', "7", "not json at all", 7, [1, 2]):
            with self.subTest(value=value):
                self.assertEqual(safe_json_dict(value), {})


if __name__ == "__main__":
    unittest.main()

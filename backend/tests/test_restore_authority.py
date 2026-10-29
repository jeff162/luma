"""
The backup, restore and watched-folder operations that need an admin once sign-in protection is on.

A restore is not a data edit: it replaces every row, the connections and the provider configuration at once.
Before this, any signed-in member could run one — including the standalone credentials restore, which replaces
global provider configuration that is otherwise an admin's alone to change. The backup keys are held to the
same bar because they decide who can read a backup at all, and creating a backup is held to it so the
server agrees with the Settings section that offers it. Pointing a data source at a **watched folder**
is here for a different reason of the same shape: it names a directory on the server's filesystem, which is
global app configuration rather than ledger data, and the folder can be set to delete the files it imports.
The folder *picker* that fills that field in is held to the same bar, for the same reason.
The database check, its repair and compaction are an administrator's too (Settings -> Database), since each
acts on the files of the whole installation rather than on ledger data, and so is clearing what imports kept
of the rows they refused, the one ledger operation held to the gate (`docs/security-model.md`).

Checked over HTTP rather than by calling the router functions, because the guard is a route dependency and
a direct call never passes through it. Each request is shaped to get past body validation, so a refusal
can only have come from the guard.
"""

from __future__ import annotations

import unittest

from backend.tests._api_client import api_client

GUARDED = [
    ("get", "/api/import-export/backup", {}),
    ("get", "/api/import-export/backup/status", {}),
    ("post", "/api/import-export/restore", {"json": {"data": {}}}),
    ("post", "/api/import-export/restore-file", {"files": {"file": ("backup.zip", b"not a backup", "application/zip")}}),
    ("post", "/api/import-export/restore/resume-documents", {}),
    ("post", "/api/import-export/restore/credentials", {"json": {"data": {}}}),
    ("post", "/api/import-export/restore/credentials-file", {"files": {"file": ("credentials.json", b"{}", "application/json")}}),
    ("post", "/api/import-export/backup/recipients", {"json": {"label": "Offsite", "public_key": "not a key"}}),
    ("patch", "/api/import-export/backup/recipients/missing", {"json": {"enabled": False}}),
    ("delete", "/api/import-export/backup/recipients/missing", {}),
    ("patch", "/api/import-export/profiles/missing/watch", {"json": {"watch_dir": "/tmp/statements"}}),
    # Listing the server's folders is held to the same bar as naming one: it reads a filesystem that is
    # not the ledger, and it is the sharper of the two for anyone who should not be reading it at all.
    ("get", "/api/import-export/watch/browse?path=/tmp", {}),
    # Settings -> Database: repairing or compacting locks a database for everyone.
    ("get", "/api/diagnostics/database", {}),
    ("get", "/api/diagnostics/database/check", {}),
    ("post", "/api/diagnostics/database/repair-indexes", {}),
    ("post", "/api/diagnostics/database/compact", {}),
    # Clearing what imports kept: the one ledger operation held to the admin gate.
    ("post", "/api/import-export/batches/clear-detail", {"json": {"batch_ids": []}}),
]

ADMIN_PASSWORD = "admin-password-123"
MEMBER_PASSWORD = "member-password-123"


class RestoreAuthorityTests(unittest.TestCase):
    def _turn_sign_in_on(self, client) -> None:
        """The harness's own identity becomes the admin; a second identity becomes a member with a password."""
        admin_id = client.get("/api/auth/me").json()["user"]["id"]
        client.post("/api/auth/identities", json={"name": "Sam"})
        enabled = client.post("/api/auth/enable", json={
            "enabled": True, "claim_user_id": admin_id, "admin_password": ADMIN_PASSWORD, "initial_passwords": {},
        })
        self.assertEqual(enabled.status_code, 200, enabled.text)
        client.post("/api/auth/logout")
        claimed = client.post("/api/auth/login", json={"username": "Sam", "password": ""})
        self.assertEqual(claimed.status_code, 200, claimed.text)
        changed = client.post("/api/auth/change-password", json={"new_password": MEMBER_PASSWORD})
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(changed.json()["user"]["role"], "member")

    def _sign_in(self, client, username: str, password: str) -> None:
        client.post("/api/auth/logout")
        signed_in = client.post("/api/auth/login", json={"username": username, "password": password})
        self.assertEqual(signed_in.status_code, 200, signed_in.text)

    def test_a_member_is_refused_every_backup_every_restore_path_and_every_backup_key_change(self):
        with api_client() as (client, _):
            self._turn_sign_in_on(client)
            for method, path, kwargs in GUARDED:
                with self.subTest(f"{method.upper()} {path}"):
                    response = getattr(client, method)(path, **kwargs)
                    self.assertEqual(response.status_code, 403, response.text)
            # Reading stays open: a member can still see which keys a backup will be sealed to.
            self.assertEqual(client.get("/api/import-export/backup/recipients").status_code, 200)

    def test_an_admin_gets_past_the_guard(self):
        with api_client() as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in(client, "Tester", ADMIN_PASSWORD)
            for method, path, kwargs in GUARDED:
                with self.subTest(f"{method.upper()} {path}"):
                    self.assertNotEqual(getattr(client, method)(path, **kwargs).status_code, 403)

    def test_with_sign_in_off_there_is_no_role_to_hold(self):
        with api_client() as (client, _):
            for method, path, kwargs in GUARDED:
                with self.subTest(f"{method.upper()} {path}"):
                    self.assertNotEqual(getattr(client, method)(path, **kwargs).status_code, 403)


if __name__ == "__main__":
    unittest.main()

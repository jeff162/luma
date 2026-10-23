"""Settings -> About -> Copy details: what the server says about the installation for a bug report.

Pinned because the reply is pasted into public issues. It has to name how the copy runs, and it must not
grow a field that identifies the machine or its data.
"""

import unittest
from unittest import mock

from backend import runtime_config
from backend.db import database
from backend.tests._api_client import api_client

EXPECTED_FIELDS = {
    "version", "build", "form", "reachable_from_network", "request_is_loopback", "request_is_https",
    "sign_in_required", "server_platform", "python_version", "connection_providers",
}


class InstallationDetailsTests(unittest.TestCase):
    def test_a_checkout_reports_itself_and_the_kinds_of_connection_only(self):
        with api_client() as (client, data_path):
            with database.get_db(data_path) as conn:
                conn.execute(
                    "INSERT INTO connection (id, provider, external_id, institution) VALUES (?,?,?,?)",
                    ("conn-1", "simplefin", "ext-1", "Northgate"),
                )
            with mock.patch.dict("os.environ", {runtime_config.CONTAINER_ENV: ""}):
                details = client.get("/api/app/installation-details").json()

        # A new field is a decision about what may appear in a public issue, not a side effect.
        self.assertEqual(set(details), EXPECTED_FIELDS)
        self.assertEqual(details["form"], "checkout")
        self.assertEqual(details["version"], runtime_config.APP_VERSION)
        self.assertEqual(details["connection_providers"], ["simplefin"])
        self.assertTrue(details["request_is_loopback"])
        self.assertNotIn("Northgate", str(details))

    def test_the_image_declaration_makes_it_a_container(self):
        with api_client() as (client, _):
            with mock.patch.dict("os.environ", {runtime_config.CONTAINER_ENV: "1"}):
                details = client.get("/api/app/installation-details").json()
        self.assertEqual(details["form"], "container")
        # The image holds no repository, and a container is not a checkout to ask about anyway.
        self.assertIsNone(details["build"])


if __name__ == "__main__":
    unittest.main()

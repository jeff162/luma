"""The ledger epoch a client compares on its return: it must move for a write to anything the ledger pages
show — including tables the reconciliation epoch deliberately ignores — and the endpoint must report it."""

from backend.db.database import get_db, ledger_epoch
from backend.tests._api_client import api_client


def test_a_write_the_recon_epoch_ignores_still_moves_the_ledger_epoch():
    with api_client() as (client, _):
        before = client.get("/api/app/ledger-epoch").json()["epoch"]
        with get_db() as conn:
            conn.execute("INSERT INTO tag (name, color) VALUES ('Trip', '#336699')")
        after = client.get("/api/app/ledger-epoch").json()["epoch"]
        assert after > before
        with get_db() as conn:
            assert ledger_epoch(conn) == after


def test_reading_does_not_move_it():
    with api_client() as (client, _):
        first = client.get("/api/app/ledger-epoch").json()["epoch"]
        client.get("/api/transactions")
        client.get("/api/tasks")
        assert client.get("/api/app/ledger-epoch").json()["epoch"] == first

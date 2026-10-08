"""`luma --reset-password` (`backend/account_recovery.py`): the way back in for a locked-out install.

The reset has to clear *everything* that could still keep the account out — a password alone is no use to
someone whose authenticator is gone, or whose account was the disabled one — and it has to change nothing
when it is cancelled, refused, or pointed at a name that does not exist.
"""

import tempfile
from contextlib import contextmanager
from pathlib import Path

import pytest

from backend import account_recovery
from backend.db import control_database as cdb
from backend.db import database


@pytest.fixture
def stack():
    with tempfile.TemporaryDirectory() as tmp:
        data_path = str(Path(tmp) / "data.db")
        originals = (database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH)
        database.DB_PATH = cdb.DB_PATH = data_path
        cdb.CONTROL_DB_PATH = str(Path(tmp) / "control.db")
        database.init_db(data_path)
        cdb.init_control_db()
        try:
            yield
        finally:
            database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH = originals


def _workspace():
    """Sign-in on, with an admin and a member who has 2FA, recovery codes and a live session."""
    cdb.enable_auth_mode()
    admin = cdb._create_user_with_tenant("Admin", "password123", role="admin")
    member = cdb._create_user_with_tenant("Member", "password123", tenant_id=admin["tenant_id"])
    cdb.enable_totp(member["id"], cdb.generate_totp_secret())
    cdb.replace_recovery_codes(member["id"])
    cdb.create_sign_in_session("digest", member["id"], prune_idle_seconds=3600)
    return admin, member


def _signed_in(user_id):
    return cdb.sign_in_session_is_live("digest", user_id, max_idle_seconds=3600, touch_after_seconds=3600)


@contextmanager
def _console(answers=(), secrets=()):
    answers, secrets, said = list(answers), list(secrets), []
    yield {
        "ask": lambda _prompt: answers.pop(0),
        "ask_secret": lambda _prompt: secrets.pop(0),
        "say": said.append,
    }, said
    assert not answers and not secrets, "every scripted answer should have been asked for"


def test_reset_clears_everything_that_kept_the_account_out(stack):
    _admin, member = _workspace()
    cdb.update_user(member["id"], status="disabled")
    cdb.create_sign_in_session("digest", member["id"], prune_idle_seconds=3600)
    assert _signed_in(member["id"])

    with _console(secrets=["new-password-1", "new-password-1"]) as (io, said):
        assert account_recovery.run("member", **io) == 0

    user = cdb.get_user_by_id(member["id"])
    assert (user["role"], user["status"], user["totp_enabled"], user["must_change_password"]) == (
        "admin", "active", 0, 0,
    )
    assert cdb.authenticate_user("Member", "new-password-1")
    assert cdb.recovery_code_count(member["id"]) == 0
    assert not _signed_in(member["id"])
    assert "It is now an administrator." in said and "It has been re-enabled." in said


def test_without_a_username_it_lists_accounts_and_asks_again_for_a_bad_password(stack):
    admin, _member = _workspace()

    with _console(
        answers=["1"],
        secrets=["short", "new-password-1", "mismatch-1234", "new-password-1", "new-password-1"],
    ) as (io, said):
        assert account_recovery.run(None, **io) == 0

    assert "  1. Admin (admin)" in said
    assert "Not accepted: password must be at least 8 characters." in said
    assert "The two entries did not match." in said
    assert cdb.authenticate_user("Admin", "new-password-1")["id"] == admin["id"]


@pytest.mark.parametrize("username", ["nobody", None])
def test_an_unknown_account_or_a_cancel_changes_nothing(stack, username):
    _admin, member = _workspace()

    def cancel(_prompt):
        raise KeyboardInterrupt

    with _console(answers=[] if username else ["Member"]) as (io, said):
        io["ask_secret"] = cancel
        assert account_recovery.run(username, **io) == 1

    assert cdb.authenticate_user("Member", "password123")
    assert cdb.get_user_by_id(member["id"])["totp_enabled"] == 1


def test_with_sign_in_off_there_is_nothing_to_reset(stack):
    _workspace()
    cdb.disable_auth_mode()

    with _console() as (io, said):
        assert account_recovery.run("member", **io) == 0

    assert cdb.authenticate_user("Member", "password123")

# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
`luma --reset-password`: a way back in for someone locked out of their own install.

The premise is the one `docs/security-model.md` -> *Identity and the network perimeter* rests on: sign-in
is a network perimeter, not protection of the data. Whoever can run this can already read both database
files, ledger included, so letting them set a password grants nothing they did not have. What they cannot
reach is the vault, whose credentials open only with a vault secret; this leaves it alone.

It acts on the databases a server started the same way would use, and names the control database before
changing anything, since resetting some other install's file is the likely mistake. It works whether or
not the app is running: both databases are WAL-mode SQLite, and the server reads accounts and sessions
per request. The one thing it cannot reach is the running server's memory, which is where a sign-in
pause after wrong guesses lives — hence the closing note about it.

Output is plain ASCII on purpose: this is the one path in the app that talks to a console the user typed
into, and a Windows console is not guaranteed to render anything else.
"""

import getpass
from typing import Callable

from backend.db import control_database
from backend.runtime_config import app_name
from backend.services import attempt_limiter


def run(
    username: str | None,
    *,
    ask: Callable[[str], str] = input,
    ask_secret: Callable[[str], str] = getpass.getpass,
    say: Callable[[str], None] = print,
) -> int:
    """Reset one account's password and return the exit status. `username` None means ask which."""
    say(f"Control database: {control_database.CONTROL_DB_PATH}")
    users = control_database.list_users()
    if not users:
        say(f"There are no accounts; starting {app_name()} goes to first-run setup. Nothing was changed.")
        return 1
    if not control_database.auth_required():
        say("Sign-in protection is off, so no password is needed to get in. Nothing was changed.")
        return 0

    try:
        user = _choose_account(users, username, ask, say)
        if user is None:
            return 1
        password = _ask_new_password(user["username"], ask_secret, say)
    except (EOFError, KeyboardInterrupt):
        say("\nCancelled. Nothing was changed.")
        return 1

    control_database.restore_admin_access(user["id"], password)

    say(f"The password for {user['username']} has been reset.")
    if user["role"] != "admin":
        say("It is now an administrator.")
    if user["status"] != "active":
        say("It has been re-enabled.")
    if user["totp_enabled"]:
        say("Two-factor sign-in is off and its recovery codes are cleared; it can be set up again after signing in.")
    say("Any browser signed in to it has been signed out.")
    if control_database.vault_slot_count():
        say("The vault holding data-source credentials still opens only with its own passphrase; that is unchanged.")
    minutes = attempt_limiter.LOCKOUT_SECONDS // 60
    say(f"If wrong passwords paused sign-in for this account, the pause ends within {minutes} minutes, "
        f"or when {app_name()} restarts.")
    return 0


def _choose_account(users: list[dict], username: str | None, ask, say) -> dict | None:
    by_name = {user["username"].lower(): user for user in users}
    if username is None:
        say("Accounts:")
        for number, user in enumerate(users, start=1):
            notes = [user["role"]] + ([] if user["status"] == "active" else [user["status"]])
            say(f"  {number}. {user['username']} ({', '.join(notes)})")
        username = ask("Account to reset (number or username): ").strip()
        if username.isdigit() and 1 <= int(username) <= len(users):
            return users[int(username) - 1]

    user = by_name.get(username.strip().lower())
    if user is None:
        say(f"No account is named {username!r}. Nothing was changed.")
    return user


def _ask_new_password(username: str, ask_secret, say) -> str:
    while True:
        password = ask_secret(f"New password for {username}: ")
        try:
            control_database.validate_password_for_policy(password)
        except ValueError as error:
            say(f"Not accepted: {error}.")
            continue
        if ask_secret("Same password again: ") != password:
            say("The two entries did not match.")
            continue
        return password

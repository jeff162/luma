# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""How many guesses anyone gets at a secret a person types: a password, an authenticator code, a vault
passphrase or recovery code.

A six-digit authenticator code is strong only because an attacker gets a handful of tries at it. Three
codes are accepted at any moment (the current step and one either side), so each blind guess lands with
about a 3-in-a-million chance whichever code is current, and **rotation does nothing to that** — it only
changes which three are valid. Unlimited, a steady stream of guesses expects a hit after about 333,000
of them, which is hours at an ordinary request rate. A password is the same problem with a larger space.

Two rules, applied per account:

- **Attempts are at least `MIN_SPACING_SECONDS` apart.** Nobody types a password or a code that fast, so
  a person never meets it, while a script is held to that pace. It is claimed *before* the secret is
  checked, which is what stops a burst of simultaneous requests from all being tried at once.
- **`MAX_CONSECUTIVE_FAILURES` wrong secrets in a row pause the account for `LOCKOUT_SECONDS`.** A
  success clears the count, and failures older than `FAILURE_MEMORY_SECONDS` are forgotten, so a few
  typos spread across a day never add up to a pause.

Together they hold a guesser to about one attempt a minute. A lockout refuses the *right* secret too:
answering it differently would tell the guesser which one was right.

**Refused rather than delayed.** A limited attempt gets an immediate refusal saying how long to wait.
Holding the request open instead would occupy a server thread for the wait, and enough held requests
would lock everyone out.

**Keyed by account, not by address.** Behind the reverse proxy a networked install sits behind, every
request arrives from the proxy's address, so a per-address limit would be one limit for everybody. The
consequence accepted with it: someone who knows a username can keep that account paused. A passkey sign-in
cannot be guessed and is not limited, so it stays open to the account's owner meanwhile.

**Process memory.** Luma runs as one process, and a restart clearing the counts gives an attacker
nothing, since they cannot cause one. An entry idle past `FAILURE_MEMORY_SECONDS` is dropped once the
table grows, so names that were only ever guessed do not accumulate.
"""

import math
import threading
import time
from dataclasses import dataclass

MIN_SPACING_SECONDS = 2
MAX_CONSECUTIVE_FAILURES = 5
LOCKOUT_SECONDS = 5 * 60
FAILURE_MEMORY_SECONDS = 15 * 60

# Below this size nothing is pruned: sweeping on every attempt would cost more than the entries do.
_PRUNE_ABOVE = 1024

# Read through the module rather than bound at import, so a test can move time without sleeping.
_now = time.monotonic


class TooManyAttempts(Exception):
    """An attempt refused before its secret was checked. `retry_after` is whole seconds, at least one;
    `locked` separates a lockout from the ordinary spacing, which a caller may answer differently."""

    def __init__(self, retry_after: float, *, locked: bool):
        self.retry_after = max(1, math.ceil(retry_after))
        self.locked = locked
        super().__init__(f"too many attempts; retry in {self.retry_after}s")


@dataclass
class _Entry:
    last_attempt: float
    failures: int = 0
    last_failure: float | None = None
    locked_until: float = 0.0


_lock = threading.Lock()
_entries: dict[tuple[str, str], _Entry] = {}


def begin(scope: str, subject: str) -> None:
    """Claim an attempt at `subject`'s secret, or raise `TooManyAttempts`.

    `scope` keeps the kinds of secret apart (a wrong vault passphrase says nothing about the sign-in
    password), and `subject` is whose secret it is. Call before checking the secret, then report the
    outcome with `failed` or `succeeded`."""
    key = (scope, subject)
    now = _now()
    with _lock:
        _prune(now)
        entry = _entries.get(key)
        if entry is None:
            _entries[key] = _Entry(last_attempt=now)
            return
        if entry.locked_until > now:
            raise TooManyAttempts(entry.locked_until - now, locked=True)
        wait = entry.last_attempt + MIN_SPACING_SECONDS - now
        if wait > 0:
            raise TooManyAttempts(wait, locked=False)
        entry.last_attempt = now


def failed(scope: str, subject: str) -> bool:
    """Record a wrong secret. True when this failure started a lockout."""
    key = (scope, subject)
    now = _now()
    with _lock:
        entry = _entries.setdefault(key, _Entry(last_attempt=now))
        if entry.last_failure is not None and now - entry.last_failure > FAILURE_MEMORY_SECONDS:
            entry.failures = 0
        entry.failures += 1
        entry.last_failure = now
        if entry.failures < MAX_CONSECUTIVE_FAILURES:
            return False
        # Counted afresh after the pause, so each lockout buys the guesser exactly one more run.
        entry.failures = 0
        entry.locked_until = now + LOCKOUT_SECONDS
        return True


def succeeded(scope: str, subject: str) -> None:
    """Record a right secret, which clears the count and the spacing together."""
    with _lock:
        _entries.pop((scope, subject), None)


def reset() -> None:
    """Forget everything. For tests, which share one process and would otherwise inherit counts."""
    with _lock:
        _entries.clear()


def _prune(now: float) -> None:
    if len(_entries) <= _PRUNE_ABOVE:
        return
    for key in [
        key for key, entry in _entries.items()
        if entry.locked_until <= now
        and now - max(entry.last_attempt, entry.last_failure or 0.0) > FAILURE_MEMORY_SECONDS
    ]:
        del _entries[key]

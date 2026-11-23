# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
What follows a group when its root changes (`docs/data-model.md` -> *Account groups*).

A stored account id is resolved at read time (`account_groups`), so a rule or series scoped to the old root
still selects the group. A *key* that embeds the root's id is not resolved: it is compared as text, so it is
re-keyed to the new root wherever the group as a whole takes one.

- **Making a member the root** (`make_root`) leaves the same group, so everything keyed by the root follows:
  the account flags' dismissals as well as the series keys (`move_group_root`).
- **Merging one group into another** makes the target's root the merged group's. Its series now resolve to
  the target, so their keys follow (`move_series_keys`). Its balance flags do not: the merged group has
  another balance, and a dismissal of the old one says nothing about it.
- **A detach** moves nothing: the account leaving takes none of the group's answers, which stay with the
  group, and nothing tells which of them were about that account.
"""

from backend.services.balance_totals import HISTORY_FLAG_KIND
from backend.services.closed_accounts import CLOSED_BALANCE_KIND
from backend.services.recurring_detection import move_transfer_account
from backend.services.recurring_signals import move_account_in_dismissals
from backend.services.signal_dismissals import move_subject


def move_group_root(conn, old_root: str, new_root: str) -> None:
    """Re-key everything keyed by the group's root from `old_root` to `new_root`, for a group that is still
    the same group: the account flags' dismissals and the series keys."""
    for kind in (HISTORY_FLAG_KIND, CLOSED_BALANCE_KIND):
        move_subject(conn, kind, old_root, new_root)
    move_series_keys(conn, old_root, new_root)


def move_series_keys(conn, old_root: str, new_root: str) -> None:
    """Re-key the recurring signals' dismissals and the transfer series' keys from `old_root` to `new_root`."""
    move_account_in_dismissals(conn, old_root, new_root)
    move_transfer_account(conn, old_root, new_root)

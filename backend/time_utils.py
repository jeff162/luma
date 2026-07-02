# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Single source of the UTC timestamp strings stored in metadata columns and backup payloads.

`datetime.utcnow()` is deprecated from Python 3.12 onward, but these timestamps are persisted as
*naive* UTC ISO strings (no `+00:00` offset) in SQLite TEXT columns and serialized into backup
files, then compared and deduplicated as opaque strings. Emitting offset-aware output instead would
be a stored-data format change, not a drop-in swap, so this preserves the exact naive-UTC string
while removing the deprecation. Funnelling every call site through one helper also makes the format
a single future decision rather than nine scattered ones.
"""

from datetime import datetime, timezone


def utcnow_iso() -> str:
    """Current UTC time as a naive ISO-8601 string, identical to the former `utcnow().isoformat()`."""
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat()

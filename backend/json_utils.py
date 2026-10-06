# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Best-effort JSON object parsing is used for stored snapshots and mapping blobs
that may be absent, legacy, or partially corrupted.

- Callers that use this helper are opting into "invalid means empty object"
- Non-object JSON payloads are normalized away so downstream code can treat the
  result as a mapping without repeating type checks

**An already-parsed mapping passes straight through**, and that is load-bearing rather than a
convenience. These blobs are nested: a `config_snapshot` or a `column_map` is read from the database as
text, and every member of it is a real `dict` once that outer parse has happened. The same walk
therefore meets both shapes, and a helper that only accepted text answered `{}` for the parsed one —
silently, because an empty mapping is exactly what a legitimately-absent blob looks like. Three
subsystems were reading their own settings back as empty for that reason. Callers must not reintroduce
a local `isinstance(value, dict)` guard in front of this; the guard belongs here, once.
"""

import json
from typing import Any
from collections.abc import Mapping


def safe_json_dict(raw: str | Mapping[str, Any] | None) -> dict[str, Any]:
    if not raw:
        return {}
    if isinstance(raw, Mapping):
        return dict(raw)
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}

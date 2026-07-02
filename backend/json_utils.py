# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Best-effort JSON object parsing is used for stored snapshots and mapping blobs
that may be absent, legacy, or partially corrupted.

- Callers that use this helper are opting into "invalid means empty object"
- Non-object JSON payloads are normalized away so downstream code can treat the
  result as a mapping without repeating type checks
"""

import json
from typing import Any


def safe_json_dict(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}

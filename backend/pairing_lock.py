# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
What the server does when its two databases do not belong together (`control_database.pairing_problem`).

**It stays up and explains, rather than exiting.** A packaged build started by a double-click has no
terminal, so an exit would show nothing at all, and a container that exits is restarted into the same
failure. The server finishes starting without opening the financial database, and every request is
answered with the explanation: a page for a browser, a 503 for the API (whose message the interface shows
when it cannot load). `/api/health` still answers, since it reports only that a server is listening, and
the launcher uses it to join a running instance rather than start a second one.

**The way out is a setting or the console, never the page.** Pointing the settings at the right file
needs a restart, and pairing a ledger deliberately is `--adopt-ledger` (`backend/ledger_adoption.py`):
a button here would let anyone who can reach the server choose which ledger its sign-ins open.

**File paths go only to this machine.** They describe the server, and the app shows them only to an
administrator or a local session (`app_config.data_location`). Nobody has signed in here, so a request
from the network is told what is wrong and where the details are, without them.
"""

import html
import json
import sys
from pathlib import Path

from starlette.requests import Request
from starlette.types import ASGIApp, Receive, Scope, Send

from backend import transport
from backend.db.control_database import (
    PAIRING_MISSING, PAIRING_OTHER_WORKSPACE, PAIRING_UNPAIRED, PAIRING_UNREADABLE, PairingProblem,
)
from backend.runtime_config import app_name, data_dir, env_file_path, is_frozen, runs_in_container

_problem: PairingProblem | None = None


def engage(problem: PairingProblem | None) -> None:
    global _problem
    _problem = problem


def adopt_command() -> str:
    """The command that pairs the ledger, as this installation would run it."""
    if runs_in_container():
        return "docker compose exec app python -m backend.desktop --adopt-ledger"
    if is_frozen():
        return f'"{sys.executable}" --adopt-ledger'
    return f"{sys.executable} -m backend.desktop --adopt-ledger"


def _restart() -> str:
    return "docker compose restart app" if runs_in_container() else f"start {app_name()} again"


def _what_is_wrong(problem: PairingProblem, with_paths: bool) -> str:
    ledger = f" ({problem.ledger_path})" if with_paths else ""
    control = f" ({problem.control_path})" if with_paths else ""
    if problem.kind == PAIRING_MISSING:
        return f"There is no financial database where the settings say{ledger}."
    if problem.kind == PAIRING_UNREADABLE:
        return f"The file where the settings put the financial database{ledger} is not a database."
    if problem.kind == PAIRING_UNPAIRED:
        return (f"The financial database{ledger} has not been paired with the control database{control}. "
                "A newly created file, or one from before pairing existed, reads this way.")
    if problem.kind == PAIRING_OTHER_WORKSPACE:
        return f"The financial database{ledger} belongs to a different control database than this one{control}."
    raise ValueError(problem.kind)


def _remedies(problem: PairingProblem) -> list[tuple[str, str, str | None]]:
    """(heading, explanation, command) for each way out, the likeliest first."""
    restart = _restart()
    if runs_in_container():
        where = (f"Mount the folder holding this installation's two databases at {data_dir()} in "
                 "docker-compose.yml, then docker compose up -d.")
    else:
        where = (f"Set DATA_DIR to the folder holding this installation's two databases, or DB_PATH to the "
                 f"financial database alone, in {env_file_path()}, then {restart}.")
    settings = ("If the settings point at the wrong file", where, None)
    if problem.kind == PAIRING_MISSING:
        return [
            settings,
            ("If the financial database is gone",
             f"Create an empty one for this installation with the command below, run on this computer, then "
             f"{restart} and restore a backup.",
             adopt_command()),
        ]
    if problem.kind == PAIRING_UNREADABLE:
        return [settings]
    return [
        settings,
        ("If this is the right financial database",
         f"Pair it with this control database with the command below, run on this computer. It names both "
         f"files and asks before changing anything. Then {restart}.",
         adopt_command()),
    ]


def log_message(problem: PairingProblem) -> str:
    lines = [
        f"[db] {app_name()} did not open its data. {_what_is_wrong(problem, with_paths=False)}",
        f"  financial database: {problem.ledger_path}",
        f"  control database:   {problem.control_path}",
    ]
    for heading, explanation, command in _remedies(problem):
        lines.append(f"  {heading}: {explanation}")
        if command:
            lines.append(f"    {command}")
    return "\n".join(lines)


def _api_message(problem: PairingProblem, local: bool) -> str:
    if not local:
        return (f"{app_name()} did not open its data. {_what_is_wrong(problem, with_paths=False)} "
                "The server's log has the details.")
    return log_message(problem).removeprefix("[db] ")


_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font-family: system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1rem;
         line-height: 1.5; }}
  code {{ display: block; padding: .6rem .8rem; margin: .4rem 0 0; border-radius: 6px;
         background: color-mix(in srgb, currentColor 8%, transparent); overflow-wrap: anywhere;
         font-size: .9rem; }}
  h2 {{ font-size: 1.05rem; margin-top: 1.8rem; }}
</style>
</head>
<body>
<h1>{title}</h1>
{body}
</body>
</html>
"""


def _page(problem: PairingProblem, local: bool) -> str:
    title = f"{app_name()} did not open its data"
    parts = [
        f"<p>{html.escape(_what_is_wrong(problem, with_paths=local))}</p>",
        "<p>The financial database and the control database have to belong to the same installation, so "
        "nothing has been opened.</p>",
    ]
    if not local:
        parts.append("<p>The details, and what to do, are in the server's log, or on its screen where it "
                     "was started from a terminal.</p>")
    else:
        for heading, explanation, command in _remedies(problem):
            parts.append(f"<h2>{html.escape(heading)}</h2><p>{html.escape(explanation)}</p>")
            if command:
                parts.append(f"<code>{html.escape(command)}</code>")
        if not is_frozen() and not runs_in_container():
            parts.append(f"<p>Run commands from {html.escape(str(Path.cwd()))}, where relative paths in the "
                         "settings are read from.</p>")
    return _PAGE.format(title=html.escape(title), body="\n".join(parts))


class PairingLockMiddleware:
    """Answers every request but `/api/health` with the explanation while a pairing problem is engaged."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        problem = _problem
        if problem is None or scope["type"] != "http" or scope["path"] == "/api/health":
            await self.app(scope, receive, send)
            return
        local = transport.request_is_loopback(Request(scope))
        if scope["path"].startswith("/api/"):
            body = json.dumps({"detail": _api_message(problem, local), "code": "databases_not_paired"})
            content_type = b"application/json"
        else:
            body = _page(problem, local)
            content_type = b"text/html; charset=utf-8"
        payload = body.encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": 503,
            "headers": [(b"content-type", content_type), (b"content-length", str(len(payload)).encode())],
        })
        await send({"type": "http.response.body", "body": payload})


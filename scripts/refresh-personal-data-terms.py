#!/usr/bin/env python3
"""Refresh the local personal-data term list from a database named on the command line.

Companion to `scripts/check-personal-data.js`, which guards tracked files against the real account
names, card last-4s and institutions belonging to whoever runs this repo. That list is deliberately
untracked (a committed denylist would itself disclose what it protects), so it has to be built
locally — and kept current as accounts come and go.

**The database is named as an argument and never discovered.** Reading whatever `.env` currently
points at is the failure worth designing out: with a test database configured, the refresh would
harvest fabricated names, the guard would match nothing, and the whole chain would report success
while checking for the wrong strings. Naming the file makes that choice visible at the moment it is
made. The database is opened read-only.

Terms are *merged*, never replaced: a term added by hand after a leak was found in practice survives
every later refresh, and an account closed at the bank does not un-protect the fixtures still naming
it.

Only two kinds of term are added outright: **card last-4s** and **multi-word names**. Both are
specific enough that a match is a real finding. A bare word out of an account name is not — the words
in real account names include "Bridge" (SimpleFIN's own term for what it connects through), "Delta",
"Capital" and "Amazon", each of which appears legitimately across this repo, and one noisy guard that
has to be argued with is a guard that gets switched off. Single words are therefore written as
**commented-out suggestions** to accept by hand: delete the `# candidate:` prefix on the ones that are
genuinely identifying, which is where a human eye is worth more than a heuristic.

Usage:
    python3 scripts/refresh-personal-data-terms.py ~/path/to/real-data.db
    python3 scripts/refresh-personal-data-terms.py --dry-run ~/path/to/real-data.db
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TERMS_FILE = REPO_ROOT / "data" / "personal-data-terms.txt"

# Words that are account *categories* rather than anybody's identity. A term list containing these
# matches ordinary prose and legitimate fixtures, and a guard that cries wolf gets switched off.
GENERIC = {
    "account", "accounts", "bank", "card", "cards", "cash", "check", "checking", "credit", "debit",
    "deposit", "family", "joint", "loan", "main", "money", "mortgage", "my", "online", "personal",
    "plus", "preferred", "primary", "rewards", "savings", "shared", "the", "unlimited", "wallet",
    # SimpleFIN's own noun for what it connects through, so it appears all over the adapter and its
    # fixtures — an account named after the bridge is naming the integration, not its owner.
    "bridge",
}

# Fabricated stand-ins already used across the repo. Harvesting one of these — from a demo load or a
# restored test database — would make the guard reject the very replacements it asks for.
FABRICATED = {"fablecard", "harborline", "riverstone", "northgate", "demo", "fixture", "example", "test"}

# Vendors `docs/collaboration-notes.md` explicitly allows in fixtures ("large, well-established,
# generic-type vendors are fine ... Amazon, Starbucks, Netflix"), plus the integrations this code
# actually talks to, where the name is the technical fact. Never suggest these.
PERMITTED = {"amazon", "starbucks", "netflix", "paypal", "venmo", "plaid", "simplefin", "luma"}


def candidates(conn: sqlite3.Connection) -> tuple[set[str], set[str]]:
    """(terms to add outright, single words to suggest)."""
    found: set[str] = set()
    suggest: set[str] = set()

    def add_name(value) -> None:
        text = str(value or "").strip()
        if not text:
            return
        words = re.findall(r"[A-Za-z][A-Za-z'&-]{2,}", text)
        lowered = {w.lower() for w in words}
        # A name mentioning an integration this code talks to describes the integration, not a person
        # ("SimpleFIN Bridge"). The rule exempts exactly that, and harvesting it would make the guard
        # fire across the adapter, its fixtures and the README.
        if lowered & PERMITTED:
            return
        keep = [w for w in words if w.lower() not in GENERIC and w.lower() not in FABRICATED]
        if not keep:
            return
        # The pairing is what identifies; a lone word out of it usually is not.
        if len(words) > 1 and len(text) <= 60:
            found.add(text)
            suggest.update(keep)
        else:
            suggest.update(keep)
        # A mask is often carried in the name rather than the column ("… Gold Card (...7304)").
        for digits in re.findall(r"(?<!\d)(\d{4})(?!\d)", text):
            found.add(digits)

    for table, columns in (
        ("account", ("name", "display_name")),
        ("connection", ("institution",)),
    ):
        try:
            rows = conn.execute(f"SELECT {', '.join(columns)} FROM {table}").fetchall()
        except sqlite3.Error:
            continue  # a database predating the column, or a different schema entirely
        for row in rows:
            for value in row:
                add_name(value)

    try:
        for (mask,) in conn.execute("SELECT mask FROM account WHERE mask IS NOT NULL AND mask != ''"):
            digits = re.sub(r"\D", "", str(mask))
            if 3 <= len(digits) <= 6:
                found.add(digits)
    except sqlite3.Error:
        pass
    return found, suggest


def existing_terms() -> tuple[list[str], set[str], set[str]]:
    """The file's lines as written, the active terms, and everything already mentioned.

    The third set includes declined suggestions, so a word rejected once is not offered every refresh.
    """
    if not TERMS_FILE.exists():
        return [], set(), set()
    lines = TERMS_FILE.read_text(encoding="utf-8").splitlines()
    active, seen = set(), set()
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            candidate = stripped.lstrip("#").strip()
            if candidate.lower().startswith("candidate:"):
                seen.add(candidate.split(":", 1)[1].strip().lower())
            continue
        active.add(stripped.lower())
        seen.add(stripped.lower())
    return lines, active, seen


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("database", help="path to the database holding the real data — named, never guessed")
    parser.add_argument("--dry-run", action="store_true", help="print what would be added and write nothing")
    args = parser.parse_args()

    db = Path(args.database).expanduser()
    if not db.exists():
        print(f"No such database: {db}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        found, suggest = candidates(conn)
    finally:
        conn.close()

    lines, already, seen = existing_terms()
    fresh = sorted(t for t in found if t.lower() not in already)
    # A word already accepted, already suggested, or covered by a full name is not offered again.
    proposed = sorted(w for w in suggest if w.lower() not in seen)

    print(f"Read {db}")
    print(f"  {len(fresh)} to add, {len(proposed)} to review, {len(already)} already listed.")
    for term in fresh:
        print(f"  + {term}")
    for term in proposed:
        print(f"  ? {term}   (written commented out — uncomment if it identifies you)")
    if not fresh and not proposed:
        print("Nothing to add.")
        return 0
    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return 0

    TERMS_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not lines:
        lines = [
            "# Real account names, institutions and card last-4s to keep out of tracked files.",
            "# Untracked on purpose: this list IS the thing it protects. See scripts/check-personal-data.js.",
            "# Refresh with: python3 scripts/refresh-personal-data-terms.py <path-to-real.db>",
            "# Hand-added entries survive every refresh — add anything found in practice.",
            "",
        ]
    body = lines + [""] if lines and lines[-1].strip() else list(lines)
    body += fresh + [f"# candidate: {w}" for w in proposed]
    TERMS_FILE.write_text("\n".join(body) + "\n", encoding="utf-8")
    print(f"\nWrote {len(fresh)} terms and {len(proposed)} suggestions to "
          f"{TERMS_FILE.relative_to(REPO_ROOT)}")
    if proposed:
        print("Review the `# candidate:` lines: uncomment the identifying ones, delete the rest.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

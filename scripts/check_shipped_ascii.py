#!/usr/bin/env python3
"""Refuse a character above U+007F in text this project puts in front of a terminal.

A Windows console decodes with the machine's OEM code page (CP437 or CP850 on most installs), not
UTF-8. So an em dash written as UTF-8 arrives as three bytes and renders as `ΓÇö` — which is what the
portable kit's `README.txt` did, and what the launcher printed on every single startup before it.
Nothing about the encoding can be fixed from this side: the reader chooses the code page, and 7-bit
ASCII is the only range that renders the same under all of them.

The rule is therefore narrow on purpose. It covers **string literals** in the files below, and
nothing else:

- **Comments are exempt**, because they never leave the repository. They do not appear in the AST at
  all, so this needs no special case.
- **Docstrings are exempt** for the same reason, and do need one — they are ordinary string constants
  as far as the parser is concerned.
- **The frontend is out of scope entirely.** Its text is rendered by a browser, which knows the
  document's encoding. The terminal is the only surface with this problem, and drawing the line at
  "text that reaches a terminal or ships as a file" is what keeps this from becoming a house style
  rule about punctuation.

Two files drifted independently before this existed, which is why it is a check rather than a note in
a document.
"""

import ast
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Each entry names *why* the file is watched, because that reason is the test for adding another one:
# does its text reach a terminal, or ship as a file a user opens outside a browser? A module that only
# feeds the API or the UI does not qualify, however user-facing its strings are.
WATCHED = {
    "scripts/build_desktop.py": "the README.txt written into every downloadable kit",
    "backend/desktop.py": "console output and luma-desktop.log, on every launch",
}


def _docstring_nodes(tree: ast.AST) -> set[int]:
    """Identity of every string constant that is a docstring rather than a value.

    Matched structurally instead of by `ast.get_docstring`, which returns the text and leaves no way
    to tell one node from another string with the same content.
    """
    found: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        body = getattr(node, "body", None)
        if not body:
            continue
        first = body[0]
        if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
            found.add(id(first.value))
    return found


def check(relative: str) -> list[str]:
    path = ROOT / relative
    source = path.read_text(encoding="utf-8")
    lines = source.splitlines()
    tree = ast.parse(source, filename=str(path))
    docstrings = _docstring_nodes(tree)

    problems = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        if id(node) in docstrings:
            continue
        # A multi-line literal reports the line it *starts* on, so the character is located by
        # searching the literal's own span rather than by trusting `node.lineno`.
        span = range(node.lineno - 1, min(node.end_lineno or node.lineno, len(lines)))
        for character in sorted({c for c in node.value if ord(c) > 127}):
            name = unicodedata.name(character, "unnamed")
            where = next((n + 1 for n in span if character in lines[n]), node.lineno)
            problems.append(
                f"{relative}:{where}: U+{ord(character):04X} {name} ({character})\n"
                f"    {lines[where - 1].strip()}"
            )
    return problems


def main(argv: list[str]) -> int:
    # With arguments this filters to the watched files among them, so the pre-commit hook can hand it
    # the staged list and get the same answer. With none it checks everything watched.
    if argv:
        requested = set()
        for argument in argv:
            try:
                requested.add(str(Path(argument).resolve().relative_to(ROOT)).replace("\\", "/"))
            except ValueError:
                continue  # outside the repository; not ours to judge
        targets = [name for name in WATCHED if name in requested]
    else:
        targets = list(WATCHED)

    problems = []
    for name in targets:
        problems.extend(check(name))

    if not problems:
        return 0

    print("Non-ASCII characters in text that reaches a terminal:\n", file=sys.stderr)
    for problem in problems:
        print(problem, file=sys.stderr)
    print(
        "\nA Windows console decodes with its OEM code page, so these render as mojibake there.\n"
        "Rewrite with 7-bit ASCII: an em dash usually becomes a hyphen, a semicolon, parentheses, or\n"
        "a sentence break. Comments and docstrings in these files are exempt and were not checked.\n"
        "Watched because: "
        + "; ".join(f"{name} ({why})" for name, why in WATCHED.items()),
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

"""
Backend comment lint checker.

This script enforces the project's system-level commenting style by:

- flagging low-value comments (e.g. "loop through", "set value")
- detecting complex files that are missing a top-level system comment
- allowing simple or localized modules to remain minimal

The goal is to prevent comment drift over time while preserving a
high signal-to-noise ratio in the codebase.
"""

import os
import re
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(__file__))

# 🚫 obvious low-value comment patterns
BAD_PATTERNS = [
    r"#\s*loop through",
    r"#\s*iterate",
    r"#\s*set ",
    r"#\s*get ",
    r"#\s*initialize",
    r"#\s*update ",
]

# Heuristic: file is "complex" if it has enough functions/classes
MIN_FUNCTIONS_FOR_SYSTEM = 3


def is_python_file(path):
    return path.endswith(".py") and "venv" not in path and "__pycache__" not in path


def count_functions(content):
    return len(re.findall(r"^\s*(def|class)\s+", content, re.MULTILINE))


def has_top_level_comment(content):
    # Allow comments before docstring (e.g., SPDX headers)
    lines = content.strip().splitlines()

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            continue
        return stripped.startswith('"""') or stripped.startswith("'''")

    return False

def check_bad_comments(file_path, content):
    issues = []
    for pattern in BAD_PATTERNS:
        if re.search(pattern, content, re.IGNORECASE):
            issues.append(f"{file_path}: contains low-value comment matching '{pattern}'")
    return issues

def should_require_system_comment(file_path, content):
    fn_count = count_functions(content)
    lines = content.splitlines()
    line_count = len(lines)

    path_lower = file_path.lower()

    # --- Always require (high-signal system files) ---
    if any(p in path_lower for p in ["routers", "services"]):
        return fn_count >= 2

    # --- Scripts (like your lint) ---
    if "scripts" in path_lower:
        return fn_count >= 5 or line_count >= 150

    # --- Core backend entry points ---
    if any(name in path_lower for name in ["main.py", "runtime_config.py", "app_logging.py"]):
        return True

    # --- General heuristic ---
    # Complex enough to likely encode a system
    if fn_count >= 4:
        return True

    # Large file even if function count is low
    if line_count >= 200:
        return True

    return False 

def check_missing_system_comment(file_path, content):
    issues = []

    fn_count = count_functions(content)

    if should_require_system_comment(file_path, content):
        if not has_top_level_comment(content):
            issues.append(
                f"{file_path}: likely missing top-level system comment (fn={fn_count}, lines={line_count})"            )

    return issues
    
def get_context(content, max_lines=10):
    lines = content.splitlines()
    preview = lines[:max_lines]
    return "\n".join(f"{i+1}: {line}" for i, line in enumerate(preview))

def main():
    issues = []

    # If files are passed in, use them; otherwise scan all
    input_paths = sys.argv[1:]

    paths_to_check = []

    if input_paths:
        for path in input_paths:
            if is_python_file(path):
                paths_to_check.append(path)
    else:
        for root, _, files in os.walk(BACKEND_DIR):
            for f in files:
                path = os.path.join(root, f)
                if is_python_file(path):
                    paths_to_check.append(path)

    for path in paths_to_check:
        try:
            with open(path, "r", encoding="utf-8") as file:
                content = file.read()
        except Exception:
            continue

        file_issues = []

        file_issues.extend(check_bad_comments(path, content))
        file_issues.extend(check_missing_system_comment(path, content))

        if file_issues:
            context = get_context(content)
            for issue in file_issues:
                issues.append(f"{issue}\n\n--- context ---\n{context}\n----------------")
        
    if issues:
        print("\nComment lint issues:\n")
        for issue in issues:
            print(" -", issue)
        sys.exit(1)
    else:
        print("Comment lint passed ✓")

if __name__ == "__main__":
    main()

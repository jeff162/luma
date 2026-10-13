#!/bin/sh

echo "Running project lint (staged files only)..."

# Get staged files
FILES=$(git diff --cached --name-only --diff-filter=ACM)

FRONTEND_FILES=""
BACKEND_FILES=""
DOC_FILES=""

for FILE in $FILES; do
  case "$FILE" in
    frontend/*)
      FRONTEND_FILES="$FRONTEND_FILES $FILE"
      ;;
    backend/*.py)
      BACKEND_FILES="$BACKEND_FILES $FILE"
      ;;
    docs/*.md|README.md|CONTRIBUTING.md)
      DOC_FILES="$DOC_FILES $FILE"
      ;;
  esac
done

STATUS=0

# Personal data — every staged file, not just source: a real account name or card last-4 leaks the same
# whether it lands in a fixture, a comment or a doc. No-ops unless a local term list exists (see
# scripts/check-personal-data.js for why that list is not in the repository).
if [ -n "$FILES" ]; then
  echo "Checking for personal data..."
  node scripts/check-personal-data.js $FILES
  if [ $? -ne 0 ]; then STATUS=1; fi
fi

# Terminal text — the whole staged list rather than a bucket, because the files this watches are not
# all under backend/ or frontend/, and the checker filters to its own set anyway. A character above
# U+007F in a message a Windows console prints arrives as mojibake there (scripts/check_shipped_ascii.py).
if [ -n "$FILES" ]; then
  echo "Checking terminal text for non-ASCII..."
  node scripts/run_shipped_ascii_check.js $FILES
  if [ $? -ne 0 ]; then STATUS=1; fi
fi

# Frontend
if [ -n "$FRONTEND_FILES" ]; then
  echo "Checking frontend comments..."
  cd frontend || exit 1
  node scripts/check-comments.js $FRONTEND_FILES
  if [ $? -ne 0 ]; then STATUS=1; fi
  cd ..
fi

# Backend
if [ -n "$BACKEND_FILES" ]; then
  echo "Checking backend comments..."
  node scripts/run_backend_comment_check.js $BACKEND_FILES
  if [ $? -ne 0 ]; then STATUS=1; fi

  echo "Checking backend timestamps..."
  node scripts/check-backend-timestamps.js $BACKEND_FILES
  if [ $? -ne 0 ]; then STATUS=1; fi
fi

# Documentation — a renamed heading leaves a contents list or the docs index pointing at nothing. The
# check reads every document rather than the staged ones, since the index is built from all of them.
if [ -n "$DOC_FILES" ]; then
  echo "Checking documentation contents..."
  node scripts/check-doc-contents.js
  if [ $? -ne 0 ]; then STATUS=1; fi
fi

if [ $STATUS -ne 0 ]; then
  echo ""
  echo "❌ Commit blocked: lint failed"
  exit 1
fi

echo ""
echo "✅ Lint passed"
exit 0

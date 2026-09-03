#!/bin/sh

echo "Running project lint (staged files only)..."

# Get staged files
FILES=$(git diff --cached --name-only --diff-filter=ACM)

FRONTEND_FILES=""
BACKEND_FILES=""

for FILE in $FILES; do
  case "$FILE" in
    frontend/*)
      FRONTEND_FILES="$FRONTEND_FILES $FILE"
      ;;
    backend/*.py)
      BACKEND_FILES="$BACKEND_FILES $FILE"
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

if [ $STATUS -ne 0 ]; then
  echo ""
  echo "❌ Commit blocked: lint failed"
  exit 1
fi

echo ""
echo "✅ Lint passed"
exit 0

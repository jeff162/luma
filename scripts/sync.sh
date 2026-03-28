#!/bin/bash
# Nightly transaction sync
# Install: crontab -e
# Add:     0 3 * * * /path/to/fintrack/scripts/sync.sh >> /var/log/fintrack-sync.log 2>&1

set -e
cd "$(dirname "$0")/.."

echo "[$(date)] Starting sync..."
curl -s -X POST http://localhost:8000/api/sync | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(f'  added={data[\"added\"]} updated={data[\"updated\"]} skipped={data[\"skipped\"]}')
"
echo "[$(date)] Done."

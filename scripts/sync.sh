#!/bin/bash

# Nightly transaction sync
# Install: crontab -e
# Add:     0 3 * * * /path/to/luma/scripts/sync.sh >> /var/log/luma-sync.log 2>&1

set -e
cd "$(dirname "$0")/.."

echo "[$(date)] Starting sync..."
curl -s -X POST http://localhost:8000/api/sync | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(f'  added={data[\"added\"]} updated={data[\"updated\"]} skipped={data[\"skipped\"]}')
"
echo "[$(date)] Done."

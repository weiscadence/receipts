#!/bin/bash
# Upgrade pending OpenTimestamps proofs to full Bitcoin attestations (idempotent).
cd "$(dirname "$0")/../data/ots" || exit 1
OTS=/home/ubuntu/.local/ots-venv/bin/ots
for f in *.ots; do
  out=$(timeout 60 "$OTS" upgrade "$f" 2>&1)
  echo "$(date -u +%FT%TZ) $f: $(echo "$out" | tail -1)"
done
rm -f ./*.ots.bak

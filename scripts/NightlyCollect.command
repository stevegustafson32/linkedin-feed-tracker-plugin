#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  LinkedIn Feed Tracker — Nightly Collection
#  Runs automatically via macOS launchd. Can also be double-clicked
#  manually to run an immediate collection.
# ═══════════════════════════════════════════════════════════════

# Find the scripts directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" 2>/dev/null

# Verify Node 20
NODE_VERSION=$(node --version 2>/dev/null)
if [[ "$NODE_VERSION" != v20.* ]]; then
  echo "[$(date)] ERROR: Node 20 required, found $NODE_VERSION" >> "$SCRIPT_DIR/data/nightly.log"
  exit 1
fi

LOG="$SCRIPT_DIR/data/nightly.log"
echo "" >> "$LOG"
echo "═══════════════════════════════════════════════════" >> "$LOG"
echo "[$(date)] Nightly collection starting" >> "$LOG"

# Part 1: Feed collection
echo "[$(date)] Feed collection..." >> "$LOG"
node src/collector.js >> "$LOG" 2>&1

# Part 2: Profile batch (auto-scaling: 7/14/21 batches based on connection count)
echo "[$(date)] Profile batch..." >> "$LOG"
node src/profile-collector.js >> "$LOG" 2>&1

# Part 3: Own post performance
echo "[$(date)] Own posts..." >> "$LOG"
node src/own-posts.js >> "$LOG" 2>&1

# Part 4: Refresh dashboard
echo "[$(date)] Refreshing dashboard..." >> "$LOG"
node src/generate-dashboard.js >> "$LOG" 2>&1

echo "[$(date)] Nightly collection complete" >> "$LOG"

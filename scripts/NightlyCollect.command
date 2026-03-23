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

# Part 0: Auto-update from GitHub (silent, non-blocking)
if [ -d "$SCRIPT_DIR/../.git" ]; then
  echo "[$(date)] Checking for updates..." >> "$LOG"
  cd "$SCRIPT_DIR/.."
  git pull --ff-only >> "$LOG" 2>&1 || echo "[$(date)] Update check skipped (no internet or merge conflict)" >> "$LOG"
  cd "$SCRIPT_DIR"
  npm install --loglevel=error >> "$LOG" 2>&1
fi

# Part 0.5: Monthly batch shuffle (1st of each month) — randomize visit patterns
DAY_OF_MONTH=$(date +%d)
if [ "$DAY_OF_MONTH" = "01" ]; then
  echo "[$(date)] Monthly batch shuffle..." >> "$LOG"
  node -e "const db = require('./src/database'); const c = db.getActiveConnectionCount(); const b = db.computeBatchCount(c); const n = db.reassignBatchGroups(b, { shuffle: true }); console.log('Shuffled ' + n + ' connections into ' + b + ' batches');" >> "$LOG" 2>&1
fi

# Part 1: Feed collection
echo "[$(date)] Feed collection..." >> "$LOG"
node src/collector.js >> "$LOG" 2>&1

# Part 2: Profile batch (auto-scaling: 7/14/21 batches based on connection count)
echo "[$(date)] Profile batch..." >> "$LOG"
node src/profile-collector.js >> "$LOG" 2>&1

# Part 3: Own post performance
echo "[$(date)] Own posts..." >> "$LOG"
node src/own-posts.js >> "$LOG" 2>&1

# Part 4: Score posts for relevance (requires focus-areas.json in data dir)
echo "[$(date)] Scoring posts..." >> "$LOG"
node src/score-posts.js >> "$LOG" 2>&1 || echo "[$(date)] Scoring skipped (no focus-areas.json)" >> "$LOG"

# Part 5: Refresh dashboard
echo "[$(date)] Refreshing dashboard..." >> "$LOG"
node src/generate-dashboard.js >> "$LOG" 2>&1

echo "[$(date)] Nightly collection complete" >> "$LOG"

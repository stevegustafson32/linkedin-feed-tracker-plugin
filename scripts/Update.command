#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  LinkedIn Feed Tracker — Update
#  Double-click this file to pull the latest code and re-sync.
#  No terminal knowledge needed — just double-click and wait.
# ═══════════════════════════════════════════════════════════════

clear
echo ""
echo "  ╔═══════════════════════════════════════════════════╗"
echo "  ║     LinkedIn Feed Tracker — Update                ║"
echo "  ╚═══════════════════════════════════════════════════╝"
echo ""

# ── Find the install ──────────────────────────────────────────

INSTALL_DIR="$HOME/.linkedin-feed-tracker/scripts"

if [ ! -d "$INSTALL_DIR" ]; then
  echo "  ❌  LinkedIn Feed Tracker not found."
  echo "      Run Setup.command first to install."
  echo ""
  read -p "  Press Enter to close..."
  exit 1
fi

cd "$INSTALL_DIR"

# ── Load nvm + Node 20 ───────────────────────────────────────

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" 2>/dev/null

NODE_VERSION=$(node --version 2>/dev/null)
if [[ "$NODE_VERSION" != v20.* ]]; then
  echo "  ⚠️  Node 20 required, found $NODE_VERSION"
  echo "      Trying nvm use 20..."
  nvm use 20 2>/dev/null
  NODE_VERSION=$(node --version 2>/dev/null)
  if [[ "$NODE_VERSION" != v20.* ]]; then
    echo "  ❌  Could not switch to Node 20. Run Setup.command again."
    read -p "  Press Enter to close..."
    exit 1
  fi
fi
echo "  ✓ Node.js $NODE_VERSION"

# ── Read data directory ───────────────────────────────────────

DATA_DIR_FILE="$HOME/.linkedin-feed-tracker/data-dir.txt"
if [ -f "$DATA_DIR_FILE" ]; then
  DATA_DIR=$(cat "$DATA_DIR_FILE" | tr -d '\n')
else
  DATA_DIR="$INSTALL_DIR/data"
fi

echo "  ✓ Data folder: $DATA_DIR"
echo ""

# ── Step 1: Pull latest code from GitHub ──────────────────────

echo "  [1/4] Pulling latest code..."

# Check if we have a git repo to pull from
if [ -d "$INSTALL_DIR/../.git" ]; then
  # Full repo clone exists one level up
  cd "$INSTALL_DIR/.."
  git pull --ff-only 2>&1 | tail -3
  PULL_STATUS=$?
  cd "$INSTALL_DIR"
elif [ -d "$INSTALL_DIR/.git" ]; then
  git pull --ff-only 2>&1 | tail -3
  PULL_STATUS=$?
else
  # No git history — re-clone and replace
  echo "         Re-downloading from GitHub..."
  TEMP_DIR="$HOME/.linkedin-feed-tracker/update-temp"
  rm -rf "$TEMP_DIR"
  git clone --depth 1 https://github.com/stevegustafson32/linkedin-feed-tracker-plugin.git "$TEMP_DIR" 2>&1 | tail -1
  PULL_STATUS=$?

  if [ $PULL_STATUS -eq 0 ]; then
    # Preserve local data files and browser profile
    echo "         Backing up your data..."
    [ -d "$INSTALL_DIR/data" ] && cp -r "$INSTALL_DIR/data" "$TEMP_DIR/scripts/data" 2>/dev/null
    [ -f "$INSTALL_DIR/data/selectors.json" ] && cp "$INSTALL_DIR/data/selectors.json" "$TEMP_DIR/scripts/data/selectors.json" 2>/dev/null

    # Replace scripts with new version
    echo "         Installing update..."
    rm -rf "$INSTALL_DIR.old"
    mv "$INSTALL_DIR" "$INSTALL_DIR.old"
    mv "$TEMP_DIR/scripts" "$INSTALL_DIR"
    rm -rf "$TEMP_DIR"
    rm -rf "$INSTALL_DIR.old"

    cd "$INSTALL_DIR"
    echo "         ✓ Code updated from GitHub"
  else
    echo "  ❌  Download failed. Check your internet connection."
    read -p "  Press Enter to close..."
    exit 1
  fi
fi

if [ $PULL_STATUS -eq 0 ]; then
  echo "         ✓ Code is up to date"
else
  echo "  ⚠️  Pull had issues, but continuing..."
fi

# ── Step 2: Reinstall dependencies ────────────────────────────

echo ""
echo "  [2/4] Checking dependencies..."

cd "$INSTALL_DIR"
npm install --loglevel=error 2>&1 | grep -v "^npm notice" | tail -3

echo "         ✓ Dependencies up to date"

# ── Step 3: Re-sync connections (picks up headline fix) ───────

echo ""
echo "  [3/4] Re-syncing your connections (this takes ~5 minutes)..."
echo "         This picks up new headline/title extraction."
echo ""

node src/connections.js 2>&1 | grep -E "✅|⚠️|❌|📊|Found|Synced|Extracted|connections|Total|strategy|headline"

echo ""
echo "         ✓ Connections re-synced"

# ── Step 4: Refresh dashboard ─────────────────────────────────

echo ""
echo "  [4/4] Refreshing your dashboard..."

# Check if generate-dashboard.py or refresh-dashboard.js exists
if [ -f "$INSTALL_DIR/../tools/generate-dashboard.py" ]; then
  python3 "$INSTALL_DIR/../tools/generate-dashboard.py" 2>&1 | tail -3
  echo "         ✓ Dashboard refreshed"
elif [ -f "$DATA_DIR/refresh-dashboard.js" ]; then
  node "$DATA_DIR/refresh-dashboard.js" 2>&1 | tail -3
  echo "         ✓ Dashboard refreshed"
else
  echo "         ⏭  Dashboard will refresh on next Cowork session"
fi

# ── Done ──────────────────────────────────────────────────────

echo ""
echo ""
echo "  ╔═══════════════════════════════════════════════════╗"
echo "  ║  ✅  Update complete!                             ║"
echo "  ╠═══════════════════════════════════════════════════╣"
echo "  ║                                                   ║"
echo "  ║  What's new:                                      ║"
echo "  ║  • Headlines/titles now captured for connections   ║"
echo "  ║  • Comment replies filtered from feed data         ║"
echo "  ║  • Improved dashboard with 3 panels                ║"
echo "  ║  • Better nightly collection reliability           ║"
echo "  ║                                                    ║"
echo "  ║  Your nightly schedule is still running.           ║"
echo "  ║  No other action needed.                           ║"
echo "  ║                                                    ║"
echo "  ╚═══════════════════════════════════════════════════╝"
echo ""
read -p "  Press Enter to close..."

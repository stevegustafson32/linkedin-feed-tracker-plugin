#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  LinkedIn Feed Tracker — One-Click Setup
#  Double-click this file to set everything up.
#  The only thing you'll do manually is log into LinkedIn.
# ═══════════════════════════════════════════════════════════════

clear
echo ""
echo "  ╔═══════════════════════════════════════════════════╗"
echo "  ║     LinkedIn Feed Tracker — Setup                 ║"
echo "  ╚═══════════════════════════════════════════════════╝"
echo ""

# Find the scripts directory (same folder as this .command file)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$SCRIPT_DIR/data"

# ── Step 1: Node.js 20 ──────────────────────────────────────

echo "  [1/5] Checking Node.js..."

# Load nvm if installed
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" 2>/dev/null

NODE_VERSION=$(node --version 2>/dev/null)

if [[ "$NODE_VERSION" == v20.* ]]; then
  echo "         ✓ Node.js $NODE_VERSION"
elif command -v nvm &>/dev/null; then
  echo "         Installing Node.js 20 (one-time, ~30 seconds)..."
  nvm install 20 2>/dev/null
  nvm use 20 2>/dev/null
  nvm alias default 20 2>/dev/null
  NODE_VERSION=$(node --version 2>/dev/null)
  if [[ "$NODE_VERSION" == v20.* ]]; then
    echo "         ✓ Node.js $NODE_VERSION installed"
  else
    echo ""
    echo "  ❌  Could not install Node.js 20."
    echo "      Please install it manually: https://nodejs.org/en/download"
    echo "      Pick the LTS version (20.x), then double-click this file again."
    echo ""
    read -p "  Press Enter to close..."
    exit 1
  fi
else
  echo "         Installing nvm + Node.js 20 (one-time, ~60 seconds)..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh 2>/dev/null | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 20 2>/dev/null
  nvm use 20 2>/dev/null
  nvm alias default 20 2>/dev/null
  NODE_VERSION=$(node --version 2>/dev/null)
  if [[ "$NODE_VERSION" == v20.* ]]; then
    echo "         ✓ Node.js $NODE_VERSION installed"
  else
    echo ""
    echo "  ❌  Could not install Node.js 20."
    echo "      Please install it manually: https://nodejs.org/en/download"
    echo "      Pick the LTS version (20.x), then double-click this file again."
    echo ""
    read -p "  Press Enter to close..."
    exit 1
  fi
fi

# ── Step 2: Install dependencies ─────────────────────────────

echo ""
echo "  [2/5] Installing dependencies..."

cd "$SCRIPT_DIR"
npm install --loglevel=error 2>&1 | grep -v "^npm notice"

if [ $? -eq 0 ]; then
  echo "         ✓ Dependencies installed"
else
  echo ""
  echo "  ❌  npm install failed. Check the error above."
  echo ""
  read -p "  Press Enter to close..."
  exit 1
fi

# ── Step 3: Initialize database ──────────────────────────────

echo ""
echo "  [3/5] Setting up database..."

mkdir -p "$DATA_DIR"

node -e "require('./src/database.js')" 2>/dev/null

if [ -f "$DATA_DIR/feeds.db" ]; then
  echo "         ✓ Database ready"
else
  echo ""
  echo "  ❌  Database initialization failed."
  echo ""
  read -p "  Press Enter to close..."
  exit 1
fi

# ── Step 4: LinkedIn login ───────────────────────────────────

echo ""
echo "  [4/5] LinkedIn authentication"
echo ""
echo "  ┌─────────────────────────────────────────────────────┐"
echo "  │  A browser window is about to open.                 │"
echo "  │                                                     │"
echo "  │  Log into LinkedIn like you normally would.         │"
echo "  │  Once you see your feed, CLOSE the browser.         │"
echo "  │                                                     │"
echo "  │  That's it — I'll save the session for future use.  │"
echo "  └─────────────────────────────────────────────────────┘"
echo ""
read -p "  Press Enter to open LinkedIn..."

# Launch Playwright with visible browser for login
node -e "
const { chromium } = require('playwright');
const path = require('path');
const PROFILE_DIR = path.join('$DATA_DIR', 'browser-profile');

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://www.linkedin.com/login');
  console.log('  Waiting for you to log in and close the browser...');
  await new Promise((resolve) => {
    context.on('close', resolve);
  });
  console.log('');
  console.log('         ✓ LinkedIn session saved');
})().catch(err => {
  console.error('  Error:', err.message);
  process.exit(1);
});
"

if [ $? -ne 0 ]; then
  echo ""
  echo "  ⚠️  LinkedIn login may not have completed."
  echo "      You can re-run this setup anytime."
  echo ""
fi

# ── Step 5: First collection ─────────────────────────────────

echo ""
echo "  [5/5] Running first collection..."
echo "         This takes 1-2 minutes."
echo ""

# Feed collection
echo "         Collecting feed posts..."
node src/collector.js 2>&1 | grep -E "✅|⚠️|📊|Found|Stored|posts"

echo ""

# Sync connections
echo "         Syncing your connections..."
node src/connections.js 2>&1 | grep -E "✅|⚠️|📊|Found|Synced|connections|Total"

echo ""

# Own posts (baseline on first run)
echo "         Checking your own post performance..."
HAS_OWN_POSTS=$(node -e "
const db = require('./src/database.js');
const stats = db.getOwnPostStats();
console.log(stats.total_posts || 0);
" 2>/dev/null)

if [ "$HAS_OWN_POSTS" = "0" ] || [ -z "$HAS_OWN_POSTS" ]; then
  node src/own-posts.js --baseline 2>&1 | grep -E "✅|⚠️|📊|Found|Stored|posts|tracked"
else
  node src/own-posts.js 2>&1 | grep -E "✅|⚠️|📊|Found|Stored|posts|tracked"
fi

# ── Done ─────────────────────────────────────────────────────

echo ""
echo ""
echo "  ╔═══════════════════════════════════════════════════╗"
echo "  ║  ✅  Setup complete!                              ║"
echo "  ╠═══════════════════════════════════════════════════╣"
echo "  ║                                                   ║"
echo "  ║  Go back to Cowork and try:                       ║"
echo "  ║                                                   ║"
echo "  ║    \"What's trending on my feed?\"                  ║"
echo "  ║    \"Show me my dashboard\"                         ║"
echo "  ║    \"Generate my weekly report\"                    ║"
echo "  ║                                                   ║"
echo "  ║  Your feed will be scraped every night at 10 PM.  ║"
echo "  ║  Just keep your Mac awake.                        ║"
echo "  ║                                                   ║"
echo "  ╚═══════════════════════════════════════════════════╝"
echo ""
read -p "  Press Enter to close..."

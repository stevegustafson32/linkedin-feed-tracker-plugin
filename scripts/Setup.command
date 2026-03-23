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

# ── Step 0: Clone the repo if running from a standalone download ──

INSTALL_DIR="$HOME/.linkedin-feed-tracker/scripts"

# Check if we're already inside the cloned repo (has package.json nearby)
LAUNCH_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$LAUNCH_DIR/package.json" ] && [ -f "$LAUNCH_DIR/src/database.js" ]; then
  # Running from inside the repo — use this directory
  SCRIPT_DIR="$LAUNCH_DIR"
else
  # Running from Downloads or standalone — clone the repo
  echo "  [0/7] Downloading LinkedIn Feed Tracker..."
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "         Found existing install — pulling latest..."
    cd "$INSTALL_DIR" && git pull --ff-only 2>/dev/null
  else
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone https://github.com/stevegustafson32/linkedin-feed-tracker-plugin.git "$HOME/.linkedin-feed-tracker/repo-temp" 2>&1 | tail -1
    if [ $? -ne 0 ]; then
      echo ""
      echo "  ❌  Could not download LinkedIn Feed Tracker."
      echo "      Check your internet connection and try again."
      echo ""
      read -p "  Press Enter to close..."
      exit 1
    fi
    # Move scripts dir to the right place
    mv "$HOME/.linkedin-feed-tracker/repo-temp/scripts" "$INSTALL_DIR"
    rm -rf "$HOME/.linkedin-feed-tracker/repo-temp"
  fi
  SCRIPT_DIR="$INSTALL_DIR"
  echo "         ✓ Downloaded to $SCRIPT_DIR"
  echo ""
fi

DATA_DIR="$SCRIPT_DIR/data"

# ── Step 1: Node.js 20 ──────────────────────────────────────

echo "  [1/7] Checking Node.js..."

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

# ── Step 2: Pick your project folder ─────────────────────────

echo ""
echo "  [2/7] Choose where to store your data..."
echo ""
echo "  Your database and browser session will live in this folder."
echo "  Pick a folder accessible to Cowork (e.g., inside your Cowork workspace)."
echo ""

# Use macOS folder picker
PROJECT_FOLDER=$(osascript -e 'tell application "System Events" to activate' -e 'set theFolder to choose folder with prompt "Pick a folder for LinkedIn Feed Tracker data (e.g., your Cowork workspace):"' -e 'return POSIX path of theFolder' 2>/dev/null)

if [ -z "$PROJECT_FOLDER" ] || [ "$PROJECT_FOLDER" = "" ]; then
  echo "         No folder selected — using default: ~/.linkedin-feed-tracker/data/"
  PROJECT_FOLDER="$HOME/.linkedin-feed-tracker/data"
  mkdir -p "$PROJECT_FOLDER"
else
  # Create a LinkedIn Feed Tracker subfolder inside chosen folder
  PROJECT_FOLDER="${PROJECT_FOLDER%/}/LinkedIn Feed Tracker"
  mkdir -p "$PROJECT_FOLDER"
fi

echo "         ✓ Data folder: $PROJECT_FOLDER"

# Write data-dir.txt so scripts can find the DB
mkdir -p "$HOME/.linkedin-feed-tracker"
echo "$PROJECT_FOLDER" > "$HOME/.linkedin-feed-tracker/data-dir.txt"
DATA_DIR="$PROJECT_FOLDER"

# ── Step 3: Install dependencies ─────────────────────────────

echo ""
echo "  [3/7] Installing dependencies..."

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

# ── Step 4: Initialize database ──────────────────────────────

echo ""
echo "  [4/7] Setting up database..."

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
echo "  [5/7] LinkedIn authentication"
echo ""
echo "  ┌─────────────────────────────────────────────────────┐"
echo "  │  A browser window is about to open.                 │"
echo "  │                                                     │"
echo "  │  Log into LinkedIn like you normally would.         │"
echo "  │  The browser will close automatically once          │"
echo "  │  you're logged in. Just sit tight after logging in. │"
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
  console.log('  Waiting for you to log in...');

  const loginDetected = await new Promise((resolve) => {
    let closed = false;
    context.on('close', () => { closed = true; resolve(true); });

    const check = setInterval(async () => {
      if (closed) { clearInterval(check); return; }
      try {
        const url = page.url();
        if (url.includes('/feed') || url.includes('/mynetwork') || url.includes('/messaging')) {
          clearInterval(check);
          await new Promise(r => setTimeout(r, 3000));
          console.log('');
          console.log('         ✓ Login detected — saving session...');
          if (!closed) await context.close();
          resolve(true);
        }
      } catch { /* page may have navigated */ }
    }, 2000);

    setTimeout(() => {
      clearInterval(check);
      if (!closed) {
        console.log('');
        console.log('         Timeout — close the browser manually when ready.');
      }
    }, 300000);
  });

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

# ── Step 5: Schedule nightly collection ──────────────────────

echo ""
echo "  [6/7] Setting up nightly scraping..."

# Make the nightly script executable
chmod +x "$SCRIPT_DIR/NightlyCollect.command"

# Get the full path to node (nvm path)
NODE_PATH=$(which node)

# Create launchd plist for nightly collection at 10:00 PM
PLIST_PATH="$HOME/Library/LaunchAgents/com.linkedin-feed-tracker.nightly.plist"
PLIST_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$PLIST_DIR"

cat > "$PLIST_PATH" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.linkedin-feed-tracker.nightly</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${SCRIPT_DIR}/NightlyCollect.command</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>22</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>MisfireGracePeriod</key>
    <integer>3600</integer>
    <key>StandardOutPath</key>
    <string>${DATA_DIR}/nightly.log</string>
    <key>StandardErrorPath</key>
    <string>${DATA_DIR}/nightly-error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:$(dirname "$NODE_PATH")</string>
        <key>NVM_DIR</key>
        <string>${HOME}/.nvm</string>
    </dict>
</dict>
</plist>
PLIST_EOF

# Load the schedule (unload first if already exists)
launchctl unload "$PLIST_PATH" 2>/dev/null
launchctl load "$PLIST_PATH" 2>/dev/null

if [ $? -eq 0 ]; then
  echo "         ✓ Nightly scraping scheduled (10:00 PM every night)"
  echo "         Runs automatically. If your Mac is asleep, it catches up when you wake it."
else
  echo "         ⚠️  Could not set up automatic scheduling."
  echo "         You can still double-click NightlyCollect.command manually."
fi

# ── Step 6: First collection ─────────────────────────────────

echo ""
echo "  [7/7] Running first collection..."
echo "         This takes 1-2 minutes."
echo ""

# Feed collection
echo "         Collecting feed posts..."
node src/collector.js 2>&1 | grep -E "✅|⚠️|📊|Found|Stored|posts"

echo ""

# Sync connections
echo "         Syncing your connections..."
node src/connections.js 2>&1 | grep -E "✅|⚠️|❌|📊|Found|Synced|Extracted|connections|Total|strategy|Diagnostic"

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
echo "  ║  Your feed will be scraped every night at 10 PM.  ║"
echo "  ║  Just keep your Mac awake — nothing else needed.  ║"
echo "  ║                                                   ║"
echo "  ║  Go back to Cowork and try:                       ║"
echo "  ║                                                   ║"
echo "  ║    \"What's trending on my feed?\"                  ║"
echo "  ║    \"Show me my dashboard\"                         ║"
echo "  ║    \"Generate my weekly report\"                    ║"
echo "  ║                                                   ║"
echo "  ╚═══════════════════════════════════════════════════╝"
echo ""
read -p "  Press Enter to close..."

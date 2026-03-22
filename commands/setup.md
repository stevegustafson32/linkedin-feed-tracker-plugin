---
description: Set up LinkedIn Feed Tracker for first use
allowed-tools: Read, Write, Edit, Bash
---

Walk the user through first-time setup of the LinkedIn Feed Tracker plugin. This is a conversational setup — no Terminal commands required from the user. Handle everything silently and only surface what the user needs to act on.

## Step 1 — Node.js 20 (handle automatically)

Check silently:
```bash
node --version 2>/dev/null
```

**If Node 20.x is found:** Proceed silently. Don't mention it.

**If Node is missing or wrong version:** Tell the user: "I need to install a small runtime called Node.js to power the data collection. This is a one-time thing — takes about 30 seconds. Okay to proceed?"

If they say yes, detect their OS and install automatically:

**macOS:**
```bash
# Install nvm if not present
if ! command -v nvm &>/dev/null && [ ! -s "$HOME/.nvm/nvm.sh" ]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
fi
# Load nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
# Install and use Node 20
nvm install 20
nvm use 20
nvm alias default 20
```

**Windows (if detected via `uname`):**
Tell the user: "I need you to do one thing — download Node.js 20 from nodejs.org/en/download. Pick the LTS version (20.x), run the installer, and let me know when it's done. That's the only manual step in the whole setup."

**Linux:**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

After installation, verify:
```bash
node --version
```

If it still fails, troubleshoot. Do NOT proceed without Node 20.

**Why Node 20 specifically:** Node 22 has a compatibility issue with the database library (better-sqlite3) on Apple Silicon Macs. Don't explain this unless the user asks. Just install 20.

## Step 2 — Install Dependencies

```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts && npm install
```

Run silently. Only surface errors. If it succeeds, say nothing about this step.

## Step 3 — Initialize Database

```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts && node -e "require('./src/database.js')"
```

Check if `${CLAUDE_PLUGIN_ROOT}/scripts/data/feeds.db` already exists first. If it does, ask: "I found an existing database. Want to keep your existing data or start fresh?"

## Step 4 — LinkedIn Authentication

Tell the user: "A browser window is about to open. Log into LinkedIn like you normally would — I'll save the session so the nightly scraper can run on its own. Just close the browser when you're logged in."

```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts && node src/setup.js --auth-only
```

If the setup script doesn't support `--auth-only`, run the full setup wizard.

Wait for confirmation. If login fails, offer to retry.

## Step 5 — Configure Topics

Tell the user: "Last thing — what do you want to track? I've got four defaults ready: Founders & Startups, Operations & Productivity, Sales & Revenue, and Work & Culture. You can use those as-is, swap some out, or tell me completely different ones."

Based on their answer, update the config table:
```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts && node -e "
const db = require('./src/database.js');
db.setConfig('topic_clusters', JSON.stringify(TOPICS_ARRAY_HERE));
"
```

## Step 6 — Configure Scheduled Tasks

Set up three scheduled tasks using the Cowork scheduled task system. Tell the user: "I'm setting up the nightly collection schedule. Your feed gets scraped at 10 PM, your connections' profiles at 10:30 PM, and the full connections list refreshes every Sunday at 6 PM. Your machine just needs to be awake — Cowork doesn't need to be open."

Create the scheduled tasks:
1. Nightly feed collection at 10:00 PM local time
2. Nightly profile batch scraping at 10:30 PM local time
3. Sunday connections refresh at 6:00 PM local time

## Step 7 — First Collection

Ask: "Want me to run the first collection right now? Takes about 2-3 minutes. You'll be able to see your dashboard and analysis right after."

If yes, run the collector and report: how many posts were found, how many were new, how long it took.

## Step 8 — Done

Keep it short: "You're all set. Here's what's running:
- Feed collection: every night at 10 PM
- Profile scraping: every night at 10:30 PM
- Connections refresh: every Sunday at 6 PM

Just ask me anytime — 'what's trending on my feed,' 'show me my dashboard,' 'draft me a post,' or 'generate my weekly report.'"

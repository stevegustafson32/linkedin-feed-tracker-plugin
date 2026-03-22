---
description: Set up LinkedIn Feed Tracker for first use
allowed-tools: Read, Write, Edit, Bash, mcp__cowork__present_files
---

Set up the LinkedIn Feed Tracker plugin. The data collection scripts (Playwright, SQLite) must run natively on the user's Mac — they cannot run inside the Cowork VM. This setup command detects the environment and guides the user accordingly.

## Step 1 — Detect environment

Check if we're in a VM or running natively:
```bash
uname -a 2>/dev/null
```

If the output contains "Linux" and we're in a Cowork session (the plugin root is under `/sessions/`), we're in a VM. The scripts need to run on the user's Mac.

## Step 2 — Present the Setup file

Copy the Setup.command file to the user's workspace so they can access it:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/scripts/Setup.command" "${COWORK_WORKSPACE}/Setup LinkedIn Feed Tracker.command" 2>/dev/null
chmod +x "${COWORK_WORKSPACE}/Setup LinkedIn Feed Tracker.command" 2>/dev/null
```

If COWORK_WORKSPACE isn't set, try the mounted workspace path. The file needs to end up somewhere the user can double-click it.

Present the file to the user using the present_files tool so they see a clickable card.

Tell the user:

"I've created a setup file for you. Here's what to do:

1. **Double-click** the setup file below
2. It'll install everything automatically
3. When a browser opens, **log into LinkedIn** like you normally would
4. Once you see your feed, **close the browser**
5. The setup will finish on its own — come back here when it's done

The whole thing takes about 2-3 minutes."

## Step 3 — Wait for user to come back

When the user says they're done (or asks a question about their feed), verify the setup worked:

```bash
ls "${CLAUDE_PLUGIN_ROOT}/scripts/data/feeds.db" 2>/dev/null && echo "DB_EXISTS" || echo "NO_DB"
```

If the database exists, check what's in it:
```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts && node -e "
const db = require('./src/database.js');
const stats = db.getConnectionStats();
const postCount = db.getPostCount();
console.log(JSON.stringify({ connections: stats.total, posts: postCount }));
" 2>/dev/null
```

If data is there, tell the user: "You're all set! I can see [X] connections and [Y] posts in your database. Try asking me 'what's trending on my feed' or 'show me my dashboard.'"

If no data, troubleshoot: "Looks like the setup didn't complete. Want to try running it again?"

## Step 4 — Configure topics (optional, after setup)

Ask: "One more thing — what topics do you want to track? I've got defaults: AI & Technology, Leadership & Career, Business & Strategy, Founders & Startups, and a few more. Want to customize or keep the defaults?"

If they want to customize, use the manage-topics skill.

## Fallback — Native environment

If we detect we're NOT in a VM (running directly in Claude Code on macOS), fall back to running the setup steps directly:

1. Check Node.js 20, install via nvm if needed
2. `cd ${CLAUDE_PLUGIN_ROOT}/scripts && npm install`
3. `node -e "require('./src/database.js')"`
4. Launch Playwright for LinkedIn auth
5. Run first collection

This path is for users running Claude Code in Terminal on their Mac, not Cowork.

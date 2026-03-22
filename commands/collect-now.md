---
description: Run a manual LinkedIn feed collection
allowed-tools: Bash, Read
---

Trigger an immediate 3-part LinkedIn collection and report results.

## Process

1. Check if a collection is already running:
```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts && node -e "
const db = require('./src/database.js');
const last = db.getLatestScrapeRun();
console.log(JSON.stringify(last));
"
```

2. Run the feed collector (Part 1 of 3 — feed snapshot):
```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts && node src/collector.js
```

3. Report: number of new posts found, any duplicates skipped, any errors encountered.

4. Run profile batch collection (Part 2 of 3 — tonight's connection batch):
```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts && node src/profile-collector.js
```

Report the batch group scraped, profiles visited, and posts found.

5. Run own-post performance tracking (Part 3 of 3):
```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts && node src/own-posts.js
```

If the own_posts table is empty (first run), auto-run with --baseline flag to seed history:
```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts && node src/own-posts.js --baseline
```

Report: posts tracked, average engagement, any new posts since last collection.

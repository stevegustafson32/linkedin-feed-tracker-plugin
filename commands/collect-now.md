---
description: Run a manual LinkedIn feed collection
allowed-tools: Bash, Read
---

Trigger an immediate LinkedIn feed collection and report results.

## Process

1. Check if a collection is already running:
```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts && node -e "
const db = require('./src/database.js');
const last = db.getLatestScrapeRun();
console.log(JSON.stringify(last));
"
```

2. Run the feed collector:
```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts && node src/collector.js
```

3. Report: number of new posts found, any duplicates skipped, any errors encountered.

4. If the user also wants profile scraping, run:
```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts && node src/profile-scraper.js
```

Report the batch group scraped, profiles visited, and posts found.

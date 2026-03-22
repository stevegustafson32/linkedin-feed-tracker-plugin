---
description: Check LinkedIn Feed Tracker system health
allowed-tools: Bash, Read
---

Run a health check on the LinkedIn Feed Tracker and report status.

## Checks

1. **Database**: Verify `${CLAUDE_PLUGIN_ROOT}/scripts/data/feeds.db` exists and is readable
2. **Recent collection**: Query for the most recent post — how long ago was the last scrape?
3. **Collection volume**: Posts collected in the last 7 days vs. the prior 7 days
4. **Browser profile**: Check if `${CLAUDE_PLUGIN_ROOT}/scripts/data/browser-profile/` exists
5. **Connections count**: How many connections are in the database?
6. **Batch coverage**: Which batch groups were scraped in the last 7 days? Are any missing?
7. **Error check**: Any profile scrape runs with 0 profiles_succeeded?

## Output

Present a clean status summary:
- Overall status: Healthy / Warning / Needs Attention
- Last collection: [time ago]
- Posts this week: [count]
- Connections tracked: [count]
- Batch coverage: [X/7 batches this week]
- Any issues found and recommended actions

---
name: weekly-report
description: >
  Generate a weekly LinkedIn intelligence report as a Word document. Use this skill when the user
  says "weekly report," "generate my report," "what happened this week on LinkedIn," "weekly
  summary," "LinkedIn recap," or any request for a periodic summary of their network's activity.
  Also triggers on "Sunday report" or when a scheduled task fires the weekly report generation.
version: 1.0.0
---

# Weekly LinkedIn Report

Generate a professional weekly report analyzing the user's LinkedIn network activity, delivered as a .docx file.

## Process

### Step 1 — Gather Data

Query the SQLite database at `${CLAUDE_PLUGIN_ROOT}/scripts/data/feeds.db`:

1. All posts from the last 7 days
2. All posts from the prior 7 days (for comparison)
3. Connection scraping stats from `profile_scrape_runs`
4. User's topic clusters from config table

### Step 2 — Analyze

Perform the same analysis as the `analyze-feed` skill, but structured for a written report:
- Topic distribution with week-over-week change
- Top 10 posts by engagement (with author, snippet, engagement counts)
- Emerging topics or themes not seen last week
- Content gaps — topics the network talks about that the user hasn't posted on
- Most active connections this week
- Collection health (posts/day, success rate)

### Step 3 — Write the Report

Use the docx skill to create a formatted Word document. Structure:

1. **Executive Summary** — 3-4 sentences: biggest trend, top content opportunity, notable shift
2. **This Week at a Glance** — key numbers table (total posts, unique authors, avg engagement, top topic)
3. **Topic Breakdown** — each topic cluster with post count, engagement, trend direction, standout posts
4. **Content Opportunities** — 3 specific post ideas based on gaps and trends, with reasoning
5. **Top Posts** — the 5 highest-engagement posts with why they worked
6. **Network Pulse** — most active connections, new frequent posters, gone-quiet connections
7. **Collection Health** — scraping stats, any issues

Save to `${CLAUDE_PLUGIN_ROOT}/scripts/data/reports/` with naming: `LFT_Weekly-Report_YYYY-MM-DD.docx`.

Also save a copy to the user's CLAUDE OUTPUTS folder if accessible.

### Step 4 — Present

Share the report file link and give a conversational 3-sentence summary of the most important findings. Don't recite the whole report — the user can read it.

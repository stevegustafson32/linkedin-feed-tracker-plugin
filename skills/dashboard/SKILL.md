---
name: dashboard
description: >
  Generate an interactive HTML dashboard showing LinkedIn feed analytics. Use this skill when the
  user says "show me my dashboard," "LinkedIn dashboard," "show my analytics," "feed stats,"
  "network dashboard," "visualize my data," or any request to see a visual overview of their
  LinkedIn network's activity. Also triggers on "show me charts" or "how's my feed doing."
version: 1.0.0
---

# LinkedIn Feed Dashboard

Generate a self-contained interactive HTML dashboard from the SQLite data.

## Process

### Step 1 — Query Data

From `${CLAUDE_PLUGIN_ROOT}/scripts/data/feeds.db`, pull:

1. **Daily post volume** — last 30 days, by date
2. **Topic distribution** — post counts per topic cluster (current week)
3. **Engagement trends** — average likes/comments per day, last 30 days
4. **Top authors** — most active connections by post count (last 7 days)
5. **Source split** — feed vs. profile scraping volumes
6. **Collection health** — posts collected per day, scrape success rates

### Step 2 — Build Dashboard

Create a single-file HTML dashboard using Chart.js (via CDN). Include:

1. **Header** — "LinkedIn Feed Tracker" with date range and key stats
2. **Post Volume Chart** — line chart, daily posts over 30 days
3. **Topic Breakdown** — doughnut chart with topic distribution
4. **Engagement Trends** — multi-line chart (likes, comments over time)
5. **Top Connections** — horizontal bar chart of most active posters
6. **Collection Health** — simple table with daily scrape stats

Add dropdown filters for: time range (7d, 14d, 30d), topic cluster, source (feed/profile/all).

### Step 3 — Style

Use a clean, dark-on-white design. No heavy framework — just inline CSS. Make it responsive. Use the color palette: #0A66C2 (LinkedIn blue), #057642 (green for positive), #B24020 (red for alerts), #666666 (neutral).

### Step 4 — Deliver

Save the HTML file and present it to the user. The file should be fully self-contained — no external dependencies except the Chart.js CDN.

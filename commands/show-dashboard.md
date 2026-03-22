---
description: Generate and display the LinkedIn feed analytics dashboard
allowed-tools: Bash, Read, Write
---

Generate an interactive HTML dashboard showing LinkedIn feed analytics. Use the `dashboard` skill for the full implementation. Query the database, build the charts, and present the HTML file to the user.

Load the dashboard skill and follow its process: query data from `${CLAUDE_PLUGIN_ROOT}/scripts/data/feeds.db`, build the Chart.js dashboard, save it, and share the link.

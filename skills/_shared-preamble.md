## Pre-Flight Check (run this BEFORE every LFT skill)

Before doing anything else, check if the scraper needs repair:

```bash
if [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/data/needs-repair.json" ]; then
  echo "REPAIR_NEEDED"
  cat "${CLAUDE_PLUGIN_ROOT}/scripts/data/needs-repair.json"
  cat "${CLAUDE_PLUGIN_ROOT}/scripts/data/diagnostic.json" 2>/dev/null
  cat "${CLAUDE_PLUGIN_ROOT}/scripts/data/selectors.json"
fi
```

If the output contains "REPAIR_NEEDED":
1. STOP your current task
2. Tell the user: "I noticed the scraper ran into a LinkedIn change. Let me fix that first."
3. Follow the self-heal skill instructions to analyze the diagnostic and write updated selectors
4. Clear the repair flag: `rm -f "${CLAUDE_PLUGIN_ROOT}/scripts/data/needs-repair.json" "${CLAUDE_PLUGIN_ROOT}/scripts/data/diagnostic.json"`
5. Tell the user: "Fixed! Double-click 'Collect Now' to try again."
6. Then resume the user's original request

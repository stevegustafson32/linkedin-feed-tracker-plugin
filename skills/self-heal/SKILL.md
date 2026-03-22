---
name: self-heal
description: >
  Automatically detect and fix broken LinkedIn selectors. This skill fires when
  the scraper reports that LinkedIn changed their page structure. It reads the
  DOM diagnostic, analyzes the new structure, generates updated CSS selectors,
  and writes them to selectors.json so the scraper works again. Triggers: "fix
  the scraper", "selectors are broken", "collection failed", "scraper isn't
  working", or automatically when any LFT skill detects a needs-repair.json flag.
version: 1.0.0
---

# Self-Heal: Fix Broken LinkedIn Selectors

When LinkedIn changes their DOM, scrapers break. This skill reads the diagnostic
dump and writes new selectors so everything works again without code changes.

## Step 0 — Check for Repair Flag (ALL LFT skills run this first)

Before doing anything else, check if the scraper needs repair:

```bash
cat "${CLAUDE_PLUGIN_ROOT}/scripts/data/needs-repair.json" 2>/dev/null
```

If this file exists, STOP your current task and run the repair flow below first.
Tell the user: "I noticed the scraper ran into a LinkedIn change. Let me fix that first."

## Step 1 — Read the Diagnostic

```bash
cat "${CLAUDE_PLUGIN_ROOT}/scripts/data/diagnostic.json" 2>/dev/null
```

This file contains:
- `sampleLinks`: what profile links look like now (href, text, child tags)
- `containerCounts`: which known post container selectors still work
- `repeatedClasses`: most common CSS classes on the page (the new selectors are in here)
- `largeLists`: list-like elements that probably contain cards
- `timeElements`: how time/date is rendered
- `pageTextSample`: raw text from the page

## Step 2 — Read Current Selectors

```bash
cat "${CLAUDE_PLUGIN_ROOT}/scripts/data/selectors.json"
```

## Step 3 — Analyze and Generate New Selectors

Based on the diagnostic, figure out:

For **connections** scraper (if `scraper === 'connections'`):
- What tag/class pattern now wraps each connection card?
- What child elements hold the name and headline?
- What does the "Load more" button look like now?
- Update the `connections.strategies` array in selectors.json

For **profile** scraper (if `scraper === 'profile'`):
- What container class wraps each post on activity pages?
- What element holds the post text?
- What element shows engagement counts?
- Where is the time/date element?
- Update the `profile` section in selectors.json

For **feed** scraper (if `scraper === 'feed'`):
- What does the timestamp line look like now?
- What button text is used for "Load more"?
- Has the sort UI changed?
- Update the `feed` section in selectors.json

## Step 4 — Write Updated Selectors

Write the updated selectors.json:

```bash
cat > "${CLAUDE_PLUGIN_ROOT}/scripts/data/selectors.json" << 'SELECTORS_EOF'
{
  ... updated config ...
}
SELECTORS_EOF
```

## Step 5 — Clear the Repair Flag

```bash
rm -f "${CLAUDE_PLUGIN_ROOT}/scripts/data/needs-repair.json"
rm -f "${CLAUDE_PLUGIN_ROOT}/scripts/data/diagnostic.json"
```

## Step 6 — Tell the User

Say: "LinkedIn changed their page structure. I've updated the selectors. Double-click 'Collect Now' to try again."

Do NOT say anything about JSON files, CSS selectors, or DOM diagnostics. Keep it simple.

---
name: manage-topics
description: >
  Manage LinkedIn Feed Tracker topic clusters through natural language. Use this skill when the
  user says "add a topic," "remove a topic," "change my topics," "edit topics," "what topics am I
  tracking," "update my topics," "topic clusters," or any request to view or modify which topic
  areas the feed tracker monitors. Also triggers on "track [topic]" or "stop tracking [topic]."
version: 1.0.0
---

# Manage Topic Clusters

View, add, edit, and remove the topic clusters that organize LinkedIn feed analysis.

## How Topics Work

Topics are stored as a JSON array in the config table of `${CLAUDE_PLUGIN_ROOT}/scripts/data/feeds.db`:

```sql
SELECT value FROM config WHERE key = 'topic_clusters';
```

Each topic has a `name` and `keywords` array. The keywords exist for backward compatibility with the legacy analyzer, but Claude's analysis uses actual content understanding — the topic name alone is usually sufficient.

## Commands

### View Current Topics

```sql
SELECT value FROM config WHERE key = 'topic_clusters';
```

Parse and display as a clean list with topic names and keyword counts.

### Add a Topic

Ask the user what topic they want to track. Add it to the JSON array with relevant keywords. Update the config:

```sql
UPDATE config SET value = '[updated JSON]', updated_at = datetime('now') WHERE key = 'topic_clusters';
```

### Remove a Topic

Show current topics, confirm which to remove, update the JSON array.

### Edit a Topic

Rename or update keywords for an existing topic.

### Reset to Defaults

Restore the default four topics: Founders & Startups, Operations & Productivity, Sales & Revenue, Work & Culture.

## Defaults

```json
[
  {"name": "Founders & Startups", "keywords": ["founder", "startup", "fundraising", "series", "venture", "bootstrap", "launch", "pivot"]},
  {"name": "Operations & Productivity", "keywords": ["operations", "productivity", "systems", "workflow", "automation", "efficiency", "process", "tools"]},
  {"name": "Sales & Revenue", "keywords": ["sales", "revenue", "pipeline", "deal", "quota", "prospecting", "outbound", "closing"]},
  {"name": "Work & Culture", "keywords": ["culture", "remote", "hiring", "team", "leadership", "management", "career", "workplace"]}
]
```

## After Any Change

Confirm the update and show the new topic list. Remind the user that the next analysis will use the updated topics.

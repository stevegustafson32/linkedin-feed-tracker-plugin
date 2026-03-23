---
name: score-posts
description: >
  Score network posts for relevance against your focus areas using weighted keyword density
  with engagement boosting. Use this skill when the user says "score my posts," "score new posts,"
  "rescore everything," "update relevance scores," "run the scorer," "how relevant are my posts,"
  or any request to apply focus-area-based relevance scoring to collected LinkedIn posts.
  Also triggers when the user says "change my focus areas," "update scoring keywords,"
  "what are my focus areas," or asks about post relevance, action flags, or scoring results.
version: 1.0.0
---

# Score Posts for Relevance

Score every post in the feeds database against the user's focus areas using a weighted keyword density algorithm with engagement boosting. Posts get a 1-5 relevance score and an action flag (deep_read, reference, archive).

## How Scoring Works

Each post is scored against every focus area defined in `focus-areas.json`:

1. **Three text tiers with different weights:**
   - Title proxy (author_title + first line of content) = **3x weight** — if someone leads with a keyword, it's their topic
   - Summary proxy (content_short / first 200 chars) = **2x weight**
   - Full text (content) = **1x weight**

2. **Word boundary matching:** Keywords ≤4 characters use regex word boundaries (`\bai\b`) to prevent substring false positives (e.g., "ai" matching "said"). Longer keywords and phrases use standard substring matching.

3. **Engagement boost:** High-engagement posts get a 1.0x–1.5x multiplier on their keyword match weight. Engagement amplifies keyword signal but doesn't create relevance from nothing.
   - ≤5 engagement: 1.0x (no boost)
   - 6-20: 1.1x | 21-50: 1.2x | 51-100: 1.3x | 101-200: 1.4x | 200+: 1.5x

4. **Density → Score mapping:**
   - 0: No match (score 0)
   - <0.05: Whisper (score 1)
   - <0.15: Light (score 2)
   - <0.33: Meaningful (score 3) → **reference** action flag
   - <0.66: Strong (score 4) → **reference** action flag
   - ≥0.66: Bullseye (score 5) → **deep_read** action flag

5. **Action flags:**
   - `deep_read` (score 5): High-signal post, use for content ideas
   - `reference` (score 3-4): Worth citing or responding to
   - `archive` (score 0-2): Noise, skip for idea generation

## Data Location

The database and focus areas config are in the user's LFT data directory:
- **Database:** Look for `feeds.db` in the user's workspace. Common paths:
  - `/sessions/*/mnt/CoWork Os/LinkedIn Feed Tracker/feeds.db`
  - The path from `${CLAUDE_PLUGIN_ROOT}/scripts/data/feeds.db`
- **Focus areas:** `focus-areas.json` in the same directory as `feeds.db`

## Running the Scorer

### Score new (unscored) posts only
```python
# Query unscored posts
posts = SELECT id, author_name, author_title, content, content_short, likes, comments
        FROM posts WHERE scored_at IS NULL
```

### Rescore all posts (after focus area changes)
```python
# Query ALL posts
posts = SELECT id, author_name, author_title, content, content_short, likes, comments
        FROM posts
```

### Update scored posts
```sql
UPDATE posts
SET relevance_score = ?,
    focus_areas = ?,      -- JSON array: [{"name": "AI & Automation", "score": 3, "density": 0.19, "matchedKeywords": ["ai", "claude"]}]
    action_flag = ?,      -- deep_read | reference | archive
    scored_at = ?         -- ISO timestamp
WHERE id = ?;
```

## Database Columns (added by scorer migration)

```sql
ALTER TABLE posts ADD COLUMN relevance_score INTEGER DEFAULT 0;  -- 1-5
ALTER TABLE posts ADD COLUMN focus_areas TEXT DEFAULT '[]';       -- JSON array
ALTER TABLE posts ADD COLUMN action_flag TEXT DEFAULT 'archive';  -- deep_read|reference|archive
ALTER TABLE posts ADD COLUMN scored_at TEXT;                      -- ISO timestamp
```

## Focus Areas Config Format

`focus-areas.json` structure:
```json
{
  "version": 1,
  "updated_at": "2026-03-23T00:00:00Z",
  "focus_areas": [
    {
      "name": "Employee Benefits & HR Tech",
      "keywords": ["employee benefits", "employer matching", "payroll", "retention", ...]
    }
  ]
}
```

## Managing Focus Areas

When the user asks to view, add, edit, or remove focus areas:

1. **Read** `focus-areas.json` from the data directory
2. **Show** current focus areas with keyword counts
3. **Modify** as requested — add/remove areas, add/remove keywords
4. **Write** updated JSON back to `focus-areas.json`
5. **Rescore** all posts after any focus area change (use `--rescore` flag)

When adding new focus areas, suggest 10-20 keywords per area. Mix specific terms with broader phrases. Short keywords (≤4 chars) are fine — the scorer uses word boundaries for them.

## Output Format

After scoring, present results as:
1. Score distribution (how many posts at each level)
2. Action flag summary (deep_read / reference / archive counts)
3. Top relevant posts (score 3+) with focus area tags and matched keywords
4. If no high-scoring posts, note this and suggest the user may need more data (run collector) or should adjust focus areas

## Mac-Side Execution

The scorer also runs natively on Mac as `score-posts.js` (Node.js + better-sqlite3):
```bash
cd ~/.linkedin-feed-tracker/scripts && node src/score-posts.js           # score new only
cd ~/.linkedin-feed-tracker/scripts && node src/score-posts.js --rescore # rescore all
```

This runs in the nightly flow after collection and before dashboard generation.

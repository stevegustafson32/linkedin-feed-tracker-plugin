---
name: analyze-feed
description: >
  Analyze collected LinkedIn feed data to surface trends, topic clusters, engagement patterns,
  and content opportunities. Use this skill when the user says "analyze my feed," "what's trending
  on LinkedIn," "what are my connections posting about," "show me feed insights," "content trends,"
  "what topics are hot," "LinkedIn analysis," or any request to understand patterns in their
  LinkedIn network's posting behavior. Also triggers when the user asks "what should I post about"
  or "find me a content gap."
version: 1.0.0
---

# Analyze LinkedIn Feed

Read the SQLite database of scraped LinkedIn posts and generate intelligent analysis — topic clustering, engagement scoring, trend detection, and content gap identification.

## Data Location

The SQLite database is at `${CLAUDE_PLUGIN_ROOT}/scripts/data/feeds.db`. Use Bash to query it.

## Analysis Process

### Step 1 — Load Recent Data

Query the database for posts from the last 7 days (or the user's requested window):

```sql
SELECT author_name, content, likes, comments, engagement, collected_at, post_type
FROM posts
WHERE collected_at >= datetime('now', '-7 days')
ORDER BY collected_at DESC;
```

Also load the user's topic configuration:

```sql
SELECT value FROM config WHERE key = 'topic_clusters';
```

If no topic clusters are configured, use these defaults: Founders & Startups, Operations & Productivity, Sales & Revenue, Work & Culture.

### Step 2 — Topic Clustering

Read each post and assign it to one or more topic clusters. Do NOT use keyword matching — actually read and understand the content. A post about "our fundraising journey nearly destroyed my marriage" belongs in Founders AND Work & Culture, not just whichever one has a keyword match.

For each cluster, track: post count, total engagement (likes + comments), top 3 posts by engagement, and notable authors.

### Step 3 — Trend Detection

Compare this week's topic distribution to the previous week:

```sql
SELECT author_name, content, likes, comments, engagement, collected_at
FROM posts
WHERE collected_at >= datetime('now', '-14 days')
AND collected_at < datetime('now', '-7 days')
ORDER BY collected_at DESC;
```

Identify topics that are growing, declining, or newly emerging. Flag any sudden spikes.

### Step 4 — Content Gap Analysis

Identify topics where the network is active but the user hasn't posted. Cross-reference topic clusters against the user's own posts (where `author_name` matches the user's LinkedIn name from config).

### Step 5 — Engagement Patterns

Identify which types of posts get the most engagement: long-form vs. short, question posts vs. statements, posts with images vs. text-only, time of day patterns.

## Output Format

Present findings conversationally — not as a raw data dump. Lead with the most interesting insight, then support with data. Use specific examples from actual posts (cite the author and a brief content snippet). End with 2-3 actionable content opportunities based on the gaps and trends found.

## Database Schema Reference

See `references/database-schema.md` for the full SQLite schema including all tables and relationships.

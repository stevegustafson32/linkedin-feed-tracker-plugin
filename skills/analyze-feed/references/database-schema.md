# LFT Database Schema

SQLite database at `${CLAUDE_PLUGIN_ROOT}/scripts/data/feeds.db` using WAL mode.

## Tables

### posts
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PRIMARY KEY | Auto-increment |
| collected_at | TEXT NOT NULL | ISO timestamp of collection run |
| post_date | TEXT | Approximate post date if parseable |
| author_name | TEXT | LinkedIn display name |
| author_title | TEXT | Professional headline |
| post_type | TEXT | original, repost, article, job, milestone |
| content | TEXT NOT NULL | Full post text |
| content_short | TEXT | First 200 chars for display |
| engagement | TEXT | Raw engagement text (e.g. "142 reactions · 38 comments") |
| likes | INTEGER DEFAULT 0 | Like count |
| comments | INTEGER DEFAULT 0 | Comment count |
| is_repost | INTEGER DEFAULT 0 | 1 if reshare |
| repost_author | TEXT | Original author if repost |
| has_link | INTEGER DEFAULT 0 | 1 if post contains a link |
| raw_text | TEXT | Full raw extracted text |
| content_hash | TEXT | SHA-256 hash for deduplication |

**Unique constraint:** (author_name, content_short, collected_at)
**Unique index:** content_hash (WHERE NOT NULL)

### connections
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PRIMARY KEY | Auto-increment |
| name | TEXT NOT NULL | Display name |
| profile_url | TEXT UNIQUE NOT NULL | LinkedIn profile URL |
| headline | TEXT | Professional headline |
| batch_group | INTEGER DEFAULT 0 | 0-6, assigned as id % 7 |
| priority | REAL DEFAULT 0.5 | Dynamic priority (higher = scrape more often) |
| last_scraped_at | TEXT | Last profile scrape (ISO timestamp) |
| last_post_at | TEXT | Most recent post found |
| posts_this_week | INTEGER DEFAULT 0 | Posts found in last scrape window |
| is_active | INTEGER DEFAULT 1 | 0 = removed/inactive |
| added_at | TEXT | When first seen |

### profile_scrape_runs
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PRIMARY KEY | Auto-increment |
| ran_at | TEXT NOT NULL | ISO timestamp |
| batch_group | INTEGER | Which batch was scraped |
| profiles_total | INTEGER DEFAULT 0 | Profiles to visit |
| profiles_done | INTEGER DEFAULT 0 | Profiles completed |
| posts_new | INTEGER DEFAULT 0 | New posts collected |
| duration_ms | INTEGER DEFAULT 0 | Run time in ms |
| status | TEXT DEFAULT 'ok' | ok, error, partial |
| notes | TEXT | Additional details |

### collection_runs
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PRIMARY KEY | Auto-increment |
| ran_at | TEXT NOT NULL | ISO timestamp |
| posts_found | INTEGER DEFAULT 0 | Total posts found |
| posts_new | INTEGER DEFAULT 0 | New posts (not duplicates) |
| duration_ms | INTEGER DEFAULT 0 | Run time in ms |
| status | TEXT DEFAULT 'ok' | ok, error, partial |
| notes | TEXT | Additional details |

### drafts
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PRIMARY KEY | Auto-increment |
| created_at | TEXT NOT NULL | ISO timestamp |
| filename | TEXT NOT NULL | Output filename |
| days_analyzed | INTEGER DEFAULT 7 | Days of data used |
| draft_count | INTEGER DEFAULT 0 | Number of drafts generated |

### config
| Column | Type | Description |
|--------|------|-------------|
| key | TEXT PRIMARY KEY | Config key |
| value | TEXT NOT NULL | Config value |

**Key config entries:**
- `linkedin_name` — user's LinkedIn display name
- `topic_clusters` — JSON array of {name, keywords} objects
- `lookback_hours` — hours to look back for old post filtering (default 26)

## Useful Queries

### Posts per day (last 2 weeks)
```sql
SELECT date(collected_at) as day, COUNT(*) as posts
FROM posts
GROUP BY date(collected_at)
ORDER BY day DESC
LIMIT 14;
```

### Most active connections
```sql
SELECT author_name, COUNT(*) as posts, SUM(likes + comments) as engagement
FROM posts
WHERE collected_at >= datetime('now', '-7 days')
GROUP BY author_name
ORDER BY posts DESC
LIMIT 20;
```

### Collection health
```sql
SELECT ran_at, posts_found, posts_new, duration_ms, status
FROM collection_runs
ORDER BY ran_at DESC
LIMIT 14;
```

### Batch coverage (last 7 days)
```sql
SELECT batch_group, MAX(ran_at) as last_run, SUM(posts_new) as posts
FROM profile_scrape_runs
WHERE ran_at >= datetime('now', '-7 days')
GROUP BY batch_group
ORDER BY batch_group;
```

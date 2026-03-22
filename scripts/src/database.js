/**
 * database.js — SQLite wrapper
 *
 * Data directory is resolved by paths.js (user's project folder).
 * The user picks a folder during setup → all data lives there →
 * Cowork can access it because it's in the user's workspace.
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const { DATA_DIR, DB_PATH } = require('./paths');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS posts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    collected_at   TEXT NOT NULL,          -- ISO timestamp of collection run
    post_date      TEXT,                   -- approximate post date if parseable
    author_name    TEXT,
    author_title   TEXT,
    post_type      TEXT,                   -- original | repost | article | job | milestone
    content        TEXT NOT NULL,
    content_short  TEXT,                   -- first 200 chars for display
    engagement     TEXT,                   -- raw engagement text (e.g. "142 reactions · 38 comments")
    likes          INTEGER DEFAULT 0,
    comments       INTEGER DEFAULT 0,
    is_repost      INTEGER DEFAULT 0,      -- 1 if this is a reshare
    repost_author  TEXT,                   -- original author if repost
    has_link       INTEGER DEFAULT 0,
    raw_text       TEXT,                   -- full raw extracted text for this post block
    UNIQUE(author_name, content_short, collected_at)
  );

  CREATE INDEX IF NOT EXISTS idx_posts_collected ON posts(collected_at);
  CREATE INDEX IF NOT EXISTS idx_posts_author    ON posts(author_name);
  CREATE INDEX IF NOT EXISTS idx_posts_date      ON posts(post_date);


  CREATE TABLE IF NOT EXISTS drafts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   TEXT NOT NULL,
    filename     TEXT NOT NULL,
    days_analyzed INTEGER DEFAULT 7,
    draft_count  INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS collection_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at       TEXT NOT NULL,
    posts_found  INTEGER DEFAULT 0,
    posts_new    INTEGER DEFAULT 0,
    duration_ms  INTEGER DEFAULT 0,
    status       TEXT DEFAULT 'ok',   -- ok | error | partial
    notes        TEXT
  );
`);

// ── Phase 2: content_hash migration (safe to run on existing DBs) ─────────────
try { db.exec('ALTER TABLE posts ADD COLUMN content_hash TEXT'); } catch {}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_hash ON posts(content_hash) WHERE content_hash IS NOT NULL');

// ── Config helpers ────────────────────────────────────────────────────────────

const getConfig = (key, fallback = null) => {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : fallback;
};

const setConfig = (key, value) => {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
};

// ── Post helpers ──────────────────────────────────────────────────────────────

// ── Content hash helper (dedup key across runs) ───────────────────────────────
const makeContentHash = (authorName, contentShort) =>
  crypto.createHash('sha256')
    .update(`${authorName || ''}||${contentShort || ''}`)
    .digest('hex')
    .substring(0, 32);

const insertPost = db.prepare(`
  INSERT OR IGNORE INTO posts
    (collected_at, post_date, author_name, author_title, post_type,
     content, content_short, engagement, likes, comments,
     is_repost, repost_author, has_link, raw_text, content_hash)
  VALUES
    (@collected_at, @post_date, @author_name, @author_title, @post_type,
     @content, @content_short, @engagement, @likes, @comments,
     @is_repost, @repost_author, @has_link, @raw_text, @content_hash)
`);

const insertMany = db.transaction((posts) => {
  let inserted = 0;
  for (const post of posts) {
    const result = insertPost.run(post);
    if (result.changes > 0) inserted++;
  }
  return inserted;
});

const getPostsSince = (isoDate) =>
  db.prepare(`SELECT * FROM posts WHERE collected_at >= ? ORDER BY collected_at DESC`).all(isoDate);

const getPostsInRange = (from, to) =>
  db.prepare(`SELECT * FROM posts WHERE collected_at BETWEEN ? AND ? ORDER BY collected_at DESC`).all(from, to);

const getRecentDates = (days = 7) => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return db.prepare(
    `SELECT DISTINCT date(collected_at) as day, COUNT(*) as count
     FROM posts WHERE collected_at >= ? GROUP BY day ORDER BY day DESC`
  ).all(cutoff.toISOString());
};

const getTopAuthors = (from, to) =>
  db.prepare(
    `SELECT author_name, author_title, COUNT(*) as post_count
     FROM posts WHERE collected_at BETWEEN ? AND ?
     AND author_name IS NOT NULL
     GROUP BY author_name ORDER BY post_count DESC LIMIT 25`
  ).all(from, to);

const logRun = (data) =>
  db.prepare(`
    INSERT INTO collection_runs (ran_at, posts_found, posts_new, duration_ms, status, notes)
    VALUES (@ran_at, @posts_found, @posts_new, @duration_ms, @status, @notes)
  `).run(data);

const getLastRuns = (n = 10) =>
  db.prepare(`SELECT * FROM collection_runs ORDER BY ran_at DESC LIMIT ?`).all(n);

// ── Phase 2: CSV export ───────────────────────────────────────────────────────

const exportPostsCSV = (from, to) => {
  const posts = getPostsInRange(from, to);
  const headers = ['id','collected_at','post_date','author_name','author_title','post_type','content','likes','comments','is_repost','repost_author','has_link'];
  const escape  = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows    = posts.map(p => headers.map(h => escape(p[h])).join(','));
  return [headers.join(','), ...rows].join('\n');
};

// ── Phase 3: Draft logging ────────────────────────────────────────────────────

const logDraft = (data) =>
  db.prepare(`
    INSERT INTO drafts (created_at, filename, days_analyzed, draft_count)
    VALUES (@created_at, @filename, @days_analyzed, @draft_count)
  `).run(data);

const getLastDrafts = (n = 10) =>
  db.prepare(`SELECT * FROM drafts ORDER BY created_at DESC LIMIT ?`).all(n);

// ── Phase 4: Connections table (profile-based scraping) ───────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS connections (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
    profile_url      TEXT UNIQUE NOT NULL,
    headline         TEXT,
    batch_group      INTEGER DEFAULT 0,   -- 0-6, rotates nightly (id % 7)
    priority         REAL DEFAULT 0.5,   -- 0.0-1.0; boosted for active posters
    last_scraped_at  TEXT,               -- ISO timestamp of last profile visit
    last_post_at     TEXT,               -- ISO timestamp of most recent post found
    posts_this_week  INTEGER DEFAULT 0,  -- posts found in last scrape window
    is_active        INTEGER DEFAULT 1,  -- 0 = removed/inactive connection
    added_at         TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_connections_batch    ON connections(batch_group);
  CREATE INDEX IF NOT EXISTS idx_connections_priority ON connections(priority DESC);
  CREATE INDEX IF NOT EXISTS idx_connections_active   ON connections(is_active);

  CREATE TABLE IF NOT EXISTS profile_scrape_runs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at         TEXT NOT NULL,
    batch_group    INTEGER,
    profiles_total INTEGER DEFAULT 0,
    profiles_done  INTEGER DEFAULT 0,
    posts_new      INTEGER DEFAULT 0,
    duration_ms    INTEGER DEFAULT 0,
    status         TEXT DEFAULT 'ok',
    notes          TEXT
  );
`);

// Connections helpers
const upsertConnection = db.prepare(`
  INSERT INTO connections (name, profile_url, headline, batch_group)
  VALUES (@name, @profile_url, @headline, @batch_group)
  ON CONFLICT(profile_url) DO UPDATE SET
    name     = excluded.name,
    headline = excluded.headline,
    is_active = 1
`);

const upsertManyConnections = db.transaction((rows) => {
  let inserted = 0;
  for (const row of rows) {
    const result = upsertConnection.run(row);
    if (result.changes > 0) inserted++;
  }
  return inserted;
});

const getConnectionBatch = (batchGroup) =>
  db.prepare(`
    SELECT * FROM connections
    WHERE is_active = 1
      AND (batch_group = ? OR priority >= 0.85)
    ORDER BY priority DESC, last_scraped_at ASC NULLS FIRST
  `).all(batchGroup);

const markConnectionScraped = db.prepare(`
  UPDATE connections
  SET last_scraped_at = @last_scraped_at,
      last_post_at    = COALESCE(@last_post_at, last_post_at),
      posts_this_week = @posts_this_week,
      priority        = @priority
  WHERE profile_url = @profile_url
`);

const getConnectionStats = () =>
  db.prepare(`
    SELECT
      COUNT(*)                                         AS total,
      SUM(is_active)                                   AS active,
      COUNT(CASE WHEN last_scraped_at IS NOT NULL THEN 1 END) AS ever_scraped,
      COUNT(CASE WHEN posts_this_week > 0 THEN 1 END)  AS active_posters,
      MAX(last_scraped_at)                             AS last_scrape
    FROM connections
  `).get();

const logProfileRun = (data) =>
  db.prepare(`
    INSERT INTO profile_scrape_runs
      (ran_at, batch_group, profiles_total, profiles_done, posts_new, duration_ms, status, notes)
    VALUES
      (@ran_at, @batch_group, @profiles_total, @profiles_done, @posts_new, @duration_ms, @status, @notes)
  `).run(data);

// ── Phase 5: Own-post performance tracking ──────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS own_posts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    post_url         TEXT UNIQUE,               -- permalink to the post
    content_short    TEXT,                       -- first 200 chars
    posted_at        TEXT,                       -- when user posted it (ISO or relative-parsed)
    posted_at_raw    TEXT,                       -- raw relative text from LinkedIn ("2d", "1w")
    collected_at     TEXT NOT NULL,              -- when we scraped this data
    likes            INTEGER DEFAULT 0,
    comments         INTEGER DEFAULT 0,
    reposts          INTEGER DEFAULT 0,
    impressions      INTEGER DEFAULT 0,          -- if available (usually not for free accounts)
    post_type        TEXT,                       -- text | image | video | article | poll | carousel
    content_hash     TEXT,
    is_baseline      INTEGER DEFAULT 0           -- 1 if this was part of the initial baseline seed
  );

  CREATE INDEX IF NOT EXISTS idx_own_posts_date ON own_posts(posted_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_own_posts_hash ON own_posts(content_hash) WHERE content_hash IS NOT NULL;
`);

const insertOwnPost = db.prepare(`
  INSERT OR IGNORE INTO own_posts
    (post_url, content_short, posted_at, posted_at_raw, collected_at,
     likes, comments, reposts, impressions, post_type, content_hash, is_baseline)
  VALUES
    (@post_url, @content_short, @posted_at, @posted_at_raw, @collected_at,
     @likes, @comments, @reposts, @impressions, @post_type, @content_hash, @is_baseline)
`);

const updateOwnPost = db.prepare(`
  UPDATE own_posts SET
    post_url     = COALESCE(@post_url, post_url),
    likes        = @likes,
    comments     = @comments,
    reposts      = @reposts,
    impressions  = @impressions,
    collected_at = @collected_at
  WHERE content_hash = @content_hash
`);

const upsertManyOwnPosts = db.transaction((posts) => {
  let upserted = 0;
  for (const post of posts) {
    const inserted = insertOwnPost.run(post);
    if (inserted.changes > 0) {
      upserted++;
    } else {
      const updated = updateOwnPost.run(post);
      if (updated.changes > 0) upserted++;
    }
  }
  return upserted;
});

const getOwnPosts = (days = 90) => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return db.prepare(`
    SELECT * FROM own_posts
    WHERE posted_at >= ? OR posted_at IS NULL
    ORDER BY posted_at DESC
  `).all(cutoff.toISOString());
};

const getOwnPostStats = () =>
  db.prepare(`
    SELECT
      COUNT(*)                                    AS total_posts,
      AVG(likes)                                  AS avg_likes,
      AVG(comments)                               AS avg_comments,
      AVG(reposts)                                AS avg_reposts,
      MAX(likes)                                  AS best_likes,
      MAX(comments)                               AS best_comments,
      SUM(CASE WHEN is_baseline = 1 THEN 1 ELSE 0 END) AS baseline_posts,
      SUM(CASE WHEN is_baseline = 0 THEN 1 ELSE 0 END) AS tracked_posts,
      MIN(posted_at)                              AS earliest,
      MAX(posted_at)                              AS latest
    FROM own_posts
  `).get();

module.exports = {
  db, getConfig, setConfig, makeContentHash,
  insertMany, getPostsSince, getPostsInRange, getRecentDates, getTopAuthors,
  logRun, getLastRuns,
  exportPostsCSV,
  logDraft, getLastDrafts,
  // Phase 4
  upsertManyConnections, getConnectionBatch, markConnectionScraped,
  getConnectionStats, logProfileRun,
  // Phase 5
  upsertManyOwnPosts, getOwnPosts, getOwnPostStats,
};

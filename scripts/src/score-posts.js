#!/usr/bin/env node
/**
 * score-posts.js — Relevance scorer for LinkedIn Feed Tracker
 *
 * Scores every unscored post in feeds.db against the user's focus areas
 * using weighted keyword density (Julia/Wyzer algorithm).
 *
 * Weighting tiers:
 *   - Title proxy (author_title + first line of content) → 3x
 *   - Summary proxy (content_short, first ~200 chars)    → 2x
 *   - Full text (content)                                → 1x
 *
 * Output per post:
 *   - relevance_score  (1-5)
 *   - focus_areas       JSON array of matched areas with scores
 *   - action_flag       deep_read | reference | archive
 *   - scored_at         ISO timestamp
 *
 * Usage:
 *   node score-posts.js              # score unscored posts only
 *   node score-posts.js --rescore    # rescore ALL posts (e.g. after changing focus areas)
 *
 * Runs in < 1s for typical datasets (< 5,000 posts).
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// ── Resolve data directory (same logic as paths.js) ─────────────
function resolveDataDir() {
  // 1. Environment variable
  if (process.env.LFT_DATA_DIR && fs.existsSync(process.env.LFT_DATA_DIR)) {
    return process.env.LFT_DATA_DIR;
  }
  // 2. data-dir.txt from installed location
  const dataDirFile = path.join(
    process.env.HOME || process.env.USERPROFILE,
    '.linkedin-feed-tracker',
    'data-dir.txt'
  );
  if (fs.existsSync(dataDirFile)) {
    const dir = fs.readFileSync(dataDirFile, 'utf8').trim();
    if (fs.existsSync(dir)) return dir;
  }
  // 3. Same directory as this script
  return __dirname;
}

const DATA_DIR = resolveDataDir();
const DB_PATH = path.join(DATA_DIR, 'feeds.db');
const FOCUS_PATH = path.join(DATA_DIR, 'focus-areas.json');

if (!fs.existsSync(DB_PATH)) {
  console.error('✗ feeds.db not found at', DB_PATH);
  process.exit(1);
}

if (!fs.existsSync(FOCUS_PATH)) {
  console.error('✗ focus-areas.json not found at', FOCUS_PATH);
  console.error('  Create it with your focus areas and keywords.');
  console.error('  See: https://stevegustafson32.github.io/cowork-guide/linkedin-feed-tracker.html');
  process.exit(1);
}

// ── Load focus areas ────────────────────────────────────────────
const focusConfig = JSON.parse(fs.readFileSync(FOCUS_PATH, 'utf8'));
const focusAreas = focusConfig.focus_areas;

if (!focusAreas || focusAreas.length === 0) {
  console.error('✗ No focus areas defined in focus-areas.json');
  process.exit(1);
}

console.log(`Loaded ${focusAreas.length} focus areas: ${focusAreas.map(f => f.name).join(', ')}`);

// ── Database setup ──────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Migration: add scoring columns if they don't exist
const columns = db.prepare("PRAGMA table_info(posts)").all().map(c => c.name);

if (!columns.includes('relevance_score')) {
  console.log('Adding scoring columns to posts table...');
  db.exec(`
    ALTER TABLE posts ADD COLUMN relevance_score INTEGER DEFAULT 0;
    ALTER TABLE posts ADD COLUMN focus_areas TEXT DEFAULT '[]';
    ALTER TABLE posts ADD COLUMN action_flag TEXT DEFAULT 'archive';
    ALTER TABLE posts ADD COLUMN scored_at TEXT;
  `);
  console.log('✓ Columns added');
}

// ── Keyword matching ────────────────────────────────────────────

/**
 * Build a word-boundary regex for a keyword.
 * Short keywords (≤4 chars) get strict word boundaries to prevent
 * substring false positives (e.g. "ACH" matching "reaching").
 * Multi-word phrases and longer keywords use .includes() for speed.
 */
function keywordMatcher(keyword) {
  const kw = keyword.toLowerCase();
  if (kw.length <= 4 && !kw.includes(' ')) {
    // Strict word boundary for short keywords
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    return (text) => re.test(text);
  }
  // Longer keywords / phrases — .includes() is fine
  return (text) => text.includes(kw);
}

// Pre-compile matchers for all focus area keywords
for (const area of focusAreas) {
  area._matchers = area.keywords.map(kw => ({
    keyword: kw,
    match: keywordMatcher(kw)
  }));
}

// ── Engagement boost ────────────────────────────────────────────

/**
 * Engagement multiplier: boosts the relevance score for high-engagement posts.
 *
 * A post with 50 likes about your focus area is a stronger signal than
 * a post with 0 likes about the same topic. But engagement alone doesn't
 * create relevance — it only amplifies keyword matches.
 *
 * Returns a multiplier (1.0 to 1.5) applied to matched_weight before
 * density calculation.
 */
function engagementMultiplier(likes, comments) {
  const total = (likes || 0) + (comments || 0);
  if (total <= 5)   return 1.0;   // low/no engagement — no boost
  if (total <= 20)  return 1.1;   // moderate
  if (total <= 50)  return 1.2;   // solid
  if (total <= 100) return 1.3;   // strong
  if (total <= 200) return 1.4;   // viral for a network post
  return 1.5;                      // cap at 1.5x
}

// ── Scoring algorithm ───────────────────────────────────────────

/**
 * Score a single post against all focus areas.
 * Returns { bestScore, matchedAreas, actionFlag, engagementBoost }
 *
 * matchedAreas = [{ name, score, density, matchedKeywords }]
 */
function scorePost(post) {
  // Build the 3 text tiers
  const titleProxy = [
    post.author_title || '',
    (post.content || '').split(/[.\n]/)[0] || ''
  ].join(' ').toLowerCase();

  const summaryProxy = (post.content_short || (post.content || '').slice(0, 200)).toLowerCase();
  const fullText = (post.content || '').toLowerCase();

  const engBoost = engagementMultiplier(post.likes, post.comments);
  const matchedAreas = [];
  let bestScore = 0;

  for (const area of focusAreas) {
    const matchers = area._matchers;
    if (!matchers || matchers.length === 0) continue;

    const maxWeight = matchers.length * 6.0; // each keyword can match all 3 tiers: 3+2+1
    let matchedWeight = 0;
    const matchedKeywords = [];

    for (const { keyword, match } of matchers) {
      let kwWeight = 0;

      if (match(titleProxy))   kwWeight += 3.0;
      if (match(summaryProxy)) kwWeight += 2.0;
      if (match(fullText))     kwWeight += 1.0;

      if (kwWeight > 0) {
        matchedWeight += kwWeight;
        matchedKeywords.push(keyword);
      }
    }

    // Apply engagement boost — amplifies keyword signal, doesn't create it
    const boostedWeight = matchedWeight * engBoost;
    const density = boostedWeight / maxWeight;

    let score;
    if (density === 0)        score = 0;  // no match at all
    else if (density < 0.05)  score = 1;  // barely a whisper
    else if (density < 0.15)  score = 2;  // light signal
    else if (density < 0.33)  score = 3;  // meaningful
    else if (density < 0.66)  score = 4;  // strong
    else                      score = 5;  // bullseye

    if (score > 0) {
      matchedAreas.push({
        name: area.name,
        score,
        density: Math.round(density * 1000) / 1000,
        matchedKeywords
      });
    }

    if (score > bestScore) bestScore = score;
  }

  // Sort matched areas by score descending
  matchedAreas.sort((a, b) => b.score - a.score || b.density - a.density);

  // Action flag based on best score
  let actionFlag;
  if (bestScore >= 5)      actionFlag = 'deep_read';
  else if (bestScore >= 3) actionFlag = 'reference';
  else                     actionFlag = 'archive';

  return { bestScore, matchedAreas, actionFlag, engagementBoost: engBoost };
}

// ── Run scoring ─────────────────────────────────────────────────
const rescore = process.argv.includes('--rescore');

const query = rescore
  ? 'SELECT id, author_name, author_title, content, content_short, likes, comments FROM posts'
  : 'SELECT id, author_name, author_title, content, content_short, likes, comments FROM posts WHERE scored_at IS NULL';

const posts = db.prepare(query).all();

if (posts.length === 0) {
  console.log('✓ No posts to score — all up to date.');
  db.close();
  process.exit(0);
}

console.log(`Scoring ${posts.length} posts${rescore ? ' (rescore all)' : ' (new only)'}...`);

const update = db.prepare(`
  UPDATE posts
  SET relevance_score = ?,
      focus_areas = ?,
      action_flag = ?,
      scored_at = ?
  WHERE id = ?
`);

const now = new Date().toISOString();
let counts = { deep_read: 0, reference: 0, archive: 0 };
let scoreDistribution = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

const runAll = db.transaction(() => {
  for (const post of posts) {
    const { bestScore, matchedAreas, actionFlag } = scorePost(post);

    update.run(
      bestScore,
      JSON.stringify(matchedAreas),
      actionFlag,
      now,
      post.id
    );

    counts[actionFlag]++;
    scoreDistribution[bestScore]++;
  }
});

runAll();
db.close();

// ── Summary ─────────────────────────────────────────────────────
console.log('\n✓ Scoring complete!\n');
console.log('Score distribution:');
for (let s = 5; s >= 0; s--) {
  const bar = '█'.repeat(scoreDistribution[s]);
  const label = s === 5 ? '★ 5 (bullseye)' :
                s === 4 ? '  4 (strong)   ' :
                s === 3 ? '  3 (meaningful)' :
                s === 2 ? '  2 (light)    ' :
                s === 1 ? '  1 (whisper)  ' :
                          '  0 (no match) ';
  console.log(`  ${label}  ${bar} ${scoreDistribution[s]}`);
}

console.log('\nAction flags:');
console.log(`  🔍 Deep Read:  ${counts.deep_read} posts`);
console.log(`  📎 Reference:  ${counts.reference} posts`);
console.log(`  📦 Archive:    ${counts.archive} posts`);

// Show top scored posts
const topPosts = db ? [] : []; // db is closed, re-open briefly
const db2 = new Database(DB_PATH, { readonly: true });
const top = db2.prepare(`
  SELECT author_name, relevance_score, action_flag, focus_areas, substr(content, 1, 60) as preview
  FROM posts
  WHERE relevance_score >= 3
  ORDER BY relevance_score DESC, (likes + comments) DESC
  LIMIT 5
`).all();
db2.close();

if (top.length > 0) {
  console.log('\nTop relevant posts:');
  for (const p of top) {
    const areas = JSON.parse(p.focus_areas).map(a => a.name).join(', ');
    console.log(`  [${p.relevance_score}] ${p.action_flag.toUpperCase()} — ${p.author_name}: ${p.preview}`);
    console.log(`      Focus: ${areas}`);
  }
}

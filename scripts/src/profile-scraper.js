/**
 * profile-scraper.js — Per-profile post scraper (Phase 4)
 *
 * Visits each connection's LinkedIn activity page and captures their
 * recent posts. Designed for networks up to 5,000 connections using
 * a 7-day batch rotation (~700 profiles/night).
 *
 * Nightly run:
 *   - Scrapes today's batch group (day_of_week % 7)
 *   - Prioritizes connections with priority >= 0.85 (active posters) every night
 *   - Throttles with random delays to avoid LinkedIn rate limiting
 *   - Deduplicates via existing content_hash system (same posts table)
 *
 * Usage:
 *   npm run scrape-profiles             — run tonight's batch
 *   npm run scrape-profiles -- --all    — scrape all connections (full refresh)
 *   npm run scrape-profiles -- --dry-run — show what would run, no writes
 */

const { chromium }       = require('playwright');
const path               = require('path');
const crypto             = require('crypto');
const {
  getConnectionBatch, markConnectionScraped, insertMany, logProfileRun,
  makeContentHash, getConfig,
} = require('./database');

const PROFILE_DIR = path.join(__dirname, '..', 'data', 'browser-profile');

const SCRAPE_ALL = process.argv.includes('--all');
const DRY_RUN    = process.argv.includes('--dry-run');
const VERBOSE    = process.argv.includes('--verbose') || process.env.LFT_VERBOSE;

// Throttle: random delay between profile visits (ms)
const DELAY_MIN = 1800;
const DELAY_MAX = 4200;

// How many days back to look for posts per profile
const LOOKBACK_DAYS = 7;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ── Selectors for LinkedIn activity/shares page ───────────────────────────────
// LinkedIn changes class names frequently; these target structural roles
const POST_CONTAINER = '[data-urn*="activity"]';
const CONTENT_SEL    = '.feed-shared-update-v2__description, .update-components-text';
const ENGAGEMENT_SEL = '.social-details-social-counts';
const DATE_SEL       = '.update-components-actor__sub-description time, time[datetime]';

// ── Profile URL → activity URL ────────────────────────────────────────────────
function activityUrl(profileUrl) {
  const base = profileUrl.replace(/\/$/, '');
  return `${base}/recent-activity/shares/`;
}

// ── Extract posts from a loaded activity page ─────────────────────────────────
async function extractPostsFromPage(page, authorName) {
  const now = new Date().toISOString();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);

  const rawPosts = await page.evaluate((sel) => {
    const containers = document.querySelectorAll(sel);
    return Array.from(containers).map(el => {
      // Content
      const contentEl  = el.querySelector('.feed-shared-update-v2__description') ||
                         el.querySelector('.update-components-text') ||
                         el.querySelector('[data-test-id="main-feed-activity-card__commentary"]');
      const content    = contentEl ? contentEl.innerText.trim() : '';

      // Engagement
      const engEl     = el.querySelector('.social-details-social-counts');
      const engText   = engEl ? engEl.innerText.trim().replace(/\s+/g, ' ') : '';

      // Parse likes/comments from engagement text
      const likesMatch    = engText.match(/([\d,]+)\s*(reaction|like)/i);
      const commentsMatch = engText.match(/([\d,]+)\s*comment/i);
      const likes    = likesMatch    ? parseInt(likesMatch[1].replace(/,/g, ''), 10)    : 0;
      const comments = commentsMatch ? parseInt(commentsMatch[1].replace(/,/g, ''), 10) : 0;

      // Date
      const timeEl   = el.querySelector('time[datetime]') ||
                       el.querySelector('.update-components-actor__sub-description time');
      const datetime = timeEl ? (timeEl.getAttribute('datetime') || timeEl.innerText.trim()) : null;

      // Post URL — look for the permalink in the post header
      const linkEl   = el.querySelector('a[href*="/feed/update/"]') ||
                       el.querySelector('.feed-shared-update-v2__permalink');
      const postUrl  = linkEl ? linkEl.href : null;

      return { content, engText, likes, comments, datetime, postUrl };
    });
  }, POST_CONTAINER);

  // Filter and format
  const posts = [];
  for (const raw of rawPosts) {
    if (!raw.content || raw.content.length < 10) continue;

    const contentShort = raw.content.substring(0, 200);
    const contentHash  = makeContentHash(authorName, contentShort);

    posts.push({
      collected_at:  now,
      post_date:     raw.datetime || null,
      author_name:   authorName,
      author_title:  null,
      post_type:     'original',
      content:       raw.content,
      content_short: contentShort,
      engagement:    raw.engText,
      likes:         raw.likes,
      comments:      raw.comments,
      is_repost:     0,
      repost_author: null,
      has_link:      raw.postUrl ? 1 : 0,
      raw_text:      raw.content,
      content_hash:  contentHash,
    });
  }

  return posts;
}

// ── Scrape a single profile ───────────────────────────────────────────────────
async function scrapeProfile(page, connection) {
  const url = activityUrl(connection.profile_url);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(rand(800, 1500)); // let dynamic content settle

    // Check for login redirect (session expired)
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) {
      return { status: 'session_expired', posts: [] };
    }

    // Check for rate limit / "Just a moment" pages
    const title = await page.title();
    if (title.toLowerCase().includes('just a moment') || title.toLowerCase().includes('security')) {
      return { status: 'rate_limited', posts: [] };
    }

    // Wait for posts to appear (with a short timeout — move on if empty profile)
    await page.waitForSelector(POST_CONTAINER, { timeout: 8000 }).catch(() => {});

    const posts = await extractPostsFromPage(page, connection.name);
    return { status: 'ok', posts };

  } catch (err) {
    if (err.message.includes('Timeout') || err.message.includes('timeout')) {
      return { status: 'timeout', posts: [] };
    }
    return { status: 'error', posts: [], error: err.message };
  }
}

// ── Calculate priority score based on activity ───────────────────────────────
function calcPriority(postsFound, currentPriority) {
  if (postsFound >= 5) return Math.min(1.0, currentPriority + 0.2);  // very active
  if (postsFound >= 2) return Math.min(0.85, currentPriority + 0.1); // active
  if (postsFound === 1) return currentPriority;                        // some activity
  return Math.max(0.1, currentPriority - 0.1);                        // not posting
}

// ── Main scrape function ──────────────────────────────────────────────────────
async function scrapeProfiles(options = {}) {
  const startTime = Date.now();

  // Determine which batch to run
  const batchGroup = SCRAPE_ALL ? null : (new Date().getDay() % 7);
  const connections = getConnectionBatch(batchGroup ?? 0);

  // If --all, we need to iterate all 7 batches worth — just get everything
  let toScrape = connections;
  if (SCRAPE_ALL) {
    // Get all 7 batches
    const all = [];
    for (let g = 0; g < 7; g++) {
      all.push(...getConnectionBatch(g));
    }
    // Deduplicate by profile_url
    const seen = new Set();
    toScrape = all.filter(c => {
      if (seen.has(c.profile_url)) return false;
      seen.add(c.profile_url);
      return true;
    });
  }

  if (toScrape.length === 0) {
    console.log('[profile-scraper] No connections to scrape. Run: npm run sync-connections first.');
    return { success: true, profilesDone: 0, postsNew: 0 };
  }

  console.log(`\n[profile-scraper] Starting ${SCRAPE_ALL ? 'FULL' : `batch ${batchGroup}`} scrape`);
  console.log(`[profile-scraper] Profiles to scrape: ${toScrape.length}`);

  const estimatedMinutes = Math.ceil((toScrape.length * ((DELAY_MIN + DELAY_MAX) / 2)) / 60000);
  console.log(`[profile-scraper] Estimated time: ~${estimatedMinutes} minutes`);

  if (DRY_RUN) {
    console.log('[profile-scraper] --dry-run mode: no changes will be made.');
    console.log(`[profile-scraper] Sample profiles: ${toScrape.slice(0, 5).map(c => c.name).join(', ')}...`);
    return { success: true, dryRun: true, total: toScrape.length };
  }

  // ── Launch browser ───────────────────────────────────────────────────────
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });

  const page = await browser.newPage();

  let profilesDone = 0;
  let postsNew     = 0;
  let sessionExpired = false;
  let rateLimited    = false;

  // ── Iterate profiles ─────────────────────────────────────────────────────
  for (const connection of toScrape) {
    if (sessionExpired || rateLimited) break;

    if (VERBOSE) {
      process.stdout.write(`[profile-scraper] (${profilesDone + 1}/${toScrape.length}) ${connection.name}... `);
    }

    const result = await scrapeProfile(page, connection);

    if (result.status === 'session_expired') {
      console.error('\n[profile-scraper] ❌ Session expired — stopping. Run: npm run setup');
      sessionExpired = true;
      break;
    }

    if (result.status === 'rate_limited') {
      console.warn('\n[profile-scraper] ⚠️  Rate limited by LinkedIn — stopping early.');
      rateLimited = true;
      break;
    }

    // Save posts
    let savedCount = 0;
    if (result.posts.length > 0) {
      savedCount = insertMany(result.posts);
      postsNew += savedCount;
    }

    // Update connection record
    const lastPostAt = result.posts.length > 0
      ? (result.posts[0].post_date || result.posts[0].collected_at)
      : null;

    markConnectionScraped.run({
      profile_url:     connection.profile_url,
      last_scraped_at: new Date().toISOString(),
      last_post_at:    lastPostAt,
      posts_this_week: result.posts.length,
      priority:        calcPriority(result.posts.length, connection.priority || 0.5),
    });

    profilesDone++;

    if (VERBOSE) {
      console.log(`${result.posts.length} posts (${savedCount} new) [${result.status}]`);
    } else if (profilesDone % 100 === 0) {
      console.log(`[profile-scraper]   ${profilesDone}/${toScrape.length} profiles done, ${postsNew} new posts so far...`);
    }

    // Throttle — random delay between profile visits
    if (profilesDone < toScrape.length) {
      await sleep(rand(DELAY_MIN, DELAY_MAX));
    }
  }

  await browser.close().catch(() => {});

  const elapsed = Date.now() - startTime;
  const status  = sessionExpired ? 'session_expired' : rateLimited ? 'rate_limited' : 'ok';

  // Log the run
  logProfileRun({
    ran_at:          new Date().toISOString(),
    batch_group:     batchGroup,
    profiles_total:  toScrape.length,
    profiles_done:   profilesDone,
    posts_new:       postsNew,
    duration_ms:     elapsed,
    status,
    notes:           sessionExpired ? 'Session expired mid-run' : rateLimited ? 'Rate limited mid-run' : null,
  });

  console.log(`\n[profile-scraper] ✅ Done: ${profilesDone} profiles | ${postsNew} new posts | ${(elapsed / 1000 / 60).toFixed(1)} min`);

  return { success: !sessionExpired, profilesDone, postsNew, elapsed };
}

// ── Run directly ──────────────────────────────────────────────────────────────
if (require.main === module) {
  scrapeProfiles()
    .then(result => {
      if (!result.success) process.exit(1);
    })
    .catch(err => {
      console.error('[profile-scraper] Fatal:', err);
      process.exit(1);
    });
}

module.exports = { scrapeProfiles };

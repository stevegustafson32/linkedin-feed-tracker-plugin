/**
 * profile-collector.js — Visit connection profiles in daily batches
 *
 * This is the core of the auto-scaling rotation. Each connection is assigned a
 * batch_group based on total connection count (7/14/21 batches). Each day we
 * visit one batch of connections, scrape their recent posts, and store them
 * with content_hash dedup.
 *
 * Dedup guarantee:
 *   - Every post gets a content_hash = SHA-256(author_name || content_short)
 *   - The posts table has a UNIQUE index on content_hash
 *   - INSERT OR IGNORE means the same post is never stored twice, regardless
 *     of whether it came from the feed collector, a profile visit, or both
 *
 * Rate limiting:
 *   - Random 3-8s delay between profile visits
 *   - Human-like scrolling on activity pages
 *   - Stops and resumes if LinkedIn shows a challenge page
 *
 * Usage:
 *   node src/profile-collector.js                  — today's batch (auto-detects day)
 *   node src/profile-collector.js --batch 3        — run batch group 3
 *   node src/profile-collector.js --limit 10       — only visit 10 profiles (testing)
 *   node src/profile-collector.js --verbose        — detailed logging
 */

const { chromium } = require('playwright');
const path         = require('path');
const {
  getConnectionBatch, markConnectionScraped, logProfileRun,
  insertMany, makeContentHash, getConnectionStats,
  getActiveConnectionCount, computeBatchCount,
} = require('./database');
const { loadSelectors, dumpDiagnostic, flagForRepair, clearRepairFlag } = require('./self-heal');
const { PROFILE_DIR } = require('./paths');

// Load profile selectors from config (Claude can rewrite these)
const selCfg = loadSelectors('profile');
const VERBOSE     = process.argv.includes('--verbose') || process.env.LFT_VERBOSE;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ── Relative date parser ────────────────────────────────────────────────────
// LinkedIn shows: "2h", "3d", "1w", "2mo", "1yr", "Just now", "Yesterday"
// We convert these into real ISO dates so we can filter and query by date.

function parseRelativeDate(relativeStr) {
  if (!relativeStr || typeof relativeStr !== 'string') return null;

  const now = new Date();
  const text = relativeStr.trim().toLowerCase();

  // "just now" or "now"
  if (text.includes('just now') || text === 'now') {
    return now.toISOString();
  }

  // "yesterday"
  if (text.includes('yesterday')) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return d.toISOString();
  }

  // Pattern: number + unit — "2h", "3d", "1w", "2mo", "1yr", "5m"
  // LinkedIn formats: "2h ago", "3d", "1w", "2mo", "1yr", "30m"
  const match = text.match(/(\d+)\s*(s|m|h|d|w|mo|yr)/i);
  if (match) {
    const num = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const d = new Date(now);

    switch (unit) {
      case 's':  d.setSeconds(d.getSeconds() - num); break;
      case 'm':  d.setMinutes(d.getMinutes() - num); break;
      case 'h':  d.setHours(d.getHours() - num); break;
      case 'd':  d.setDate(d.getDate() - num); break;
      case 'w':  d.setDate(d.getDate() - (num * 7)); break;
      case 'mo': d.setMonth(d.getMonth() - num); break;
      case 'yr': d.setFullYear(d.getFullYear() - num); break;
    }

    return d.toISOString();
  }

  return null; // unparseable — keep the post but with null date
}

// Returns true if the post is within the last 7 days (or date is unknown)
function isWithin7Days(relativeStr) {
  if (!relativeStr) return true; // unknown date = keep it, let dedup handle overlap

  const text = relativeStr.trim().toLowerCase();

  // Quick reject without full parsing: anything with "mo" or "yr" is too old
  if (/\d+\s*(mo|yr)/i.test(text)) return false;

  // "2w" or higher = older than 7 days
  const weekMatch = text.match(/(\d+)\s*w/i);
  if (weekMatch && parseInt(weekMatch[1], 10) >= 2) return false;

  // Parse to be sure
  const parsed = parseRelativeDate(text);
  if (!parsed) return true; // can't parse = keep it

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  return new Date(parsed) >= sevenDaysAgo;
}

// ── Parse CLI args ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let limit = 0; // 0 = no limit
  let manualBatch = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--batch' && args[i + 1]) {
      manualBatch = parseInt(args[i + 1], 10);
      i++;
    }
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    }
  }

  // Auto-scaling: detect connection count and compute batch count
  const totalConnections = getActiveConnectionCount();
  const batchCount = computeBatchCount(totalConnections);

  // Calculate today's batch group using day-of-year for any batch count
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now - startOfYear) / 86400000);
  let batchGroup = manualBatch !== null ? manualBatch : (dayOfYear % batchCount);

  console.log(`[profile-collector] Auto-scaling: ${totalConnections} connections → ${batchCount} batches | today's batch: ${batchGroup} (day ${dayOfYear} % ${batchCount})`);

  return { batchGroup, limit, batchCount, totalConnections };
}

// ── Extract posts from a profile's activity page ────────────────────────────

async function scrapeProfilePosts(page, profileUrl, connectionName) {
  const activityUrl = `${profileUrl}/recent-activity/all/`;

  try {
    await page.goto(activityUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(rand(2000, 3500));

    // Check for challenge/login redirect
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint') || currentUrl.includes('/authwall')) {
      return { posts: [], status: 'auth_blocked' };
    }

    // Scroll down a bit to load posts
    for (let i = 0; i < 3; i++) {
      await page.evaluate((px) => window.scrollBy(0, px), rand(400, 700));
      await sleep(rand(800, 1200));
    }

    // Extract posts from the activity page
    // Selectors are loaded from data/selectors.json — Claude can rewrite them
    const containerSels = (selCfg.postContainers || [
      '.feed-shared-update-v2',
      '[data-urn*="activity"]',
      '.profile-creator-shared-feed-update__container',
      '.occludable-update',
    ]).join(', ');

    const textSels = (selCfg.postText || [
      '.feed-shared-text',
      '.break-words',
      '.update-components-text',
      '[dir="ltr"]',
    ]).join(', ');

    const engagementSels = (selCfg.engagement || [
      '.social-details-social-counts',
      '.social-details-social-activity',
    ]).join(', ');

    const repostSels = (selCfg.repostIndicator || [
      '.feed-shared-header__text',
      '.update-components-header',
    ]).join(', ');

    const fallbackTextSels = (selCfg.fallbackTextBlocks || [
      '[dir="ltr"]',
      '.break-words',
    ]).join(', ');

    const rawPosts = await page.evaluate(({ authorName, containerSels, textSels, engagementSels, repostSels, fallbackTextSels }) => {
      const posts = [];

      // LinkedIn activity pages show posts in feed-like cards
      const postContainers = document.querySelectorAll(containerSels);

      // If structured selectors work, use them
      if (postContainers.length > 0) {
        postContainers.forEach(container => {
          const textEl = container.querySelector(textSels);
          if (!textEl) return;

          const content = textEl.textContent.trim();
          if (content.length < 20) return; // skip very short/empty

          // Try to get engagement numbers
          const engagementEl = container.querySelector(engagementSels);
          const engagement = engagementEl ? engagementEl.textContent.trim() : '';

          // Parse likes/comments from engagement text
          let likes = 0, comments = 0;
          const likeMatch = engagement.match(/([\d,]+)\s*(?:like|reaction)/i);
          const commentMatch = engagement.match(/([\d,]+)\s*comment/i);
          if (likeMatch) likes = parseInt(likeMatch[1].replace(/,/g, ''), 10);
          if (commentMatch) comments = parseInt(commentMatch[1].replace(/,/g, ''), 10);

          // Check for repost
          const repostIndicator = container.querySelector(repostSels);
          const isRepost = repostIndicator ?
            /repost|shared|reshare/i.test(repostIndicator.textContent) : false;

          // Check for links
          const hasLink = container.querySelector('a[href*="http"]') !== null;

          // Try to get post date — prefer <time> datetime attribute (real ISO date)
          const timeEl = container.querySelector('time');
          const timeAttr = timeEl ? timeEl.getAttribute('datetime') : null; // e.g. "2026-03-20T14:30:00.000Z"
          const timeText = timeEl ? timeEl.textContent.trim() : null;       // e.g. "2d" or "3d ago"
          // Fallback to sub-description text
          const subDesc = container.querySelector('.feed-shared-actor__sub-description');
          const subText = subDesc ? subDesc.textContent.trim() : null;

          posts.push({
            author_name: authorName,
            content,
            content_short: content.substring(0, 200),
            engagement,
            likes,
            comments,
            is_repost: isRepost ? 1 : 0,
            has_link: hasLink ? 1 : 0,
            post_date: timeAttr || null,        // real ISO date if available
            post_date_relative: timeText || subText || null, // "2d", "1w" etc for filtering
          });
        });
      }

      // Fallback: look for any substantial text blocks on the activity page
      if (posts.length === 0) {
        const textBlocks = document.querySelectorAll(fallbackTextSels);
        const seen = new Set();
        textBlocks.forEach(el => {
          const text = el.textContent.trim();
          if (text.length >= 50 && text.length < 5000 && !seen.has(text.substring(0, 100))) {
            seen.add(text.substring(0, 100));
            posts.push({
              author_name: authorName,
              content: text,
              content_short: text.substring(0, 200),
              engagement: '',
              likes: 0,
              comments: 0,
              is_repost: 0,
              has_link: 0,
              post_date: null,
              post_date_relative: null,
            });
          }
        });
      }

      return posts;
    }, { authorName: connectionName, containerSels, textSels, engagementSels, repostSels, fallbackTextSels });

    // ── Filter: only keep posts from the last 7 days ──────────────────────
    const filteredPosts = rawPosts.filter(p => {
      // If we got a real ISO date from <time datetime="...">, use that
      if (p.post_date) {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        return new Date(p.post_date) >= sevenDaysAgo;
      }
      // Otherwise use the relative text ("2d", "1w", etc.)
      return isWithin7Days(p.post_date_relative);
    });

    // Convert any relative dates to real ISO dates for storage
    const postsWithDates = filteredPosts.map(p => {
      if (!p.post_date && p.post_date_relative) {
        p.post_date = parseRelativeDate(p.post_date_relative);
      }
      return p;
    });

    if (VERBOSE && rawPosts.length !== postsWithDates.length) {
      console.log(`     → Filtered: ${rawPosts.length} total, ${postsWithDates.length} within 7 days`);
    }

    return { posts: postsWithDates, status: 'ok' };

  } catch (err) {
    if (VERBOSE) console.log(`     Error scraping ${connectionName}: ${err.message}`);
    return { posts: [], status: 'error', error: err.message };
  }
}

// ── Main batch collection ───────────────────────────────────────────────────

async function collectBatch(options = {}) {
  const { batchGroup, limit } = { ...parseArgs(), ...options };
  const startTime = Date.now();
  const collectedAt = new Date().toISOString();
  const log = (...args) => console.log(...args);

  log('\n📡  Profile Batch Collector');
  log('═'.repeat(50));

  // Get today's batch of connections
  let batch = getConnectionBatch(batchGroup);
  const stats = getConnectionStats();

  log(`   Total connections: ${stats.total}`);
  log(`   Today's batch (group ${batchGroup}): ${batch.length} profiles`);
  log(`   Ever scraped: ${stats.ever_scraped}`);

  if (batch.length === 0) {
    log('\n   No connections in this batch. Run "Sync Connections" first.');
    return { success: false, reason: 'no_connections' };
  }

  // Apply limit for testing
  if (limit > 0 && batch.length > limit) {
    log(`   (Limited to ${limit} profiles for this run)`);
    batch = batch.slice(0, limit);
  }

  // Estimate time
  const estMinutes = Math.ceil(batch.length * 6 / 60); // ~6s avg per profile
  log(`   Estimated time: ~${estMinutes} minutes`);
  log('');

  // Launch browser
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });

  const page = await browser.newPage();

  // Block images/media for speed
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,mp4,mp3}', r => r.abort());
  await page.route('**/tracking/**', r => r.abort());
  await page.route('**/li/track**', r => r.abort());

  let profilesDone = 0;
  let totalNewPosts = 0;
  let authBlocked = 0;
  let errors = 0;

  for (let i = 0; i < batch.length; i++) {
    const conn = batch[i];
    const progress = `[${i + 1}/${batch.length}]`;

    if (VERBOSE) {
      log(`   ${progress} Visiting ${conn.name} ...`);
    } else if (i % 25 === 0 || i === batch.length - 1) {
      const pct = Math.round((i + 1) / batch.length * 100);
      log(`   ${progress} ${pct}% complete — ${totalNewPosts} new posts so far`);
    }

    const { posts, status } = await scrapeProfilePosts(page, conn.profile_url, conn.name);

    if (status === 'auth_blocked') {
      authBlocked++;
      if (authBlocked >= 3) {
        log('\n   ⚠️  LinkedIn is blocking access. Session may have expired.');
        log('   Stopping early. Re-run "Login to LinkedIn.command" and try again.');
        break;
      }
      // Wait longer before retrying
      await sleep(rand(10000, 15000));
      continue;
    }

    if (status === 'error') {
      errors++;
      if (errors >= 10) {
        log('\n   ⚠️  Too many errors. Stopping early.');
        break;
      }
    }

    // Prepare posts for insertion with content_hash dedup
    if (posts.length > 0) {
      const postsToInsert = posts.map(p => ({
        ...p,
        collected_at: collectedAt,
        author_title: conn.headline || null,
        post_type: p.is_repost ? 'repost' : 'original',
        repost_author: null,
        raw_text: p.content,
        content_hash: makeContentHash(p.author_name, p.content_short),
      }));

      // insertMany uses INSERT OR IGNORE — dupes are silently skipped
      const newCount = insertMany(postsToInsert);
      totalNewPosts += newCount;

      if (VERBOSE && newCount > 0) {
        log(`     → ${newCount} new posts (${posts.length - newCount} dupes skipped)`);
      }
    }

    // Update connection metadata
    markConnectionScraped.run({
      profile_url: conn.profile_url,
      last_scraped_at: collectedAt,
      last_post_at: posts.length > 0 ? collectedAt : null,
      posts_this_week: posts.length,
      // Boost priority for active posters, lower for inactive
      priority: posts.length > 0
        ? Math.min(1.0, conn.priority + 0.1)
        : Math.max(0.1, conn.priority - 0.05),
    });

    profilesDone++;

    // Human-like delay between profiles
    await sleep(rand(3000, 8000));
  }

  // If we visited 20+ profiles and got 0 posts, selectors are probably broken
  if (profilesDone >= 20 && totalNewPosts === 0 && authBlocked < 3) {
    log('\n   ⚠️  Visited many profiles but found 0 posts — selectors may be broken.');
    log('   Saving diagnostic for Claude to auto-fix...');
    // Open one more profile page to dump diagnostic
    const samplePage = await browser.newPage();
    const sampleConn = batch[0];
    await samplePage.goto(`${sampleConn.profile_url}/recent-activity/all/`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await sleep(2000);
    const diagnostic = await dumpDiagnostic(samplePage, 'profile', ['configurable selectors from selectors.json']);
    flagForRepair('profile', diagnostic);
    await samplePage.close();
    log('   Next time you open Cowork, Claude will fix this automatically.');
  } else if (totalNewPosts > 0) {
    // Selectors are working — clear any old repair flags
    clearRepairFlag();
  }

  await browser.close();

  const elapsed = Date.now() - startTime;

  // Log the run
  logProfileRun({
    ran_at: collectedAt,
    batch_group: batchGroup,
    profiles_total: batch.length,
    profiles_done: profilesDone,
    posts_new: totalNewPosts,
    duration_ms: elapsed,
    status: authBlocked >= 3 ? 'auth_blocked' : errors >= 10 ? 'partial' : 'ok',
    notes: authBlocked > 0 ? `${authBlocked} auth blocks` : null,
  });

  // Summary
  log('');
  log('═'.repeat(50));
  log(`   ✅  Batch ${batchGroup} complete`);
  log(`   Profiles visited: ${profilesDone}/${batch.length}`);
  log(`   New posts found:  ${totalNewPosts}`);
  log(`   Dupes skipped:    (handled automatically by content_hash)`);
  log(`   Time:             ${(elapsed / 1000 / 60).toFixed(1)} minutes`);
  log('');

  // Show coverage stats
  const updatedStats = getConnectionStats();
  const coveragePct = Math.round(updatedStats.ever_scraped / updatedStats.active * 100);
  log(`   Network coverage: ${updatedStats.ever_scraped}/${updatedStats.active} profiles (${coveragePct}%)`);
  log(`   Active posters:   ${updatedStats.active_posters}`);

  if (coveragePct < 100) {
    const daysLeft = Math.ceil((updatedStats.active - updatedStats.ever_scraped) / (batch.length || 1));
    log(`   Full coverage in: ~${daysLeft} more days`);
  }

  log('');

  return {
    success: true,
    batchGroup,
    profilesDone,
    totalNewPosts,
    elapsed,
  };
}

// ── Run directly ────────────────────────────────────────────────────────────
if (require.main === module) {
  collectBatch()
    .then(result => {
      if (!result.success) process.exit(1);
    })
    .catch(err => {
      console.error('[profile-collector] Fatal:', err);
      process.exit(1);
    });
}

module.exports = { collectBatch };

/**
 * own-posts.js — Scrape the user's own LinkedIn post performance
 *
 * Visits your profile's activity page, extracts your recent posts,
 * and records engagement metrics (likes, comments, reposts).
 *
 * Two modes:
 *   --baseline        Seed initial historical data. Scrolls deeper to capture
 *                     more posts. Marks them as is_baseline=1 so the dashboard
 *                     can separate "before tracking" from "after tracking."
 *   (default)         Normal nightly run. Grabs recent posts and updates
 *                     engagement numbers on existing ones (ON CONFLICT UPDATE).
 *
 * Usage:
 *   node src/own-posts.js                     — normal collection
 *   node src/own-posts.js --baseline          — initial seed (run once)
 *   node src/own-posts.js --baseline --scrolls 20  — seed with deeper history
 *   node src/own-posts.js --verbose           — detailed logging
 */

const { chromium } = require('playwright');
const path         = require('path');
const {
  getConfig, upsertManyOwnPosts, makeContentHash, getOwnPostStats,
} = require('./database');
const { loadSelectors, dumpDiagnostic, flagForRepair, clearRepairFlag } = require('./self-heal');
const { PROFILE_DIR } = require('./paths');
const VERBOSE     = process.argv.includes('--verbose') || process.env.LFT_VERBOSE;
const BASELINE    = process.argv.includes('--baseline');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ── Relative date parser (shared with profile-collector) ────────────────────

function parseRelativeDate(relativeStr) {
  if (!relativeStr || typeof relativeStr !== 'string') return null;
  const now = new Date();
  const text = relativeStr.trim().toLowerCase();
  if (text.includes('just now') || text === 'now') return now.toISOString();
  if (text.includes('yesterday')) { const d = new Date(now); d.setDate(d.getDate() - 1); return d.toISOString(); }
  const match = text.match(/(\d+)\s*(s|m|h|d|w|mo|yr)/i);
  if (match) {
    const num = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const d = new Date(now);
    switch (unit) {
      case 's': d.setSeconds(d.getSeconds() - num); break;
      case 'm': d.setMinutes(d.getMinutes() - num); break;
      case 'h': d.setHours(d.getHours() - num); break;
      case 'd': d.setDate(d.getDate() - num); break;
      case 'w': d.setDate(d.getDate() - (num * 7)); break;
      case 'mo': d.setMonth(d.getMonth() - num); break;
      case 'yr': d.setFullYear(d.getFullYear() - num); break;
    }
    return d.toISOString();
  }
  return null;
}

// ── Parse CLI args ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let scrolls = BASELINE ? 15 : 5; // baseline scrolls more to get deeper history

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scrolls' && args[i + 1]) {
      scrolls = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return { scrolls };
}

// ── Main scraper ────────────────────────────────────────────────────────────

async function scrapeOwnPosts(options = {}) {
  const { scrolls } = { ...parseArgs(), ...options };
  const startTime = Date.now();
  const collectedAt = new Date().toISOString();
  const log = VERBOSE ? console.log : (...args) => { if (args[0]?.includes?.('✅') || args[0]?.includes?.('⚠️') || args[0]?.includes?.('📊')) console.log(...args); };

  console.log(`\n📊  Own Post Performance ${BASELINE ? '(Baseline Seed)' : 'Tracker'}`);
  console.log('═'.repeat(50));

  // Get user's profile URL from config
  const userProfile = getConfig('linkedin_profile_url');
  const userName = getConfig('linkedin_user', 'unknown');

  if (!userProfile) {
    console.log('   No profile URL stored yet.');
    console.log('   Will auto-detect from LinkedIn...');
  }

  // Launch browser
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });

  const page = await browser.newPage();
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,mp4,mp3}', r => r.abort());
  await page.route('**/tracking/**', r => r.abort());

  try {
    // Navigate to user's activity page
    let activityUrl;
    if (userProfile) {
      activityUrl = `${userProfile}/recent-activity/all/`;
    } else {
      // Auto-detect: go to feed, find profile link
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(rand(2000, 3000));

      const profileUrl = await page.evaluate(() => {
        // Look for "View Profile" or the user's name link in the sidebar
        const profileLink = document.querySelector('a[href*="/in/"][href*="miniProfile"]')
          || document.querySelector('.feed-identity-module a[href*="/in/"]')
          || document.querySelector('a.ember-view[href*="/in/"]');
        if (profileLink) return profileLink.getAttribute('href');
        return null;
      });

      if (profileUrl) {
        const fullUrl = profileUrl.startsWith('http') ? profileUrl.split('?')[0] : `https://www.linkedin.com${profileUrl.split('?')[0]}`;
        activityUrl = `${fullUrl}/recent-activity/all/`;
        // Save for future runs
        const { setConfig } = require('./database');
        setConfig('linkedin_profile_url', fullUrl.replace(/\/$/, ''));
        log(`   Auto-detected profile: ${fullUrl}`);
      } else {
        console.error('   ❌ Could not detect your profile URL.');
        console.error('   Please set it manually: open Cowork and say "my LinkedIn profile is linkedin.com/in/yourname"');
        await browser.close();
        return { success: false, reason: 'no_profile_url' };
      }
    }

    console.log(`   Profile: ${userName}`);
    console.log(`   Mode: ${BASELINE ? 'Baseline seed (deeper history)' : 'Normal collection'}`);
    console.log(`   Scrolls: ${scrolls}`);
    console.log('');

    await page.goto(activityUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(rand(2000, 3500));

    // Check for auth redirect
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint') || currentUrl.includes('/authwall')) {
      console.error('   ❌ Not logged in. Run "Login to LinkedIn.command" first.');
      await browser.close();
      return { success: false, reason: 'not_logged_in' };
    }

    // Scroll to load posts
    for (let i = 0; i < scrolls; i++) {
      await page.evaluate((px) => window.scrollBy(0, px), rand(600, 900));
      await sleep(rand(1000, 2000));
      if (VERBOSE && i % 5 === 0) log(`   Scrolling... ${i + 1}/${scrolls}`);
    }

    // Extract posts using data-urn containers (unique per post, no duplicates)
    const rawPosts = await page.evaluate(() => {
      const posts = [];
      const seenUrns = new Set();

      // Primary: data-urn containers (unique per post — avoids the duplicate
      // container issue where both .feed-shared-update-v2 and .occludable-update
      // match the same post)
      const containers = document.querySelectorAll('div[data-urn*="activity"]');

      containers.forEach(container => {
        // Deduplicate by URN
        const urn = container.getAttribute('data-urn');
        if (seenUrns.has(urn)) return;
        seenUrns.add(urn);

        // Get post text — IMPORTANT: [dir="ltr"] index 0 is always the author
        // name span (e.g. "Steve GustafsonSteve Gustafson"). The actual post
        // content is at index 1+. We collect all [dir="ltr"] elements and pick
        // the first one that looks like real content (>30 chars, not a doubled name).
        const ltrEls = container.querySelectorAll('[dir="ltr"]');
        let content = null;
        for (const el of ltrEls) {
          const text = el.textContent.trim();
          // Skip short text (author names, labels)
          if (text.length < 30) continue;
          // Skip doubled names like "Steve GustafsonSteve Gustafson"
          const half = text.substring(0, Math.floor(text.length / 2));
          if (text === half + half) continue;
          content = text;
          break;
        }
        if (!content) return;

        // Get post URL (permalink)
        const linkEl = container.querySelector('a[href*="/activity/"], a[href*="/feed/update/"]');
        const postUrl = linkEl ? linkEl.getAttribute('href') : null;

        // Engagement numbers — try multiple selector strategies
        const engEl = container.querySelector('.social-details-social-counts, .social-details-social-activity');
        const engText = engEl ? engEl.textContent.trim() : '';
        let likes = 0, comments = 0, reposts = 0;

        // Parse "X reactions", "X likes", "X comments", "X reposts"
        const likeMatch = engText.match(/([\d,]+)\s*(?:like|reaction)/i);
        const commentMatch = engText.match(/([\d,]+)\s*comment/i);
        const repostMatch = engText.match(/([\d,]+)\s*repost/i);
        if (likeMatch) likes = parseInt(likeMatch[1].replace(/,/g, ''), 10);
        if (commentMatch) comments = parseInt(commentMatch[1].replace(/,/g, ''), 10);
        if (repostMatch) reposts = parseInt(repostMatch[1].replace(/,/g, ''), 10);

        // Also try plain number extraction if structured parsing missed
        if (likes === 0 && comments === 0 && reposts === 0 && engText) {
          const nums = engText.match(/(\d[\d,]*)/g);
          if (nums && nums.length >= 1) likes = parseInt(nums[0].replace(/,/g, ''), 10);
          if (nums && nums.length >= 2) comments = parseInt(nums[1].replace(/,/g, ''), 10);
          if (nums && nums.length >= 3) reposts = parseInt(nums[2].replace(/,/g, ''), 10);
        }

        // Time
        const timeEl = container.querySelector('time');
        const timeAttr = timeEl ? timeEl.getAttribute('datetime') : null;
        const timeText = timeEl ? timeEl.textContent.trim() : null;

        // Post type detection
        const hasImage = container.querySelector('img.feed-shared-image, img[src*="media"]') !== null;
        const hasVideo = container.querySelector('video, .feed-shared-linkedin-video, [data-video]') !== null;
        const hasPoll = container.querySelector('.feed-shared-poll, [data-poll]') !== null;
        const hasArticle = container.querySelector('.feed-shared-article, .article-card') !== null;
        const hasCarousel = container.querySelector('.feed-shared-carousel, [data-carousel]') !== null;

        let postType = 'text';
        if (hasVideo) postType = 'video';
        else if (hasPoll) postType = 'poll';
        else if (hasCarousel) postType = 'carousel';
        else if (hasArticle) postType = 'article';
        else if (hasImage) postType = 'image';

        posts.push({
          post_url: postUrl,
          content_short: content.substring(0, 200),
          posted_at_raw: timeText,
          posted_at_iso: timeAttr,
          likes,
          comments,
          reposts,
          post_type: postType,
        });
      });

      return posts;
    });

    console.log(`   Found ${rawPosts.length} posts on your activity page`);

    if (rawPosts.length === 0 && scrolls >= 5) {
      console.log('   ⚠️  No posts found — selectors may need updating.');
      const diagnostic = await dumpDiagnostic(page, 'own-posts', ['profile selectors']);
      flagForRepair('own-posts', diagnostic);
      console.log('   Next time you open Cowork, Claude will fix this automatically.');
    } else if (rawPosts.length > 0) {
      clearRepairFlag();
    }

    // Prepare for database
    const postsToStore = rawPosts.map(p => ({
      post_url: p.post_url ? (p.post_url.startsWith('http') ? p.post_url : `https://www.linkedin.com${p.post_url}`) : null,
      content_short: p.content_short,
      posted_at: p.posted_at_iso || parseRelativeDate(p.posted_at_raw),
      posted_at_raw: p.posted_at_raw,
      collected_at: collectedAt,
      likes: p.likes,
      comments: p.comments,
      reposts: p.reposts,
      impressions: 0,
      post_type: p.post_type,
      content_hash: makeContentHash(userName, p.content_short),
      is_baseline: BASELINE ? 1 : 0,
    })).filter(p => p.post_url || p.content_short); // must have at least one identifier

    const upserted = upsertManyOwnPosts(postsToStore);
    const elapsed = Date.now() - startTime;

    console.log(`   Stored/updated: ${upserted} posts`);
    console.log(`   Time: ${(elapsed / 1000).toFixed(1)}s`);

    // Show stats
    const stats = getOwnPostStats();
    console.log('');
    console.log('   📊 Your Post Performance Summary:');
    console.log(`   Total tracked:  ${stats.total_posts}`);
    console.log(`   Avg likes:      ${Math.round(stats.avg_likes || 0)}`);
    console.log(`   Avg comments:   ${Math.round(stats.avg_comments || 0)}`);
    console.log(`   Best likes:     ${stats.best_likes || 0}`);
    console.log(`   Best comments:  ${stats.best_comments || 0}`);
    if (BASELINE) {
      console.log(`   Baseline posts: ${stats.baseline_posts}`);
    }

    await browser.close();
    return { success: true, posts: upserted, elapsed };

  } catch (err) {
    console.error(`   ❌ Error: ${err.message}`);
    await browser.close().catch(() => {});
    return { success: false, reason: err.message };
  }
}

// ── Run directly ────────────────────────────────────────────────────────────
if (require.main === module) {
  scrapeOwnPosts()
    .then(result => {
      if (!result.success) process.exit(1);
    })
    .catch(err => {
      console.error('[own-posts] Fatal:', err);
      process.exit(1);
    });
}

module.exports = { scrapeOwnPosts };

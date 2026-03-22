/**
 * collector.js — LinkedIn feed scraper using Playwright
 *
 * Works for ANY LinkedIn user — no credentials stored here.
 * Session is saved to ./data/browser-profile/ on first login.
 * Subsequent runs use the saved session (headless).
 */

const { chromium } = require('playwright');
const path         = require('path');
const fs           = require('fs');
const { getConfig, setConfig, insertMany, makeContentHash, logRun } = require('./database');

const PROFILE_DIR  = path.join(__dirname, '..', 'data', 'browser-profile');
const FEED_URL     = 'https://www.linkedin.com/feed/?filter=following';
const FEED_FALLBACK = 'https://www.linkedin.com/feed/';

// How many "Load more" clicks to attempt
const MAX_LOAD_MORE = parseInt(getConfig('max_load_more', '12'), 10);
// Stop loading when posts are this many hours old
const LOOKBACK_HOURS = parseInt(getConfig('lookback_hours', '26'), 10);

// ── Timing helpers ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ── Post parser ────────────────────────────────────────────────────────────────

/**
 * Parse raw feed page text (from page.innerText()) into structured post objects.
 * LinkedIn's rendered text doesn't give us clean HTML, so we pattern-match
 * on the text blocks that consistently appear around posts.
 */
function parseFeedText(rawText, collectedAt) {
  const posts = [];
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  // LinkedIn feed text blocks have a recognisable pattern:
  // [Author name]
  // [Author title / company]
  // [Time ago: "3h", "1d", "2d", etc.]  ← key timestamp line
  // • [optional: "Following"]
  // [Post content lines...]
  // [optional: "Reposted by X"]
  // [reactions · comments]

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Time markers LinkedIn uses: "3h", "1d", "2w", "1mo" etc.
    const timeMatch = line.match(/^(\d+[smhdw]|[1-9]\d*\s*(hour|day|week|month|min|second)s?)(\s*•)?$/i);
    if (!timeMatch) { i++; continue; }

    // Check if this timestamp is within our lookback window
    const hoursAgo = parseTimeToHours(line);
    if (hoursAgo > LOOKBACK_HOURS) {
      i++;
      continue; // post too old, but keep scanning (older posts may appear between newer ones)
    }

    // Look back up to 5 lines for author name and title
    let authorName  = null;
    let authorTitle = null;
    for (let back = 1; back <= 5; back++) {
      const candidate = lines[i - back];
      if (!candidate) break;
      // Skip "Following", "Connect", "Message", "•", reaction counts
      if (/^(following|connect|message|like|comment|repost|send|•|\d+)$/i.test(candidate)) continue;
      // Skip lines that look like nav or UI chrome
      if (/^(home|my network|jobs|messaging|notifications|search)$/i.test(candidate)) continue;
      if (!authorName) { authorName = candidate; }
      else if (!authorTitle) { authorTitle = candidate; break; }
    }

    if (!authorName) { i++; continue; }

    // Collect post content — lines after timestamp until next post signal
    const contentLines = [];
    let engagementLine = null;
    let isRepost       = false;
    let repostAuthor   = null;
    let hasLink        = false;
    let j = i + 1;

    while (j < lines.length && j < i + 80) {
      const cl = lines[j];

      // Stop at another timestamp (next post)
      if (/^(\d+[smhdw]|[1-9]\d*\s*(hour|day|week|month|min)s?)(\s*•)?$/i.test(cl)) break;
      // Stop at reaction/comment counts (engagement line)
      if (/\d+[\s,]*(reaction|like|comment|repost)/i.test(cl)) {
        engagementLine = cl;
        j++;
        break;
      }

      // Detect reposts
      if (/^(reposted|reshared)/i.test(cl)) { isRepost = true; repostAuthor = contentLines[0] || null; }
      // Detect external links
      if (/^https?:\/\//i.test(cl)) { hasLink = true; }
      // Skip pure UI chrome
      if (/^(like|comment|repost|send|follow|unfollow|see more|see less|load more|show more)$/i.test(cl)) { j++; continue; }
      if (cl === '•' || cl === '···') { j++; continue; }

      contentLines.push(cl);
      j++;
    }

    const content = contentLines.join(' ').trim();
    if (content.length < 15) { i = j; continue; } // skip near-empty fragments

    // Determine post type
    let postType = 'original';
    if (isRepost) postType = 'repost';
    else if (/\barticle\b|\bpublished\b/i.test(content)) postType = 'article';
    else if (/\bhiring\b|\bjob\b|\bopen role\b|\bwe.re looking\b/i.test(content)) postType = 'job';
    else if (/\bproud\b.*\b(joined|promoted|started|announced)\b|\bannouncing\b/i.test(content)) postType = 'milestone';

    // Extract rough engagement numbers
    const likesMatch    = (engagementLine || '').match(/(\d[\d,]*)\s*(reaction|like)/i);
    const commentsMatch = (engagementLine || '').match(/(\d[\d,]*)\s*comment/i);

    const contentShort = content.substring(0, 200);
    posts.push({
      collected_at:  collectedAt,
      post_date:     estimatePostDate(hoursAgo),
      author_name:   authorName,
      author_title:  authorTitle || null,
      post_type:     postType,
      content:       content,
      content_short: contentShort,
      engagement:    engagementLine || null,
      likes:         likesMatch    ? parseInt(likesMatch[1].replace(',', ''), 10)    : 0,
      comments:      commentsMatch ? parseInt(commentsMatch[1].replace(',', ''), 10) : 0,
      is_repost:     isRepost ? 1 : 0,
      repost_author: repostAuthor,
      has_link:      hasLink ? 1 : 0,
      raw_text:      contentLines.join('\n').substring(0, 2000),
      content_hash:  makeContentHash(authorName, contentShort),
    });

    i = j;
  }

  return posts;
}

function parseTimeToHours(timeStr) {
  const s = timeStr.toLowerCase().trim();
  if (/^\d+s/.test(s)) return 0;
  if (/^\d+m/.test(s) && !/mo/.test(s)) return parseFloat(s) / 60;
  if (/^\d+h/.test(s)) return parseInt(s, 10);
  if (/^\d+d/.test(s)) return parseInt(s, 10) * 24;
  if (/^\d+w/.test(s)) return parseInt(s, 10) * 24 * 7;
  if (/^\d+\s*mo/.test(s)) return parseInt(s, 10) * 24 * 30;
  return 999; // unknown — treat as old
}

function estimatePostDate(hoursAgo) {
  const d = new Date();
  d.setHours(d.getHours() - hoursAgo);
  return d.toISOString().split('T')[0];
}

// ── Browser session ────────────────────────────────────────────────────────────

async function getBrowser(headless = true) {
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });

  return context;
}

async function isLoggedIn(page) {
  try {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(2000);
    const url = page.url();
    return !url.includes('/login') && !url.includes('/authwall') && !url.includes('/checkpoint');
  } catch {
    return false;
  }
}

// ── Login flow (first-time setup) ─────────────────────────────────────────────

async function runLoginFlow() {
  console.log('\n🔐  Opening browser for LinkedIn login...');
  console.log('   Please log in to LinkedIn in the browser window that opens.');
  console.log('   Once you\'re on your feed, come back here and press Enter.\n');

  const context = await getBrowser(false); // visible browser
  const page    = await context.newPage();

  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });

  // Wait for user to press Enter
  await new Promise(resolve => {
    process.stdout.write('   → Press Enter once you are logged in: ');
    process.stdin.once('data', resolve);
  });

  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) {
    console.log('\n⚠️  Doesn\'t look like you\'re logged in. Please run setup again.');
    await context.close();
    process.exit(1);
  }

  // Capture the logged-in user's name
  try {
    const name = await page.locator('.feed-identity-module__actor-meta .t-16').first().innerText({ timeout: 5000 });
    if (name) {
      setConfig('linkedin_user', name.trim());
      console.log(`\n✅  Logged in as: ${name.trim()}`);
    }
  } catch {
    setConfig('linkedin_user', 'LinkedIn User');
  }

  await context.close();
  console.log('   Session saved. Future runs will be headless.\n');
}

// ── Main collection ───────────────────────────────────────────────────────────

async function collect({ verbose = false, dryRun = false } = {}) {
  const start = Date.now();
  const collectedAt = new Date().toISOString();
  const log = verbose ? console.log : () => {};

  log('\n📡  Starting LinkedIn feed collection...');
  log(`   Time: ${new Date().toLocaleString()}`);
  log(`   Looking back ${LOOKBACK_HOURS}h, loading up to ${MAX_LOAD_MORE} batches\n`);

  let context;
  try {
    context = await getBrowser(true);
    const page = await context.newPage();

    // Block images/media for speed — we only need text
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,mp4,mp3}', r => r.abort());
    await page.route('**/tracking/**', r => r.abort());
    await page.route('**/li/track**', r => r.abort());

    // Check login
    const loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      throw new Error('Not logged in. Run: npm run setup');
    }

    // Navigate to following feed
    log('   → Navigating to following feed...');
    try {
      await page.goto(FEED_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch {
      log('   → Falling back to standard feed...');
      await page.goto(FEED_FALLBACK, { waitUntil: 'domcontentloaded', timeout: 20000 });
    }

    await sleep(rand(2000, 3500));

    // Switch to Recent sort
    log('   → Switching to Recent sort...');
    try {
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b =>
          b.textContent.includes('Top') || b.textContent.includes('Sort')
        );
        if (btn) btn.click();
      });
      await sleep(rand(1500, 2500));
      await page.evaluate(() => {
        const items = [...document.querySelectorAll('[role="option"], li, button')];
        const recentBtn = items.find(el => el.textContent.trim() === 'Recent');
        if (recentBtn) recentBtn.click();
      });
      await sleep(rand(2000, 3000));
    } catch (e) {
      log('   ⚠️  Could not switch to Recent sort — proceeding anyway');
    }

    // Load posts iteratively
    let allText = '';
    let loadMoreAttempts = 0;

    for (let attempt = 0; attempt < MAX_LOAD_MORE; attempt++) {
      // Scroll down humanly
      await page.evaluate(() => window.scrollBy(0, rand(600, 900)));
      await sleep(rand(800, 1400));

      // Try to click "Load more" / "Show more" button
      const clicked = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => {
          const t = b.textContent.trim().toLowerCase();
          return t.includes('load more') || t.includes('show more results');
        });
        if (btn) { btn.click(); return true; }
        return false;
      });

      if (clicked) {
        loadMoreAttempts++;
        await sleep(rand(2000, 3500));
        log(`   → Load more ${loadMoreAttempts}/${MAX_LOAD_MORE}...`);
      }

      // Grab text every 3 loads or on final attempt
      if (attempt % 3 === 2 || attempt === MAX_LOAD_MORE - 1) {
        allText = await page.evaluate(() => document.body.innerText);

        // Check if we have posts old enough to stop
        const hasOldContent = /\b([2-9]\d|[1-9]\d{2})\s*h\b|\b\d+\s*d\b|\b\d+\s*w\b/i.test(allText);
        if (hasOldContent && attempt > 3) {
          log(`   → Found content older than ${LOOKBACK_HOURS}h — stopping load`);
          break;
        }
      }
    }

    // Final text grab
    if (!allText) {
      allText = await page.evaluate(() => document.body.innerText);
    }

    log(`\n   → Parsing feed text (${(allText.length / 1024).toFixed(0)} KB)...`);

    // Filter out sponsored/promoted blocks
    const cleanedText = allText
      .split('\n')
      .filter(line => {
        const l = line.trim().toLowerCase();
        return !l.startsWith('promoted') && !l.startsWith('sponsored') && l !== 'suggested';
      })
      .join('\n');

    // Parse posts
    const posts = parseFeedText(cleanedText, collectedAt);
    log(`   → Found ${posts.length} posts from followed accounts\n`);

    const duration = Date.now() - start;

    // ── Dry-run mode: show what was parsed without saving ─────────────────────
    if (dryRun) {
      console.log(`\n🧪  DRY RUN — ${posts.length} posts parsed (nothing saved)\n`);
      posts.slice(0, 20).forEach((p, i) => {
        console.log(`  [${i+1}] ${p.author_name || 'Unknown'} · ${p.post_type}`);
        console.log(`       ${p.content.substring(0, 120)}...`);
        console.log(`       ❤️ ${p.likes}  💬 ${p.comments}  hash: ${p.content_hash?.substring(0,8)}\n`);
      });
      if (posts.length > 20) console.log(`  ... and ${posts.length - 20} more\n`);
      await context.close();
      return { posts: posts.length, inserted: 0, dryRun: true };
    }

    // Save to database
    const inserted = insertMany(posts);

    logRun({
      ran_at:      collectedAt,
      posts_found: posts.length,
      posts_new:   inserted,
      duration_ms: duration,
      status:      'ok',
      notes:       `${loadMoreAttempts} load-more clicks`,
    });

    const user = getConfig('linkedin_user', 'Unknown user');
    console.log(`✅  Collection complete for ${user}`);
    console.log(`   Posts found: ${posts.length} | New to database: ${inserted} | Dupes skipped: ${posts.length - inserted} | Time: ${(duration/1000).toFixed(1)}s`);

    await context.close();
    return { posts: posts.length, inserted };

  } catch (err) {
    const duration = Date.now() - start;
    logRun({
      ran_at:      collectedAt,
      posts_found: 0,
      posts_new:   0,
      duration_ms: duration,
      status:      'error',
      notes:       err.message,
    });
    if (context) await context.close().catch(() => {});
    throw err;
  }
}

module.exports = { collect, runLoginFlow, isLoggedIn, getBrowser };

// Run directly: node src/collector.js [--dry-run]
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('\n🧪  Dry-run mode — will parse but not save to database\n');
  collect({ verbose: true, dryRun }).catch(err => {
    console.error('\n❌  Collection failed:', err.message);
    if (err.message.includes('Not logged in')) {
      console.log('   Run: npm run setup\n');
    }
    process.exit(1);
  });
}

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
const { PROFILE_DIR } = require('./paths');
const FEED_URL     = 'https://www.linkedin.com/feed/?filter=following';
const FEED_FALLBACK = 'https://www.linkedin.com/feed/';

// How many "Load more" clicks to attempt (higher = more posts, longer run)
const MAX_LOAD_MORE = parseInt(getConfig('max_load_more', '30'), 10);
// Stop loading when posts are this many hours old (168h = 7 days)
const LOOKBACK_HOURS = parseInt(getConfig('lookback_hours', '168'), 10);

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

    // Look back up to 6 lines for author name and title
    // LinkedIn text order (going backward from timestamp):
    //   [Name] → [Headline] → [Degree: "• 1st"] → [Timestamp]
    // The first non-skip candidate is usually the headline, second is the name.
    let candidates = [];
    for (let back = 1; back <= 6; back++) {
      const candidate = lines[i - back];
      if (!candidate) break;
      // Skip "Following", "Connect", "Message", standalone bullets, reaction counts
      if (/^(following|connect|message|like|comment|repost|send|•|\d+)$/i.test(candidate)) continue;
      // Skip connection degree lines: "• 1st", "• 2nd", "• 3rd+", "• Following"
      if (/^•\s*(1st|2nd|3rd\+?|following)/i.test(candidate)) continue;
      // Skip nav/UI chrome
      if (/^(home|my network|jobs|messaging|notifications|search)$/i.test(candidate)) continue;
      // Skip "Promoted" labels
      if (/^promoted$/i.test(candidate)) continue;
      candidates.push(candidate);
      if (candidates.length >= 2) break;
    }

    // Determine which candidate is the name vs headline
    // Names: short, 2-4 capitalized words, no pipe/slash/at separators
    // Headlines: contain "|", "//", " at ", "CEO", "Founder", "Director", etc.
    function looksLikeName(text) {
      if (!text) return false;
      // Has headline indicators → not a name
      if (/[|\/]{2}|•/.test(text)) return false;
      if (/\b(at|@)\s+[A-Z]/i.test(text)) return false;
      if (/\b(CEO|CTO|CFO|COO|CMO|VP|SVP|EVP|Director|Manager|Founder|Co-Founder|President|Partner|Head of|Lead|Engineer|Consultant|Advisor|Executive|Strategist|Entrepreneur|Editor|Writer|Coach|Author)\b/i.test(text)) return false;
      // Names are typically short: 2-5 words
      const words = text.trim().split(/\s+/);
      if (words.length > 6) return false;
      // Most words should be capitalized
      const capWords = words.filter(w => /^[A-Z]/.test(w));
      return capWords.length >= words.length * 0.6;
    }

    let authorName = null;
    let authorTitle = null;

    if (candidates.length >= 2) {
      // Two candidates: figure out which is name vs headline
      if (looksLikeName(candidates[0]) && !looksLikeName(candidates[1])) {
        authorName = candidates[0];
        authorTitle = candidates[1];
      } else if (looksLikeName(candidates[1]) && !looksLikeName(candidates[0])) {
        authorName = candidates[1];
        authorTitle = candidates[0];
      } else {
        // Both look like names or both like headlines — further back = name
        authorName = candidates[1];
        authorTitle = candidates[0];
      }
    } else if (candidates.length === 1) {
      authorName = candidates[0];
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

    // ── Filter out comment replies ──
    // Comments within threads are NOT top-level posts and should be skipped.
    // Heuristics to detect replies:

    // 1. Skip if content contains LinkedIn UI chrome (leaked "Reaction button state:")
    if (/Reaction button state:/i.test(content)) { i = j; continue; }

    // 2. Skip single-word garbage (e.g., "Skills", "Reply")
    if (content.split(/\s+/).length === 1) { i = j; continue; }

    // 3. Skip if content starts with "[Capitalized Name] [short text]" pattern
    // This catches replies like "Sam Obenchain Beyond dope" or "Jonny Price I love that soup"
    const nameReplyMatch = content.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+([a-z].{0,40})$/i);
    if (nameReplyMatch && nameReplyMatch[2].length < 50) {
      // Check if this looks like a person reply (not a real post start)
      const possibleReply = nameReplyMatch[2];
      if (!/^(today|this|i|we|the|announcing|posted|published|proud|excited)\b/i.test(possibleReply)) {
        i = j; continue;
      }
    }

    // 4. Skip if content is a very short informal response (< 60 chars, all lowercase/informal)
    if (content.length < 60 && !/[.!?]{2,}/.test(content) &&
        /^[a-z]/.test(content) && !/^(today|this|we|excited|proud|announcing|posted)/i.test(content)) {
      // But allow if it has numbers, URLs, or hashtags (likely real posts)
      if (!/\d+|#|http|\$|%/.test(content)) {
        i = j; continue;
      }
    }

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
      post_url:      null, // populated later by DOM extraction pass
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
      const scrollPx = rand(600, 900);
      await page.evaluate((px) => window.scrollBy(0, px), scrollPx);
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
    log(`   → Found ${posts.length} posts from followed accounts`);

    // ── DOM + HTML pass: extract post URLs to merge into text-parsed posts ──
    // LinkedIn's feed DOM is heavily obfuscated (no container classes, no data-urn
    // attributes). We use two strategies:
    //   1. Find <a href="/feed/update/..."> links and grab surrounding text
    //   2. Regex-scan raw HTML for URN patterns and grab nearby text context
    log('   → Extracting post URLs from DOM + HTML...');
    const postUrlMap = await page.evaluate(() => {
      const urlEntries = [];
      const seenUrns = new Set();

      // ── Strategy 1: Find actual <a> links with post URLs ──
      const linkEls = document.querySelectorAll('a[href*="/feed/update/"], a[href*="/activity/"]');
      linkEls.forEach(linkEl => {
        const url = linkEl.getAttribute('href');
        const cleanUrl = url.split('?')[0];
        // Extract URN for dedup
        const urnMatch = cleanUrl.match(/urn:li:(share|activity|ugcPost):\d+/);
        const urn = urnMatch ? urnMatch[0] : cleanUrl;
        if (seenUrns.has(urn)) return;
        seenUrns.add(urn);

        // Link's own text (often the post content or article title)
        const linkText = (linkEl.textContent || '').trim().replace(/\n+/g, ' ').substring(0, 500).toLowerCase();

        // Walk up DOM for container text
        let container = linkEl;
        for (let up = 0; up < 15; up++) {
          container = container.parentElement;
          if (!container) break;
          const rect = container.getBoundingClientRect();
          if (rect.height > 150 && rect.width > 400) break;
        }
        const fullText = container
          ? (container.innerText || '').substring(0, 1500).replace(/\n+/g, ' ').toLowerCase()
          : '';

        urlEntries.push({
          url: cleanUrl.startsWith('http') ? cleanUrl : `https://www.linkedin.com${cleanUrl}`,
          searchText: `${linkText} ${fullText}`,
        });
      });

      // ── Strategy 2: Regex-scan full HTML for URNs not found as links ──
      const html = document.documentElement.outerHTML;
      const urnRegex = /urn:li:(activity|share|ugcPost):(\d+)/g;
      let match;
      while ((match = urnRegex.exec(html)) !== null) {
        const urn = match[0];
        if (seenUrns.has(urn)) continue;
        seenUrns.add(urn);

        const url = `https://www.linkedin.com/feed/update/${urn}/`;
        // Grab surrounding HTML context (~500 chars each side) for text matching
        const start = Math.max(0, match.index - 500);
        const end = Math.min(html.length, match.index + 500);
        const context = html.substring(start, end)
          .replace(/<[^>]+>/g, ' ')  // strip HTML tags
          .replace(/\s+/g, ' ')       // normalize whitespace
          .toLowerCase();

        urlEntries.push({ url, searchText: context });
      }

      return urlEntries;
    });

    log(`   → Found ${postUrlMap.length} post URLs (links + HTML URNs)`);

    // Match URLs to text-parsed posts by checking if post content appears
    // anywhere in the URL entry's search text
    let urlsMatched = 0;
    for (const post of posts) {
      if (post.post_url) continue;

      const postContent = (post.content_short || '').toLowerCase();
      if (postContent.length < 20) continue;

      // Build search phrases from the post content (multiple chunks for robustness)
      const chunks = [
        postContent.substring(0, 40),
        postContent.length > 60 ? postContent.substring(20, 60) : null,
        postContent.length > 100 ? postContent.substring(50, 90) : null,
      ].filter(Boolean);

      // Also try matching by author name + short content start
      const authorLower = (post.author_name || '').toLowerCase();

      for (const entry of postUrlMap) {
        const st = entry.searchText;

        // Content match: any chunk found in the search text
        const contentMatch = chunks.some(chunk => st.includes(chunk));

        // Author + partial content match
        const authorMatch = authorLower.length > 3 &&
          st.includes(authorLower.substring(0, 15)) &&
          postContent.length >= 15 && st.includes(postContent.substring(0, 20));

        if (contentMatch || authorMatch) {
          post.post_url = entry.url;
          urlsMatched++;
          break;
        }
      }
    }
    log(`   → Matched ${urlsMatched}/${posts.length} posts with URLs\n`);

    const duration = Date.now() - start;

    // ── Dry-run mode: show what was parsed without saving ─────────────────────
    if (dryRun) {
      console.log(`\n🧪  DRY RUN — ${posts.length} posts parsed (nothing saved)\n`);
      posts.slice(0, 20).forEach((p, i) => {
        console.log(`  [${i+1}] ${p.author_name || 'Unknown'} · ${p.post_type}`);
        console.log(`       ${p.content.substring(0, 120)}...`);
        console.log(`       ❤️ ${p.likes}  💬 ${p.comments}  hash: ${p.content_hash?.substring(0,8)}  ${p.post_url ? '🔗' : '—'}\n`);
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

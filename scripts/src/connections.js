/**
 * connections.js — LinkedIn connections list scraper (Phase 4)
 *
 * Scrapes your full connections list and stores profile URLs in the
 * connections table for use by the profile-based scraper.
 *
 * Handles up to 5,000 connections via infinite-scroll pagination.
 * Assigns each connection a batch_group (0-6) for 7-day rotation.
 *
 * Usage:
 *   npm run sync-connections          — full sync (recommended weekly)
 *   node src/connections.js --count   — just print connection count, no write
 */

const { chromium }             = require('playwright');
const path                     = require('path');
const { upsertManyConnections, getConnectionStats, getConfig } = require('./database');

const PROFILE_DIR  = path.join(__dirname, '..', 'data', 'browser-profile');
const CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';

const DRY_RUN    = process.argv.includes('--count');
const VERBOSE    = process.argv.includes('--verbose') || process.env.LFT_VERBOSE;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ── LinkedIn connection card selectors ────────────────────────────────────────
// LinkedIn uses dynamic class names; we target by aria/data attributes
const CARD_SELECTOR     = 'li.mn-connection-card';
const NAME_SELECTOR     = '.mn-connection-card__name';
const OCCUPANCY_SEL     = '.mn-connection-card__occupation';
const LINK_SELECTOR     = 'a.mn-connection-card__link';

async function scrapeConnections() {
  const startTime = Date.now();
  console.log('\n[connections] Starting connections list sync...');

  const user = getConfig('linkedin_user', 'unknown');
  console.log(`[connections] Account: ${user}`);

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });

  const page = await browser.newPage();

  try {
    // ── Navigate to connections page ─────────────────────────────────────────
    await page.goto(CONNECTIONS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(rand(2000, 3500));

    // ── Check if session is still valid ──────────────────────────────────────
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) {
      console.error('[connections] ❌ LinkedIn session expired. Run: npm run setup');
      await browser.close();
      return { success: false, reason: 'session_expired' };
    }

    // ── Scroll to load all connections ───────────────────────────────────────
    console.log('[connections] Scrolling to load all connections (this may take a few minutes for large networks)...');

    let previousCount = 0;
    let stableRounds  = 0;
    let totalScrolls  = 0;
    const MAX_STABLE  = 4;    // stop after 4 scrolls with no new cards
    const MAX_SCROLLS = 300;  // hard cap (~5k+ connections)

    while (stableRounds < MAX_STABLE && totalScrolls < MAX_SCROLLS) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(rand(1200, 2000));

      const currentCount = await page.$$eval(CARD_SELECTOR, cards => cards.length).catch(() => 0);

      if (currentCount > previousCount) {
        if (VERBOSE || currentCount % 500 < 50) {
          console.log(`[connections]   Loaded ${currentCount} connections...`);
        }
        previousCount = currentCount;
        stableRounds  = 0;
      } else {
        stableRounds++;
      }

      totalScrolls++;
    }

    const finalCount = await page.$$eval(CARD_SELECTOR, cards => cards.length).catch(() => 0);
    console.log(`[connections] Loaded ${finalCount} connection cards total`);

    if (DRY_RUN) {
      console.log(`[connections] --count mode: found ${finalCount} connections. No changes written.`);
      await browser.close();
      return { success: true, total: finalCount };
    }

    // ── Extract connection data ───────────────────────────────────────────────
    const rawConnections = await page.$$eval(
      CARD_SELECTOR,
      (cards, { nameSelector, occupancySelector, linkSelector }) => {
        return cards.map(card => {
          const nameEl   = card.querySelector(nameSelector);
          const occupEl  = card.querySelector(occupancySelector);
          const linkEl   = card.querySelector(linkSelector);
          const name     = nameEl   ? nameEl.textContent.trim()   : null;
          const headline = occupEl  ? occupEl.textContent.trim()  : null;
          const href     = linkEl   ? linkEl.getAttribute('href') : null;
          if (!name || !href) return null;
          // Normalize URL: remove query params, ensure full URL
          const profileUrl = href.startsWith('http')
            ? href.split('?')[0].replace(/\/$/, '')
            : `https://www.linkedin.com${href.split('?')[0].replace(/\/$/, '')}`;
          return { name, headline, profile_url: profileUrl };
        }).filter(Boolean);
      },
      { nameSelector: NAME_SELECTOR, occupancySelector: OCCUPANCY_SEL, linkSelector: LINK_SELECTOR }
    );

    console.log(`[connections] Extracted ${rawConnections.length} valid connection records`);

    // ── Assign batch groups (0-6 for 7-day rotation) ─────────────────────────
    const toUpsert = rawConnections.map((c, i) => ({
      ...c,
      batch_group: i % 7,
    }));

    // ── Write to database ─────────────────────────────────────────────────────
    const written = upsertManyConnections(toUpsert);
    const elapsed = Date.now() - startTime;

    console.log(`[connections] ✅ Sync complete: ${written} new/updated | ${rawConnections.length} total | ${(elapsed / 1000).toFixed(1)}s`);

    const stats = getConnectionStats();
    console.log(`[connections] DB stats: ${stats.total} total | ${stats.active} active | ${stats.ever_scraped} ever scraped`);

    await browser.close();
    return { success: true, total: rawConnections.length, written, elapsed };

  } catch (err) {
    console.error('[connections] Error:', err.message);
    await browser.close().catch(() => {});
    return { success: false, reason: err.message };
  }
}

// ── Run directly ──────────────────────────────────────────────────────────────
if (require.main === module) {
  scrapeConnections()
    .then(result => {
      if (!result.success) process.exit(1);
    })
    .catch(err => {
      console.error('[connections] Fatal:', err);
      process.exit(1);
    });
}

module.exports = { scrapeConnections };

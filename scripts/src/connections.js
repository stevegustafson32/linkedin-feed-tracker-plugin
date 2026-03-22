/**
 * connections.js — LinkedIn connections list scraper (Phase 4)
 *
 * Scrapes your full connections list and stores profile URLs in the
 * connections table for use by the profile-based scraper.
 *
 * Handles up to 5,000 connections via infinite-scroll pagination.
 * Assigns each connection a batch_group (0-6) for 7-day rotation.
 *
 * Uses the self-heal selector system: if all strategies fail,
 * dumps DOM diagnostic so Claude can auto-fix selectors.json.
 *
 * Usage:
 *   npm run sync-connections          — full sync (recommended weekly)
 *   node src/connections.js --count   — just print connection count, no write
 */

const { chromium }             = require('playwright');
const path                     = require('path');
const { upsertManyConnections, getConnectionStats, getConfig } = require('./database');
const { loadSelectors, dumpDiagnostic, flagForRepair, clearRepairFlag } = require('./self-heal');
const { PROFILE_DIR } = require('./paths');
const CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';

const DRY_RUN    = process.argv.includes('--count');
const VERBOSE    = process.argv.includes('--verbose') || process.env.LFT_VERBOSE;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ── Strategy-based connection extraction ──────────────────────────────────────

/**
 * Try multiple strategies to find connection cards on the page.
 * Returns { connections: [...], strategy: 'name' } or { connections: [], strategy: null }
 */
async function extractConnections(page, selConfig) {
  const strategies = selConfig.strategies || [];
  const log = VERBOSE ? console.log : () => {};

  // Strategy 1: Use selectors.json strategies
  for (const strategy of strategies) {
    log(`[connections] Trying strategy: ${strategy.name}`);
    const results = await page.evaluate(({ linkSel, linkFilter, nameSel, headlineSel }) => {
      let links = Array.from(document.querySelectorAll(linkSel));

      // Apply link filter
      if (linkFilter === 'hasChild:p') {
        links = links.filter(a => a.querySelector('p'));
      } else if (linkFilter === 'hasChild:span') {
        links = links.filter(a => a.querySelector('span'));
      } else if (linkFilter === 'hasText') {
        links = links.filter(a => a.textContent.trim().length > 2);
      }

      // Filter to only profile links (not nav, not company pages)
      links = links.filter(a => {
        const href = a.getAttribute('href') || '';
        // Must contain /in/ but not be a nav link or action button
        if (!href.includes('/in/')) return false;
        // Skip if it's just a tiny link (like a reaction avatar)
        if (a.textContent.trim().length < 3) return false;
        // Skip if it's inside a nav or header
        if (a.closest('nav, header, [role="navigation"]')) return false;
        return true;
      });

      return links.map(a => {
        const href = a.getAttribute('href') || '';
        let name = null;
        let headline = null;

        if (nameSel === 'auto') {
          // Auto mode: get first meaningful text block
          name = a.textContent.trim().split('\n')[0]?.trim();
        } else {
          const nameEl = a.querySelector(nameSel);
          name = nameEl ? nameEl.textContent.trim() : a.textContent.trim().split('\n')[0]?.trim();
        }

        if (headlineSel === 'auto') {
          const lines = a.textContent.trim().split('\n').map(l => l.trim()).filter(Boolean);
          headline = lines[1] || null;
        } else {
          const headEl = a.querySelector(headlineSel);
          headline = headEl ? headEl.textContent.trim() : null;
        }

        // Clean up name (remove "Connected" badges, extra whitespace)
        if (name) name = name.replace(/\s*Connected\s*$/i, '').trim();

        return { name, headline, href };
      }).filter(item => item.name && item.name.length > 1 && item.href);
    }, {
      linkSel: strategy.linkSelector,
      linkFilter: strategy.linkFilter || 'none',
      nameSel: strategy.nameSelector || 'auto',
      headlineSel: strategy.headlineSelector || 'auto',
    });

    if (results.length > 0) {
      log(`[connections] Strategy "${strategy.name}" found ${results.length} connections`);
      return { connections: results, strategy: strategy.name };
    }
  }

  // Strategy 2: Hardcoded fallback — old LinkedIn class names
  log('[connections] Trying hardcoded fallback: li.mn-connection-card');
  const oldStyleResults = await page.evaluate(() => {
    const cards = document.querySelectorAll('li.mn-connection-card');
    return Array.from(cards).map(card => {
      const nameEl = card.querySelector('.mn-connection-card__name');
      const occEl  = card.querySelector('.mn-connection-card__occupation');
      const linkEl = card.querySelector('a.mn-connection-card__link');
      const name     = nameEl ? nameEl.textContent.trim() : null;
      const headline = occEl  ? occEl.textContent.trim()  : null;
      const href     = linkEl ? linkEl.getAttribute('href') : null;
      if (!name || !href) return null;
      return { name, headline, href };
    }).filter(Boolean);
  });

  if (oldStyleResults.length > 0) {
    log(`[connections] Hardcoded fallback found ${oldStyleResults.length} connections`);
    return { connections: oldStyleResults, strategy: 'hardcoded-mn-connection-card' };
  }

  // Strategy 3: Generic — find all /in/ links inside main content list items
  log('[connections] Trying generic fallback: list items with /in/ links');
  const genericResults = await page.evaluate(() => {
    // Find the main content area
    const main = document.querySelector('main') || document.body;

    // Look for list items that contain profile links
    const listItems = main.querySelectorAll('li');
    const results = [];
    const seen = new Set();

    for (const li of listItems) {
      const link = li.querySelector('a[href*="/in/"]');
      if (!link) continue;

      const href = link.getAttribute('href') || '';
      // Deduplicate by profile URL slug
      const slug = href.split('/in/')[1]?.split(/[/?#]/)[0];
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);

      // Skip tiny elements (avatars, reaction indicators)
      if (li.textContent.trim().length < 10) continue;
      // Skip if inside nav
      if (li.closest('nav, header, [role="navigation"]')) continue;

      // Extract name and headline from the list item text
      const textBlocks = [];
      const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, null);
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent.trim();
        if (text.length > 1 && !['Connected', 'Connect', 'Message', 'Follow', '•', '...'].includes(text)) {
          textBlocks.push(text);
        }
      }

      const name = textBlocks[0] || null;
      const headline = textBlocks[1] || null;

      if (name && name.length > 1) {
        results.push({ name, headline, href });
      }
    }

    return results;
  });

  if (genericResults.length > 0) {
    log(`[connections] Generic fallback found ${genericResults.length} connections`);
    return { connections: genericResults, strategy: 'generic-list-items' };
  }

  // Strategy 4: Last resort — any a[href*="/in/"] in main content
  log('[connections] Trying last-resort: all /in/ links in main');
  const lastResort = await page.evaluate(() => {
    const main = document.querySelector('main') || document.body;
    const links = main.querySelectorAll('a[href*="/in/"]');
    const seen = new Set();
    const results = [];

    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const slug = href.split('/in/')[1]?.split(/[/?#]/)[0];
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);

      // Must have meaningful text
      const text = a.textContent.trim();
      if (text.length < 3) continue;
      // Skip nav links
      if (a.closest('nav, header, [role="navigation"]')) continue;

      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const name = lines[0] || text;
      const headline = lines[1] || null;

      if (name.length > 1) {
        results.push({ name: name.replace(/\s*Connected\s*$/i, '').trim(), headline, href });
      }
    }

    return results;
  });

  if (lastResort.length > 0) {
    log(`[connections] Last-resort found ${lastResort.length} connections`);
    return { connections: lastResort, strategy: 'last-resort-all-in-links' };
  }

  return { connections: [], strategy: null };
}

// ── Main scraper ────────────────────────────────────────────────────────────

async function scrapeConnections() {
  const startTime = Date.now();
  console.log('\n[connections] Starting connections list sync...');

  const user = getConfig('linkedin_user', 'unknown');
  console.log(`[connections] Account: ${user}`);

  // Load selectors from self-heal config
  const selConfig = loadSelectors('connections');

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
    if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint') || currentUrl.includes('/authwall')) {
      console.error('[connections] ❌ LinkedIn session expired. Re-run Setup.');
      await browser.close();
      return { success: false, reason: 'session_expired' };
    }

    // ── Scroll to load all connections ───────────────────────────────────────
    console.log('[connections] Scrolling to load all connections...');

    let previousCount = 0;
    let stableRounds  = 0;
    let totalScrolls  = 0;
    const MAX_STABLE  = 5;    // stop after 5 scrolls with no new profile links
    const MAX_SCROLLS = 300;  // hard cap (~5k+ connections)

    while (stableRounds < MAX_STABLE && totalScrolls < MAX_SCROLLS) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(rand(1200, 2000));

      // Count profile links as a proxy for loaded connections
      const currentCount = await page.evaluate(() =>
        document.querySelectorAll('a[href*="/in/"]').length
      ).catch(() => 0);

      if (currentCount > previousCount) {
        if (VERBOSE || currentCount % 100 < 10) {
          console.log(`[connections]   Loaded ~${currentCount} profile links...`);
        }
        previousCount = currentCount;
        stableRounds  = 0;
      } else {
        stableRounds++;
      }

      // Try clicking "Show more results" button
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const showMore = btns.find(b => {
          const t = b.textContent.trim().toLowerCase();
          return t.includes('show more') || t.includes('load more');
        });
        if (showMore) showMore.click();
      }).catch(() => {});

      totalScrolls++;
    }

    console.log(`[connections] Scrolling complete (${totalScrolls} scrolls, ~${previousCount} profile links loaded)`);

    // ── Extract connections using multi-strategy approach ─────────────────────
    const { connections: rawConnections, strategy } = await extractConnections(page, selConfig);

    console.log(`[connections] Extracted ${rawConnections.length} connections via strategy: ${strategy || 'NONE'}`);

    // ── Handle zero results → diagnostic dump ────────────────────────────────
    if (rawConnections.length === 0) {
      console.log('[connections] ⚠️  No connections found — selectors may need updating.');
      console.log('[connections] Dumping DOM diagnostic for self-heal...');

      const strategiesTried = [
        ...(selConfig.strategies || []).map(s => s.name),
        'hardcoded-mn-connection-card',
        'generic-list-items',
        'last-resort-all-in-links',
      ];
      const diagnostic = await dumpDiagnostic(page, 'connections', strategiesTried);
      flagForRepair('connections', diagnostic);

      console.log('[connections] ❌ Diagnostic saved. Next time you open Cowork, Claude will auto-fix selectors.');
      await browser.close();
      return { success: false, reason: 'no_connections_found' };
    }

    // Selectors worked — clear any previous repair flag
    clearRepairFlag();

    if (DRY_RUN) {
      console.log(`[connections] --count mode: found ${rawConnections.length} connections. No changes written.`);
      await browser.close();
      return { success: true, total: rawConnections.length };
    }

    // ── Normalize URLs and assign batch groups ──────────────────────────────
    const toUpsert = rawConnections.map((c, i) => {
      const href = c.href || '';
      const profileUrl = href.startsWith('http')
        ? href.split('?')[0].replace(/\/$/, '')
        : `https://www.linkedin.com${href.split('?')[0].replace(/\/$/, '')}`;
      return {
        name: c.name,
        headline: c.headline,
        profile_url: profileUrl,
        batch_group: i % 7,
      };
    });

    // ── Write to database ─────────────────────────────────────────────────────
    const written = upsertManyConnections(toUpsert);
    const elapsed = Date.now() - startTime;

    console.log(`[connections] ✅ Sync complete: ${written} new/updated | ${rawConnections.length} total | ${(elapsed / 1000).toFixed(1)}s`);
    console.log(`[connections] Strategy used: ${strategy}`);

    const stats = getConnectionStats();
    console.log(`[connections] DB stats: ${stats.total} total | ${stats.active} active | ${stats.ever_scraped} ever scraped`);

    await browser.close();
    return { success: true, total: rawConnections.length, written, elapsed, strategy };

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

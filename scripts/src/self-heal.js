/**
 * self-heal.js — Self-healing selector system
 *
 * Three responsibilities:
 *   1. Load selectors from data/selectors.json (not hardcoded in scripts)
 *   2. Write diagnostic + needs-repair.json when all selectors fail
 *   3. Provide a check function that LFT Cowork skills call on startup
 *
 * How the self-healing loop works:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  Scraper runs → selectors work → posts collected → done    │
 *   └─────────────────────────────────────────────────────────────┘
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  Scraper runs → ALL selectors fail                         │
 *   │    → dumps DOM diagnostic to data/diagnostic.json          │
 *   │    → writes data/needs-repair.json flag                    │
 *   │    → tells user "Open Cowork and ask Claude anything"      │
 *   └─────────────────────────────────────────────────────────────┘
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  User opens Cowork → any LFT skill fires                  │
 *   │    → skill calls needsRepair()                             │
 *   │    → reads diagnostic.json                                 │
 *   │    → Claude analyzes DOM structure                         │
 *   │    → writes updated selectors.json                         │
 *   │    → clears needs-repair.json                              │
 *   │    → tells user "I fixed the scraper, re-run Collect Now"  │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * The user never sees a JSON file. The user never types a command.
 * Everything is invisible and automatic.
 */

const fs   = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');
const SELECTORS_FILE   = path.join(DATA_DIR, 'selectors.json');
const DIAGNOSTIC_FILE  = path.join(DATA_DIR, 'diagnostic.json');
const NEEDS_REPAIR     = path.join(DATA_DIR, 'needs-repair.json');

// ── Load selectors ──────────────────────────────────────────────────────────

/**
 * Load selector config for a specific scraper.
 * @param {'connections' | 'profile' | 'feed'} scraperName
 * @returns {object} Selector config for that scraper
 */
function loadSelectors(scraperName) {
  try {
    const raw = fs.readFileSync(SELECTORS_FILE, 'utf8');
    const config = JSON.parse(raw);
    if (!config[scraperName]) {
      console.warn(`[self-heal] No selectors found for "${scraperName}" — using empty config`);
      return {};
    }
    return config[scraperName];
  } catch (err) {
    console.warn(`[self-heal] Could not load selectors.json: ${err.message}`);
    console.warn('[self-heal] Falling back to empty config — scrapers will use hardcoded defaults');
    return {};
  }
}

/**
 * Load the full selectors config (for Claude to read and rewrite).
 */
function loadAllSelectors() {
  try {
    return JSON.parse(fs.readFileSync(SELECTORS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write updated selectors config (called by Claude after analyzing diagnostic).
 */
function writeSelectors(config) {
  config._updated_at = new Date().toISOString();
  config._updated_by = 'claude-self-heal';
  config._version = (config._version || 0) + 1;
  fs.writeFileSync(SELECTORS_FILE, JSON.stringify(config, null, 2));
}

// ── Diagnostic dump ─────────────────────────────────────────────────────────

/**
 * Dump DOM diagnostic info when selectors fail.
 * Runs inside page.evaluate() — returns structured data about the page.
 */
async function dumpDiagnostic(page, scraperName, strategiesTried = []) {
  const diagnostic = await page.evaluate(() => {
    const result = {};

    result.url = window.location.href;
    result.title = document.title;

    // All links with /in/ in href (connections/profiles)
    const profileLinks = document.querySelectorAll('a[href*="/in/"]');
    result.profileLinkCount = profileLinks.length;
    result.sampleLinks = Array.from(profileLinks).slice(0, 8).map(a => ({
      href: a.getAttribute('href'),
      text: a.textContent.trim().substring(0, 100),
      childTags: Array.from(a.children).map(c => c.tagName.toLowerCase()).join(', '),
      childClasses: Array.from(a.children).slice(0, 3).map(c => c.className?.substring(0, 60) || '').join(' | '),
    }));

    // Feed/activity post containers
    const knownContainers = [
      '.feed-shared-update-v2',
      '[data-urn*="activity"]',
      '.occludable-update',
      '.profile-creator-shared-feed-update__container',
    ];
    result.containerCounts = {};
    knownContainers.forEach(sel => {
      result.containerCounts[sel] = document.querySelectorAll(sel).length;
    });

    // Repeated element patterns (likely new container classes)
    const allElements = document.querySelectorAll('main *');
    const classCounts = {};
    allElements.forEach(el => {
      if (!el.className || typeof el.className !== 'string') return;
      el.className.split(/\s+/).forEach(cls => {
        if (cls.length > 3 && cls.length < 80) {
          classCounts[cls] = (classCounts[cls] || 0) + 1;
        }
      });
    });
    result.repeatedClasses = Object.entries(classCounts)
      .filter(([, v]) => v >= 5)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([cls, count]) => ({ cls, count }));

    // Lists with many children (likely card containers)
    result.largeLists = Array.from(document.querySelectorAll('ul, ol, div[role="list"], section'))
      .filter(el => el.children.length >= 5)
      .slice(0, 8)
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        childCount: el.children.length,
        firstChildTag: el.children[0]?.tagName?.toLowerCase(),
        firstChildClasses: el.children[0]?.className?.substring(0, 80),
        sampleChildHTML: el.children[0]?.innerHTML?.substring(0, 300),
      }));

    // Time elements (for post date extraction)
    const timeEls = document.querySelectorAll('time');
    result.timeElements = {
      count: timeEls.length,
      samples: Array.from(timeEls).slice(0, 5).map(t => ({
        text: t.textContent.trim(),
        datetime: t.getAttribute('datetime'),
        parentTag: t.parentElement?.tagName?.toLowerCase(),
        parentClass: t.parentElement?.className?.substring(0, 60),
      })),
    };

    // Text content sample from main area
    const main = document.querySelector('main') || document.body;
    result.pageTextSample = main.textContent.replace(/\s+/g, ' ').trim().substring(0, 1000);

    return result;
  });

  diagnostic.timestamp = new Date().toISOString();
  diagnostic.scraper = scraperName;
  diagnostic.strategies_tried = strategiesTried;

  // Write diagnostic
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DIAGNOSTIC_FILE, JSON.stringify(diagnostic, null, 2));

  return diagnostic;
}

// ── Needs repair flag ───────────────────────────────────────────────────────

/**
 * Signal that selectors are broken and Claude needs to fix them.
 */
function flagForRepair(scraperName, diagnostic) {
  const flag = {
    flagged_at: new Date().toISOString(),
    scraper: scraperName,
    reason: 'All selector strategies returned 0 results. LinkedIn likely changed their DOM.',
    diagnostic_file: DIAGNOSTIC_FILE,
    what_to_do: 'Claude reads diagnostic.json, analyzes the DOM structure, and writes updated selectors to selectors.json.',
    summary: diagnostic ? {
      url: diagnostic.url,
      profileLinkCount: diagnostic.profileLinkCount,
      containerCounts: diagnostic.containerCounts,
      repeatedClassesTop5: (diagnostic.repeatedClasses || []).slice(0, 5),
    } : null,
  };

  fs.writeFileSync(NEEDS_REPAIR, JSON.stringify(flag, null, 2));
  return flag;
}

/**
 * Check if repair is needed. Called by LFT Cowork skills on startup.
 * Returns null if everything is fine, or the repair flag object if broken.
 */
function needsRepair() {
  try {
    if (!fs.existsSync(NEEDS_REPAIR)) return null;
    return JSON.parse(fs.readFileSync(NEEDS_REPAIR, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read the full diagnostic dump for Claude to analyze.
 */
function readDiagnostic() {
  try {
    if (!fs.existsSync(DIAGNOSTIC_FILE)) return null;
    return JSON.parse(fs.readFileSync(DIAGNOSTIC_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Clear the repair flag after Claude fixes selectors.
 */
function clearRepairFlag() {
  try {
    if (fs.existsSync(NEEDS_REPAIR)) fs.unlinkSync(NEEDS_REPAIR);
    if (fs.existsSync(DIAGNOSTIC_FILE)) fs.unlinkSync(DIAGNOSTIC_FILE);
  } catch {}
}

module.exports = {
  loadSelectors,
  loadAllSelectors,
  writeSelectors,
  dumpDiagnostic,
  flagForRepair,
  needsRepair,
  readDiagnostic,
  clearRepairFlag,
  // Export paths for skills that need to read files directly
  SELECTORS_FILE,
  DIAGNOSTIC_FILE,
  NEEDS_REPAIR,
};

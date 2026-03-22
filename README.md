# LinkedIn Feed Tracker

Know what your LinkedIn network is talking about — before you post.

Scrapes your feed and connections' profiles every night, stores everything locally, then uses Claude to surface trends, generate reports, and track your own post performance. All data stays on your machine.

## What You Get

- **Trend analysis** — What topics are hot in your network this week
- **Engagement patterns** — What's getting likes, comments, and shares
- **Content gaps** — Topics your network cares about that nobody's covering well
- **Your own post performance** — Track how your posts do over time
- **Weekly intelligence reports** — Auto-generated Word doc every Sunday
- **Interactive dashboard** — Charts, filters, and breakdowns
- **Self-healing scrapers** — When LinkedIn changes their page, Claude auto-fixes the selectors

## Quick Start

1. Install the plugin
2. Say "set up LinkedIn Feed Tracker" — Claude walks you through everything conversationally
3. Your network gets scraped every night at 10 PM. Ask Claude anything about it anytime.

## Skills

| Skill | What it does |
|-------|-------------|
| analyze-feed | Surface trends, topic clusters, engagement patterns, and content gaps |
| weekly-report | Generate a Word document summarizing the week's LinkedIn activity |
| manage-topics | Add, remove, or edit the topic clusters you're tracking |
| dashboard | Generate an interactive HTML dashboard with charts and filters |
| self-heal | Auto-detect and fix broken selectors when LinkedIn changes their DOM |

## Commands

| Command | What it does |
|---------|-------------|
| /setup | First-time setup — dependencies, LinkedIn auth, topics, scheduling |
| /collect-now | Run an immediate feed + profile + own-post collection |
| /show-dashboard | Generate and display the analytics dashboard |
| /health-check | Check system health — database, scraping, batch coverage |

## Bundled Scripts

Playwright-based scrapers that run on your machine (not in the cloud):

| Script | What it does |
|--------|-------------|
| `collector.js` | Nightly feed scraper |
| `profile-collector.js` | Connection profile scraper (7-day batch rotation) |
| `connections.js` | Full connections list sync |
| `own-posts.js` | Your own post performance tracker |
| `database.js` | SQLite schema and operations |
| `self-heal.js` | Selector repair system — diagnostics, flagging, and auto-fix |
| `setup.js` | Authentication and initialization |
| `health.js` | System health checks |
| `topics.js` | Topic cluster management |

## How It Works

Your ~2,000 connections get split into 7 batch groups. Each night, 1/7th of your network gets visited. Full coverage in one week. Active posters get priority — they float to the top and get scraped every night.

| Task | Schedule |
|------|----------|
| Feed collection | Every night at 10:00 PM |
| Profile batch | Every night at 10:30 PM |
| Own-post tracking | Every night at 10:45 PM |
| Connections refresh | Sundays at 6:00 PM |

## Data & Privacy

All data stored locally at `scripts/data/feeds.db` (SQLite). No cloud. No API keys. No external services. Your LinkedIn data never leaves your machine.

## Requirements

- macOS (Apple Silicon or Intel)
- Node.js 20 LTS (setup handles this for you)
- Machine stays awake for nightly collections

---

## Coming Soon

This is **Plugin 1** of a 3-plugin ecosystem. Here's what's next:

### Plugin 2: Content Engine
Turn network intelligence into posts. Configure your posting cadence, pick your topics, and get AI-generated post ideas with multiple hook variations — question, story, contrarian, data-driven. Each variation scored before you see it. Learns from your actual post performance over time.

### Plugin 3: Audience Simulator
Before you post, know who'll engage. Builds audience segments from your actual connections — role, seniority, industry, posting behavior. Predicts which post variation will get the most traction and explains why. Calibrates against real results every week.

**The full loop:** Feed Tracker collects data → Content Engine generates ideas → Audience Simulator scores them → you pick and post → Feed Tracker measures performance → Content Engine learns → repeat.

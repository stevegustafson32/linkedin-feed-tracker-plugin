# LinkedIn Feed Tracker

Track what your LinkedIn network posts about, surface trends, and draft content — powered by nightly Playwright scraping and Claude's intelligence.

## What It Does

Scrapes your LinkedIn feed and connections' profiles every night, stores the data locally in SQLite, then uses Claude to analyze trends, generate reports, and draft posts. All data stays on your machine.

## Components

### Skills
| Skill | What it does |
|-------|-------------|
| analyze-feed | Read collected posts and surface trends, topic clusters, engagement patterns, and content gaps |
| weekly-report | Generate a formatted Word document summarizing the week's LinkedIn activity |
| draft-content | Write LinkedIn post drafts based on what your network is talking about |
| manage-topics | Add, remove, or edit the topic clusters you're tracking |
| dashboard | Generate an interactive HTML dashboard with charts and filters |

### Commands
| Command | What it does |
|---------|-------------|
| /setup | First-time setup — installs dependencies, authenticates LinkedIn, configures topics |
| /collect-now | Run an immediate feed + profile collection |
| /show-dashboard | Generate and display the analytics dashboard |
| /health-check | Check system health — database, scraping, batch coverage |

### Bundled Scripts
Playwright-based scrapers that run on schedule or on demand:
- `collector.js` — Nightly feed scraper
- `profile-scraper.js` — Connection profile scraper (7-day batch rotation)
- `connections.js` — Full connections list scraper
- `database.js` — SQLite schema and operations
- `setup.js` — Authentication and initialization
- `health.js` — System health checks

## Setup

Run `/setup` after installing the plugin. It walks you through everything conversationally.

### Requirements
- Node.js 20 LTS (Node 22 has compatibility issues with better-sqlite3 on Apple Silicon)
- Your machine needs to stay awake for nightly scheduled collections

## Scheduled Tasks
| Task | Schedule | What happens |
|------|----------|-------------|
| Feed collection | Every night at 10:00 PM | Scrapes your LinkedIn home feed |
| Profile batch | Every night at 10:30 PM | Scrapes tonight's connection batch (1/7th of network) |
| Connections refresh | Sundays at 6:00 PM | Re-scans your full connections list |

## Data

All data stored locally at `scripts/data/feeds.db` (SQLite). No cloud. No API keys. No external services.

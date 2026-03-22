/**
 * paths.js — Centralized data directory resolution
 *
 * All scripts import this to find the data directory.
 * Resolution order:
 *   1. LFT_DATA_DIR environment variable
 *   2. ~/.linkedin-feed-tracker/data-dir.txt (written by Setup.command)
 *   3. ./data/ fallback (relative to scripts dir)
 */

const fs   = require('fs');
const path = require('path');

function resolveDataDir() {
  if (process.env.LFT_DATA_DIR && fs.existsSync(process.env.LFT_DATA_DIR)) {
    return process.env.LFT_DATA_DIR;
  }

  const configPath = path.join(
    process.env.HOME || process.env.USERPROFILE || '~',
    '.linkedin-feed-tracker',
    'data-dir.txt'
  );
  try {
    const dir = fs.readFileSync(configPath, 'utf8').trim();
    if (dir && fs.existsSync(dir)) return dir;
  } catch {}

  return path.join(__dirname, '..', 'data');
}

const DATA_DIR    = resolveDataDir();
const DB_PATH     = path.join(DATA_DIR, 'feeds.db');
const PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

module.exports = { DATA_DIR, DB_PATH, PROFILE_DIR, resolveDataDir };

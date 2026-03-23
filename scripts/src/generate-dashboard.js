#!/usr/bin/env node
/**
 * generate-dashboard.js — Mac-side HTML dashboard generator
 *
 * Reads from the same SQLite DB used by all other scripts and outputs
 * a self-contained HTML dashboard with Chart.js to the data directory.
 *
 * Called from NightlyCollect.command after scraping completes.
 * Can also be run standalone: node src/generate-dashboard.js
 */

const path = require('path');
const fs   = require('fs');
const { db, getConnectionStats, getActiveConnectionCount, computeBatchCount } = require('./database');

// ── Data queries ────────────────────────────────────────────────────────────

function getData() {
  const data = {};

  // Config
  const configRows = db.prepare(`SELECT key, value FROM config`).all();
  const config = {};
  for (const r of configRows) config[r.key] = r.value;
  data.linkedin_user = config.linkedin_user || 'LinkedIn User';

  // Connections
  const connStats = getConnectionStats();
  data.total_connections = connStats.total || 0;
  data.active_connections = connStats.active || 0;
  data.ever_scraped = connStats.ever_scraped || 0;
  data.active_posters = connStats.active_posters || 0;

  // Batch info
  const totalActive = getActiveConnectionCount();
  data.batch_count = computeBatchCount(totalActive);
  data.profiles_per_night = Math.ceil(totalActive / data.batch_count);

  // Posts
  data.feed_posts = db.prepare(`SELECT COUNT(*) as cnt FROM posts`).get().cnt;

  // Own posts
  try {
    data.own_posts = db.prepare(`SELECT COUNT(*) as cnt FROM own_posts`).get().cnt;
  } catch { data.own_posts = 0; }

  // Collection runs
  try {
    const runs = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as successful
      FROM collection_runs
    `).get();
    data.collection_runs_total = runs.total;
    data.collection_runs_successful = runs.successful || 0;
  } catch {
    data.collection_runs_total = 0;
    data.collection_runs_successful = 0;
  }

  // Days tracking
  try {
    const first = db.prepare(`SELECT MIN(ran_at) as first_run FROM collection_runs WHERE status = 'ok'`).get();
    if (first && first.first_run) {
      const firstDate = new Date(first.first_run);
      data.days_tracking = Math.max(0, Math.floor((Date.now() - firstDate) / 86400000));
    } else {
      data.days_tracking = 0;
    }
  } catch { data.days_tracking = 0; }

  // Collection timeline (last 30 days)
  try {
    data.collection_timeline = db.prepare(`
      SELECT ran_at, posts_found, posts_new
      FROM collection_runs
      WHERE status = 'ok'
      ORDER BY ran_at DESC
      LIMIT 30
    `).all().reverse();
  } catch { data.collection_timeline = []; }

  // Top authors
  data.top_authors = db.prepare(`
    SELECT author_name, COUNT(*) as post_count
    FROM posts
    GROUP BY author_name
    ORDER BY post_count DESC
    LIMIT 10
  `).all();

  // Post type distribution
  data.post_type_distribution = db.prepare(`
    SELECT post_type, COUNT(*) as count
    FROM posts
    GROUP BY post_type
  `).all();

  // Batch distribution
  data.batch_distribution = db.prepare(`
    SELECT batch_group, COUNT(*) as count
    FROM connections
    WHERE is_active = 1
    GROUP BY batch_group
    ORDER BY batch_group
  `).all();

  // Top network posts
  data.top_posts = db.prepare(`
    SELECT author_name, content_short, likes, comments, post_type, post_date, post_url
    FROM posts
    ORDER BY (likes + comments) DESC
    LIMIT 10
  `).all();

  // Own post performance
  try {
    data.own_posts_list = db.prepare(`
      SELECT content_short, likes, comments, reposts, post_type
      FROM own_posts
      ORDER BY (likes + comments + reposts) DESC
      LIMIT 10
    `).all();
  } catch { data.own_posts_list = []; }

  // Profile scrape runs
  try {
    data.profile_runs = db.prepare(`
      SELECT ran_at, batch_group, profiles_total, profiles_done, posts_new, duration_ms, status
      FROM profile_scrape_runs
      ORDER BY ran_at DESC
      LIMIT 14
    `).all().reverse();
  } catch { data.profile_runs = []; }

  data.last_updated = new Date().toISOString();
  return data;
}

// ── HTML template ───────────────────────────────────────────────────────────

function esc(text) {
  if (!text) return '';
  return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function truncate(text, len = 50) {
  if (!text) return '';
  const s = String(text);
  return s.length > len ? s.slice(0, len) + '...' : s;
}

function generateHTML(data) {
  const topAuthorsLabels = JSON.stringify(data.top_authors.map(a => a.author_name));
  const topAuthorsData   = JSON.stringify(data.top_authors.map(a => a.post_count));

  const timelineLabels = JSON.stringify(data.collection_timeline.map(t => {
    const d = new Date(t.ran_at);
    return `${d.getMonth()+1}/${d.getDate()}`;
  }));
  const timelineData = JSON.stringify(data.collection_timeline.map(t => t.posts_found || 0));
  const timelineNew  = JSON.stringify(data.collection_timeline.map(t => t.posts_new || 0));

  const typeLabels = JSON.stringify(data.post_type_distribution.map(p => p.post_type || 'unknown'));
  const typeData   = JSON.stringify(data.post_type_distribution.map(p => p.count));

  const batchLabels = JSON.stringify(data.batch_distribution.map(b => `Batch ${b.batch_group}`));
  const batchData   = JSON.stringify(data.batch_distribution.map(b => b.count));

  // Top posts table rows
  const topPostRows = data.top_posts.map(p => {
    const content = esc(truncate(p.content_short, 45));
    const link = p.post_url ? `<a href="${esc(p.post_url)}" target="_blank">${content}</a>` : content;
    return `<tr>
      <td><strong>${esc(p.author_name)}</strong></td>
      <td>${link}</td>
      <td>👍 ${p.likes || 0} · 💬 ${p.comments || 0}</td>
      <td>${esc(p.post_type)}</td>
    </tr>`;
  }).join('\n');

  // Own posts table rows
  const ownPostRows = data.own_posts_list.map(p => {
    return `<tr>
      <td>${esc(truncate(p.content_short, 50))}</td>
      <td>👍 ${p.likes || 0}</td>
      <td>💬 ${p.comments || 0}</td>
      <td>🔄 ${p.reposts || 0}</td>
      <td>${esc(p.post_type)}</td>
    </tr>`;
  }).join('\n');

  // Profile run rows
  const profileRunRows = data.profile_runs.map(r => {
    const d = new Date(r.ran_at);
    const dateStr = `${d.getMonth()+1}/${d.getDate()}`;
    const dur = r.duration_ms ? `${(r.duration_ms / 60000).toFixed(1)}m` : '-';
    const statusIcon = r.status === 'ok' ? '✅' : '⚠️';
    return `<tr>
      <td>${dateStr}</td>
      <td>Batch ${r.batch_group}</td>
      <td>${r.profiles_done}/${r.profiles_total}</td>
      <td>${r.posts_new} new</td>
      <td>${dur}</td>
      <td>${statusIcon}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LinkedIn Feed Tracker — Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0f; color: #e0e0e0; padding: 24px; }
  .header { text-align: center; margin-bottom: 32px; }
  .header h1 { font-size: 28px; color: #fff; margin-bottom: 4px; }
  .header .subtitle { color: #888; font-size: 14px; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .stat-card { background: #16161e; border: 1px solid #2a2a3a; border-radius: 12px; padding: 20px; text-align: center; }
  .stat-card .value { font-size: 32px; font-weight: 700; color: #fff; }
  .stat-card .label { font-size: 13px; color: #888; margin-top: 4px; }
  .stat-card .sublabel { font-size: 11px; color: #555; margin-top: 2px; }
  .charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 32px; }
  .chart-card { background: #16161e; border: 1px solid #2a2a3a; border-radius: 12px; padding: 20px; }
  .chart-card h3 { font-size: 16px; color: #fff; margin-bottom: 16px; }
  .section { background: #16161e; border: 1px solid #2a2a3a; border-radius: 12px; padding: 20px; margin-bottom: 24px; }
  .section h2 { font-size: 18px; color: #fff; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 12px; border-bottom: 1px solid #2a2a3a; color: #888; font-weight: 600; }
  td { padding: 8px 12px; border-bottom: 1px solid #1a1a2a; }
  a { color: #6b8afd; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .footer { text-align: center; color: #555; font-size: 12px; margin-top: 32px; }
  @media (max-width: 768px) { .charts-grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
  <div class="header">
    <h1>LinkedIn Feed Tracker</h1>
    <div class="subtitle">${esc(data.linkedin_user)} · Updated ${new Date(data.last_updated).toLocaleString()}</div>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="value">${data.total_connections.toLocaleString()}</div>
      <div class="label">Connections</div>
      <div class="sublabel">${data.active_posters} active posters</div>
    </div>
    <div class="stat-card">
      <div class="value">${data.feed_posts.toLocaleString()}</div>
      <div class="label">Feed Posts Tracked</div>
      <div class="sublabel">${data.days_tracking} days tracking</div>
    </div>
    <div class="stat-card">
      <div class="value">${data.own_posts}</div>
      <div class="label">Your Posts</div>
    </div>
    <div class="stat-card">
      <div class="value">${data.batch_count}</div>
      <div class="label">Batch Rotation</div>
      <div class="sublabel">~${data.profiles_per_night} profiles/night</div>
    </div>
    <div class="stat-card">
      <div class="value">${data.collection_runs_successful}</div>
      <div class="label">Successful Runs</div>
      <div class="sublabel">${data.collection_runs_total} total</div>
    </div>
    <div class="stat-card">
      <div class="value">${data.ever_scraped}</div>
      <div class="label">Profiles Scraped</div>
      <div class="sublabel">of ${data.active_connections} active</div>
    </div>
  </div>

  <div class="charts-grid">
    <div class="chart-card">
      <h3>Collection Timeline</h3>
      <canvas id="timelineChart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Top Authors</h3>
      <canvas id="authorsChart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Post Type Distribution</h3>
      <canvas id="typeChart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Batch Distribution</h3>
      <canvas id="batchChart"></canvas>
    </div>
  </div>

  <div class="section">
    <h2>Top Network Posts</h2>
    <table>
      <thead><tr><th>Author</th><th>Content</th><th>Engagement</th><th>Type</th></tr></thead>
      <tbody>${topPostRows}</tbody>
    </table>
  </div>

  ${data.own_posts_list.length > 0 ? `<div class="section">
    <h2>Your Post Performance</h2>
    <table>
      <thead><tr><th>Content</th><th>Likes</th><th>Comments</th><th>Reposts</th><th>Type</th></tr></thead>
      <tbody>${ownPostRows}</tbody>
    </table>
  </div>` : ''}

  <div class="section">
    <h2>Profile Scrape History</h2>
    <table>
      <thead><tr><th>Date</th><th>Batch</th><th>Profiles</th><th>Posts</th><th>Duration</th><th>Status</th></tr></thead>
      <tbody>${profileRunRows}</tbody>
    </table>
  </div>

  <div class="footer">
    LinkedIn Feed Tracker · Auto-generated dashboard · ${data.batch_count}-batch rotation
  </div>

<script>
const chartDefaults = { color: '#888', borderColor: '#2a2a3a' };
Chart.defaults.color = '#888';
Chart.defaults.borderColor = '#2a2a3a';

// Timeline
new Chart(document.getElementById('timelineChart'), {
  type: 'line',
  data: {
    labels: ${timelineLabels},
    datasets: [
      { label: 'Posts Found', data: ${timelineData}, borderColor: '#6b8afd', backgroundColor: 'rgba(107,138,253,0.1)', fill: true, tension: 0.3 },
      { label: 'New Posts', data: ${timelineNew}, borderColor: '#4ade80', backgroundColor: 'rgba(74,222,128,0.1)', fill: true, tension: 0.3 }
    ]
  },
  options: { responsive: true, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true } } }
});

// Authors
new Chart(document.getElementById('authorsChart'), {
  type: 'bar',
  data: {
    labels: ${topAuthorsLabels},
    datasets: [{ label: 'Posts', data: ${topAuthorsData}, backgroundColor: '#6b8afd', borderRadius: 4 }]
  },
  options: { responsive: true, indexAxis: 'y', plugins: { legend: { display: false } } }
});

// Post types
new Chart(document.getElementById('typeChart'), {
  type: 'doughnut',
  data: {
    labels: ${typeLabels},
    datasets: [{ data: ${typeData}, backgroundColor: ['#6b8afd','#4ade80','#f59e0b','#ef4444','#a78bfa','#ec4899','#14b8a6'] }]
  },
  options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
});

// Batch distribution
new Chart(document.getElementById('batchChart'), {
  type: 'bar',
  data: {
    labels: ${batchLabels},
    datasets: [{ label: 'Connections', data: ${batchData}, backgroundColor: '#4ade80', borderRadius: 4 }]
  },
  options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
});
</script>
</body>
</html>`;
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log('[dashboard] Generating dashboard...');

  const data = getData();

  // Determine output path — same directory as DB
  const dataDir = process.env.LFT_DATA_DIR
    || (() => {
      const dataDirFile = path.join(require('os').homedir(), '.linkedin-feed-tracker', 'data-dir.txt');
      if (fs.existsSync(dataDirFile)) return fs.readFileSync(dataDirFile, 'utf8').trim();
      return path.join(__dirname, '..', 'data');
    })();

  const outPath = path.join(dataDir, 'dashboard.html');
  fs.writeFileSync(outPath, generateHTML(data), 'utf8');

  console.log(`[dashboard] ✅ Dashboard written to ${outPath}`);
  console.log(`[dashboard] 📊 ${data.feed_posts} feed posts | ${data.total_connections} connections | ${data.batch_count} batches`);
}

main();

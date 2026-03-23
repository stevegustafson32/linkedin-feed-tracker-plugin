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
    SELECT author_name, author_title, content_short, content, likes, comments, post_type, post_date, post_url
    FROM posts
    ORDER BY (likes + comments) DESC
    LIMIT 15
  `).all();

  // All posts for topic extraction
  data.all_posts = db.prepare(`
    SELECT author_name, content, content_short, likes, comments, post_type, post_date
    FROM posts
    ORDER BY post_date DESC
  `).all();

  // Own post performance
  try {
    data.own_posts_list = db.prepare(`
      SELECT content_short, likes, comments, reposts, post_type, is_baseline
      FROM own_posts
      ORDER BY (likes + comments + reposts) DESC
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

  // ── Topic extraction ────────────────────────────────────────────────────────
  // Simple keyword/theme detection from post content
  const topicKeywords = {
    'AI & Machine Learning': ['ai', 'artificial intelligence', 'machine learning', 'ml', 'gpt', 'llm', 'chatgpt', 'claude', 'generative ai', 'deep learning', 'neural', 'model'],
    'Sales & Revenue': ['sales', 'revenue', 'pipeline', 'quota', 'close', 'deal', 'prospect', 'outbound', 'inbound', 'cold email', 'b2b', 'gtm', 'go-to-market'],
    'Leadership & Management': ['leadership', 'management', 'team', 'culture', 'hiring', 'manager', 'executive', 'ceo', 'founder', 'leader'],
    'Startups & Entrepreneurship': ['startup', 'founder', 'fundrais', 'seed', 'series a', 'venture', 'vc', 'pivot', 'mvp', 'product-market fit', 'tam', 'sam', 'som'],
    'Marketing & Growth': ['marketing', 'brand', 'content', 'seo', 'social media', 'growth', 'acquisition', 'campaign', 'newsletter', 'audience'],
    'Career & Personal': ['career', 'job', 'role', 'position', 'hired', 'promoted', 'new role', 'starting', 'excited to share', 'proud', 'journey', 'milestone'],
    'Technology & SaaS': ['saas', 'software', 'platform', 'api', 'cloud', 'data', 'analytics', 'product', 'feature', 'launch', 'integration'],
    'Finance & Investing': ['invest', 'funding', 'valuation', 'capital', 'financial', 'market', 'stock', 'portfolio', 'returns'],
    'Health & Wellness': ['health', 'wellness', 'mental health', 'burnout', 'self-care', 'sustainability', 'wellbeing'],
    'Networking & Events': ['event', 'conference', 'summit', 'webinar', 'meetup', 'networking', 'connect', 'community'],
  };

  const topicCounts = {};
  const topicEngagement = {};
  for (const topic of Object.keys(topicKeywords)) {
    topicCounts[topic] = 0;
    topicEngagement[topic] = 0;
  }

  for (const post of data.all_posts) {
    const text = (post.content || post.content_short || '').toLowerCase();
    for (const [topic, keywords] of Object.entries(topicKeywords)) {
      if (keywords.some(kw => text.includes(kw))) {
        topicCounts[topic]++;
        topicEngagement[topic] += (post.likes || 0) + (post.comments || 0);
      }
    }
  }

  // Sort topics by count, filter out zeros
  data.topics = Object.entries(topicCounts)
    .filter(([_, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count, engagement: topicEngagement[name] }));

  // ── Engagement insights ─────────────────────────────────────────────────────
  const totalPosts = data.all_posts.length;
  const totalEngagement = data.all_posts.reduce((sum, p) => sum + (p.likes || 0) + (p.comments || 0), 0);
  data.avg_engagement = totalPosts > 0 ? (totalEngagement / totalPosts).toFixed(1) : '0';
  data.total_engagement = totalEngagement;

  // Top engaged post
  data.top_engaged_post = data.all_posts.length > 0
    ? data.all_posts.reduce((best, p) => ((p.likes||0)+(p.comments||0)) > ((best.likes||0)+(best.comments||0)) ? p : best)
    : null;

  // Own posts insights
  const ownTotal = data.own_posts_list.length;
  const ownEngagement = data.own_posts_list.reduce((sum, p) => sum + (p.likes||0) + (p.comments||0) + (p.reposts||0), 0);
  data.own_avg_engagement = ownTotal > 0 ? (ownEngagement / ownTotal).toFixed(1) : '0';
  data.own_total_engagement = ownEngagement;
  data.own_best_post = ownTotal > 0
    ? data.own_posts_list.reduce((best, p) => ((p.likes||0)+(p.comments||0)+(p.reposts||0)) > ((best.likes||0)+(best.comments||0)+(best.reposts||0)) ? p : best)
    : null;

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
  // Truncate author names for charts
  const topAuthorsLabels = JSON.stringify(data.top_authors.map(a => truncate(a.author_name, 25)));
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

  // Topic data
  const topicLabels = JSON.stringify(data.topics.map(t => t.name));
  const topicData   = JSON.stringify(data.topics.map(t => t.count));
  const topicEngData = JSON.stringify(data.topics.map(t => t.engagement));

  // Top posts table rows
  const topPostRows = data.top_posts.map(p => {
    const content = esc(truncate(p.content_short, 60));
    const link = p.post_url ? `<a href="${esc(p.post_url)}" target="_blank">${content}</a>` : content;
    const authorDisplay = esc(truncate(p.author_name, 30));
    const titleDisplay = p.author_title ? `<div style="font-size:11px;color:#666;margin-top:1px;">${esc(truncate(p.author_title, 40))}</div>` : '';
    return `<tr>
      <td><strong>${authorDisplay}</strong>${titleDisplay}</td>
      <td style="max-width:300px;">${link}</td>
      <td style="white-space:nowrap;">👍 ${p.likes || 0} · 💬 ${p.comments || 0}</td>
      <td>${esc(p.post_type)}</td>
    </tr>`;
  }).join('\n');

  // Own posts table rows
  const ownPostRows = data.own_posts_list.slice(0, 15).map(p => {
    const total = (p.likes||0) + (p.comments||0) + (p.reposts||0);
    return `<tr>
      <td style="max-width:350px;">${esc(truncate(p.content_short, 65))}</td>
      <td style="text-align:center;">👍 ${p.likes || 0}</td>
      <td style="text-align:center;">💬 ${p.comments || 0}</td>
      <td style="text-align:center;">🔄 ${p.reposts || 0}</td>
      <td style="text-align:center;font-weight:600;">${total}</td>
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

  // Insight cards
  const topEngagedContent = data.top_engaged_post
    ? `<strong>${esc(truncate(data.top_engaged_post.author_name, 25))}</strong> — ${(data.top_engaged_post.likes||0)+(data.top_engaged_post.comments||0)} engagements`
    : 'No posts yet';
  const ownBestContent = data.own_best_post
    ? `${esc(truncate(data.own_best_post.content_short, 50))} — ${(data.own_best_post.likes||0)+(data.own_best_post.comments||0)+(data.own_best_post.reposts||0)} total`
    : 'No posts yet';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LinkedIn Feed Tracker — Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0f; color: #e0e0e0; display: flex; flex-direction: column; overflow: hidden; }
  .header { display: flex; align-items: center; justify-content: space-between; padding: 14px 24px 10px; flex-shrink: 0; }
  .header h1 { font-size: 20px; color: #fff; }
  .header .sub { color: #555; font-size: 12px; }

  /* Stats strip */
  .stats { display: flex; gap: 10px; padding: 0 24px 12px; flex-shrink: 0; overflow-x: auto; }
  .st { background: #16161e; border: 1px solid #2a2a3a; border-radius: 10px; padding: 12px 16px; min-width: 120px; text-align: center; flex: 1; }
  .st .v { font-size: 22px; font-weight: 700; color: #fff; }
  .st .l { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 1px; }
  .st .s { font-size: 9px; color: #555; }

  /* Insight strip */
  .insights { display: flex; gap: 10px; padding: 0 24px 12px; flex-shrink: 0; }
  .insight { background: linear-gradient(135deg, rgba(107,138,253,0.08), rgba(107,138,253,0.02)); border: 1px solid rgba(107,138,253,0.2); border-radius: 10px; padding: 12px 16px; flex: 1; }
  .insight.green { background: linear-gradient(135deg, rgba(74,222,128,0.08), rgba(74,222,128,0.02)); border-color: rgba(74,222,128,0.2); }
  .insight.purple { background: linear-gradient(135deg, rgba(167,139,250,0.08), rgba(167,139,250,0.02)); border-color: rgba(167,139,250,0.2); }
  .insight .il { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .insight .iv { font-size: 13px; color: #e0e0e0; line-height: 1.4; }

  /* Tabs */
  .tab-bar { display: flex; gap: 0; padding: 0 24px; flex-shrink: 0; border-bottom: 1px solid #2a2a3a; }
  .tab { padding: 8px 20px; font-size: 13px; font-weight: 600; color: #555; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.15s; user-select: none; }
  .tab:hover { color: #aaa; }
  .tab.active { color: #6b8afd; border-bottom-color: #6b8afd; }
  .tab-content { flex: 1; overflow-y: auto; padding: 16px 24px; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  /* Layout */
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
  .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-bottom: 14px; }
  .card { background: #16161e; border: 1px solid #2a2a3a; border-radius: 10px; padding: 14px; }
  .card h3 { font-size: 13px; color: #aaa; margin-bottom: 10px; font-weight: 600; }
  .full { grid-column: 1 / -1; }

  /* Tables */
  .tbl { background: #16161e; border: 1px solid #2a2a3a; border-radius: 10px; overflow: hidden; margin-bottom: 14px; }
  .tbl h3 { font-size: 13px; color: #aaa; padding: 12px 14px 0; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 8px 12px; border-bottom: 1px solid #2a2a3a; color: #555; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; }
  td { padding: 7px 12px; border-bottom: 1px solid #1a1a24; }
  tr:last-child td { border-bottom: none; }
  a { color: #6b8afd; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { text-align: center; padding: 36px 24px; color: #444; }

  /* Topic pills */
  .topics { display: flex; flex-wrap: wrap; gap: 8px; }
  .topic { background: rgba(107,138,253,0.1); border: 1px solid rgba(107,138,253,0.2); border-radius: 20px; padding: 6px 14px; font-size: 12px; color: #aaa; }
  .topic .tc { font-weight: 700; color: #6b8afd; margin-left: 6px; }
  .topic .te { font-size: 10px; color: #666; margin-left: 4px; }

  @media (max-width: 768px) { .row, .row3 { grid-template-columns: 1fr; } }
</style>
</head>
<body>

<div class="header">
  <div><h1>LinkedIn Feed Tracker</h1><div class="sub">${esc(data.linkedin_user)}</div></div>
  <div style="text-align:right;"><div style="font-size:11px;color:#444;">Updated</div><div style="font-size:12px;color:#777;">${new Date(data.last_updated).toLocaleString()}</div></div>
</div>

<div class="stats">
  <div class="st"><div class="v">${data.feed_posts.toLocaleString()}</div><div class="l">Posts Tracked</div><div class="s">${data.days_tracking} days</div></div>
  <div class="st"><div class="v">${data.total_connections.toLocaleString()}</div><div class="l">Connections</div><div class="s">${data.active_posters} active</div></div>
  <div class="st"><div class="v">${data.avg_engagement}</div><div class="l">Avg Engagement</div><div class="s">${data.total_engagement} total</div></div>
  <div class="st"><div class="v">${data.own_posts}</div><div class="l">Your Posts</div><div class="s">${data.own_avg_engagement} avg eng.</div></div>
  <div class="st"><div class="v">${data.topics.length}</div><div class="l">Topics</div><div class="s">${data.topics[0] ? data.topics[0].name : '-'}</div></div>
  <div class="st"><div class="v">${data.batch_count}</div><div class="l">Batches</div><div class="s">~${data.profiles_per_night}/night</div></div>
</div>

<div class="insights">
  <div class="insight"><div class="il">Top Performing Post</div><div class="iv">${topEngagedContent}</div></div>
  <div class="insight green"><div class="il">Your Best Post</div><div class="iv">${ownBestContent}</div></div>
  <div class="insight purple"><div class="il">Top Theme</div><div class="iv">${data.topics[0] ? `<strong>${data.topics[0].name}</strong> — ${data.topics[0].count} posts, ${data.topics[0].engagement} engagements` : 'Collecting data...'}</div></div>
</div>

<div class="tab-bar">
  <div class="tab active" data-tab="network">Network</div>
  <div class="tab" data-tab="themes">Themes</div>
  <div class="tab" data-tab="yours">Your Posts</div>
  <div class="tab" data-tab="system">System</div>
</div>

<div class="tab-content">

  <!-- NETWORK TAB -->
  <div class="tab-panel active" id="panel-network">
    <div class="row">
      <div class="card"><h3>Collection Timeline</h3><canvas id="timelineChart"></canvas></div>
      <div class="card"><h3>Top Authors</h3><canvas id="authorsChart"></canvas></div>
    </div>
    <div class="row">
      <div class="card"><h3>Post Types</h3><canvas id="typeChart"></canvas></div>
      <div class="tbl">
        <h3>Top Network Posts by Engagement</h3>
        <table>
          <thead><tr><th>Author</th><th>Content</th><th>Engagement</th><th>Type</th></tr></thead>
          <tbody>${topPostRows || '<tr><td colspan="4" class="empty">No posts yet — run a collection first</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- THEMES TAB -->
  <div class="tab-panel" id="panel-themes">
    <div class="row">
      <div class="card"><h3>Topic Distribution</h3><canvas id="topicChart"></canvas></div>
      <div class="card"><h3>Topic Engagement</h3><canvas id="topicEngChart"></canvas></div>
    </div>
    <div class="card full" style="margin-bottom:14px;">
      <h3>Detected Themes</h3>
      ${data.topics.length > 0 ? `<div class="topics">${data.topics.map(t =>
        `<div class="topic">${esc(t.name)}<span class="tc">${t.count}</span><span class="te">${t.engagement} eng</span></div>`
      ).join('')}</div>` : '<div class="empty">Not enough posts yet to detect themes. Run more collections to build your dataset.</div>'}
    </div>
  </div>

  <!-- YOUR POSTS TAB -->
  <div class="tab-panel" id="panel-yours">
    ${data.own_posts_list.length > 0 ? `
    <div class="tbl">
      <h3>Your Post Performance (sorted by total engagement)</h3>
      <table>
        <thead><tr><th>Content</th><th style="text-align:center">Likes</th><th style="text-align:center">Comments</th><th style="text-align:center">Reposts</th><th style="text-align:center">Total</th></tr></thead>
        <tbody>${ownPostRows}</tbody>
      </table>
    </div>` : '<div class="empty">No own posts tracked yet.</div>'}
  </div>

  <!-- SYSTEM TAB -->
  <div class="tab-panel" id="panel-system">
    <div class="row">
      <div class="card"><h3>Batch Distribution</h3><canvas id="batchChart"></canvas></div>
      <div class="tbl">
        <h3>Profile Scrape History</h3>
        <table>
          <thead><tr><th>Date</th><th>Batch</th><th>Profiles</th><th>Posts</th><th>Duration</th><th>Status</th></tr></thead>
          <tbody>${profileRunRows || '<tr><td colspan="6" class="empty">No scrape runs yet</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  </div>

</div>

<script>
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  });
});

Chart.defaults.color = '#888';
Chart.defaults.borderColor = '#2a2a3a';
const colors = ['#6b8afd','#4ade80','#f59e0b','#ef4444','#a78bfa','#ec4899','#14b8a6','#f97316','#06b6d4','#84cc16'];

new Chart(document.getElementById('timelineChart'), {
  type: 'line',
  data: { labels: ${timelineLabels}, datasets: [
    { label: 'Found', data: ${timelineData}, borderColor: '#6b8afd', backgroundColor: 'rgba(107,138,253,0.1)', fill: true, tension: 0.3, pointRadius: 2 },
    { label: 'New', data: ${timelineNew}, borderColor: '#4ade80', backgroundColor: 'rgba(74,222,128,0.1)', fill: true, tension: 0.3, pointRadius: 2 }
  ]},
  options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } } }, scales: { y: { beginAtZero: true } } }
});

new Chart(document.getElementById('authorsChart'), {
  type: 'bar',
  data: { labels: ${topAuthorsLabels}, datasets: [{ data: ${topAuthorsData}, backgroundColor: '#6b8afd', borderRadius: 3 }] },
  options: { responsive: true, indexAxis: 'y', plugins: { legend: { display: false } } }
});

new Chart(document.getElementById('typeChart'), {
  type: 'doughnut',
  data: { labels: ${typeLabels}, datasets: [{ data: ${typeData}, backgroundColor: colors, borderWidth: 0 }] },
  options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } } } }
});

new Chart(document.getElementById('topicChart'), {
  type: 'bar',
  data: { labels: ${topicLabels}, datasets: [{ label: 'Posts', data: ${topicData}, backgroundColor: colors, borderRadius: 3 }] },
  options: { responsive: true, indexAxis: 'y', plugins: { legend: { display: false } } }
});

new Chart(document.getElementById('topicEngChart'), {
  type: 'bar',
  data: { labels: ${topicLabels}, datasets: [{ label: 'Engagement', data: ${topicEngData}, backgroundColor: colors.map(c => c + '88'), borderRadius: 3 }] },
  options: { responsive: true, indexAxis: 'y', plugins: { legend: { display: false } } }
});

new Chart(document.getElementById('batchChart'), {
  type: 'bar',
  data: { labels: ${batchLabels}, datasets: [{ data: ${batchData}, backgroundColor: '#4ade80', borderRadius: 3 }] },
  options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
});
<\/script>
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

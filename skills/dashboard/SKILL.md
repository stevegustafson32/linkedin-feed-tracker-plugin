---
name: dashboard
description: >
  Generate an interactive HTML dashboard showing LinkedIn feed analytics. Use this skill when the
  user says "show me my dashboard," "LinkedIn dashboard," "show my analytics," "feed stats,"
  "network dashboard," "visualize my data," or any request to see a visual overview of their
  LinkedIn network's activity. Also triggers on "show me charts" or "how's my feed doing."
version: 2.0.0
---

# LinkedIn Feed Dashboard

Generate a self-contained interactive HTML dashboard from the user's feeds.db SQLite database.

## Step 1 — Locate the Database

Find `feeds.db` by checking these locations in order:
1. The user's mounted workspace folder: look for `*/LinkedIn Feed Tracker/feeds.db` or `*/linkedin-feed-tracker/feeds.db` under the Cowork mount path
2. Any path the user specifies

If you cannot find feeds.db, tell the user and ask where their LinkedIn Feed Tracker data folder is.

## Step 2 — Extract Data and Generate Dashboard

Run the following Python script using `python3`. Replace `DB_PATH` and `OUTPUT_PATH` with the actual paths you found in Step 1. Save the dashboard HTML into the same directory as feeds.db.

```python
#!/usr/bin/env python3
"""
LinkedIn Feed Tracker — Dashboard Generator v2
Reads feeds.db → generates self-contained HTML dashboard.
"""
import sqlite3, json, os
from datetime import datetime

DB_PATH = "REPLACE_WITH_ACTUAL_DB_PATH"
OUTPUT_PATH = os.path.join(os.path.dirname(DB_PATH), "dashboard.html")

def extract_data():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    c = db.cursor()

    c.execute("""SELECT id, post_url, content_short, posted_at, posted_at_raw,
                   collected_at, likes, comments, reposts, impressions,
                   post_type, content_hash, is_baseline
            FROM own_posts ORDER BY (likes + comments + reposts) DESC""")
    own_posts = [dict(r) for r in c.fetchall()]

    c.execute("""SELECT id, collected_at, post_date, author_name, author_title,
                   post_type, content_short, engagement, likes, comments,
                   is_repost, repost_author, has_link, content_hash
            FROM posts ORDER BY (likes + comments) DESC""")
    feed_posts = [dict(r) for r in c.fetchall()]

    c.execute("SELECT COUNT(*) FROM connections")
    total_connections = c.fetchone()[0]

    c.execute("SELECT MIN(added_at) FROM connections")
    baseline_date = c.fetchone()[0]

    c.execute("""SELECT DATE(added_at) as day, COUNT(*) as count
            FROM connections GROUP BY DATE(added_at) ORDER BY day""")
    connection_growth = [dict(r) for r in c.fetchall()]

    c.execute("""SELECT COUNT(*) FROM connections
            WHERE added_at > (SELECT MIN(added_at) FROM connections)""")
    new_connections = c.fetchone()[0]

    c.execute("""SELECT id, ran_at, posts_found, posts_new, duration_ms, status, notes
            FROM collection_runs ORDER BY ran_at DESC""")
    collection_runs = [dict(r) for r in c.fetchall()]

    c.execute("SELECT COUNT(*) FROM profile_scrape_runs")
    profile_runs = c.fetchone()[0]

    c.execute("""SELECT COUNT(*) as total,
                   SUM(CASE WHEN is_baseline = 1 THEN 1 ELSE 0 END) as baseline_count,
                   SUM(CASE WHEN is_baseline = 0 THEN 1 ELSE 0 END) as tracked_count,
                   AVG(likes) as avg_likes, AVG(comments) as avg_comments,
                   AVG(reposts) as avg_reposts, MAX(likes) as max_likes,
                   MAX(comments) as max_comments, MAX(reposts) as max_reposts,
                   SUM(likes) as total_likes, SUM(comments) as total_comments,
                   SUM(reposts) as total_reposts
            FROM own_posts""")
    own_stats = dict(c.fetchone())

    c.execute("""SELECT post_type, COUNT(*) as count,
                   AVG(likes) as avg_likes, AVG(comments) as avg_comments,
                   AVG(reposts) as avg_reposts
            FROM own_posts GROUP BY post_type""")
    own_by_type = [dict(r) for r in c.fetchall()]

    c.execute("""SELECT COUNT(*) as total, COUNT(DISTINCT author_name) as unique_authors,
                   AVG(likes) as avg_likes, AVG(comments) as avg_comments,
                   MAX(likes) as max_likes, MAX(comments) as max_comments
            FROM posts""")
    feed_stats = dict(c.fetchone())

    c.execute("""SELECT post_date, COUNT(*) as count, SUM(likes) as total_likes
            FROM posts WHERE post_date IS NOT NULL
            GROUP BY post_date ORDER BY post_date""")
    feed_by_date = [dict(r) for r in c.fetchall()]

    c.execute("SELECT post_type, COUNT(*) as count FROM posts GROUP BY post_type")
    feed_by_type = [dict(r) for r in c.fetchall()]

    c.execute("""SELECT author_name, COUNT(*) as post_count,
                   SUM(likes) as total_likes, SUM(comments) as total_comments
            FROM posts GROUP BY author_name ORDER BY post_count DESC LIMIT 20""")
    top_authors = [dict(r) for r in c.fetchall()]

    db.close()
    return {
        "generated_at": datetime.now().isoformat(),
        "own_posts": own_posts, "own_stats": own_stats, "own_by_type": own_by_type,
        "feed_posts": feed_posts, "feed_stats": feed_stats,
        "feed_by_date": feed_by_date, "feed_by_type": feed_by_type,
        "top_authors": top_authors, "total_connections": total_connections,
        "baseline_date": baseline_date, "new_connections": new_connections,
        "connection_growth": connection_growth, "collection_runs": collection_runs,
        "profile_runs": profile_runs,
    }

def generate_html(data):
    dj = json.dumps(data, default=str)
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LinkedIn Feed Tracker — Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.1"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0"></script>
<style>
:root {{
    --bg-primary: #f0f2f5; --bg-card: #ffffff; --bg-header: #0a66c2;
    --bg-header-dark: #004182; --text-primary: #191919; --text-secondary: #666666;
    --text-on-dark: #ffffff; --accent: #0a66c2; --accent-light: #e8f0fe;
    --positive: #057642; --negative: #cc1016; --neutral: #666666;
    --border: #e0e0e0; --gap: 16px; --radius: 12px;
}}
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg-primary); color: var(--text-primary); line-height: 1.5; }}
.dashboard {{ max-width: 1400px; margin: 0 auto; padding: var(--gap); }}
.header {{ background: linear-gradient(135deg, var(--bg-header) 0%, var(--bg-header-dark) 100%); color: var(--text-on-dark); padding: 24px 32px; border-radius: var(--radius); margin-bottom: var(--gap); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }}
.header h1 {{ font-size: 22px; font-weight: 700; }}
.header-meta {{ font-size: 13px; opacity: 0.8; }}
.tab-bar {{ display: flex; gap: 4px; margin-bottom: var(--gap); background: var(--bg-card); border-radius: var(--radius); padding: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }}
.tab-btn {{ flex: 1; padding: 12px 24px; border: none; background: transparent; border-radius: 8px; font-size: 14px; font-weight: 600; color: var(--text-secondary); cursor: pointer; transition: all 0.2s; }}
.tab-btn:hover {{ background: var(--accent-light); color: var(--accent); }}
.tab-btn.active {{ background: var(--accent); color: white; }}
.tab-content {{ display: none; }}
.tab-content.active {{ display: block; }}
.kpi-row {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--gap); margin-bottom: var(--gap); }}
.kpi-card {{ background: var(--bg-card); border-radius: var(--radius); padding: 20px 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); border-left: 4px solid var(--accent); }}
.kpi-label {{ font-size: 12px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }}
.kpi-value {{ font-size: 32px; font-weight: 700; color: var(--text-primary); line-height: 1.1; }}
.kpi-sub {{ font-size: 12px; margin-top: 4px; }}
.kpi-sub.positive {{ color: var(--positive); }}
.kpi-sub.negative {{ color: var(--negative); }}
.kpi-sub.neutral {{ color: var(--neutral); }}
.chart-row {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: var(--gap); margin-bottom: var(--gap); }}
.chart-card {{ background: var(--bg-card); border-radius: var(--radius); padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }}
.chart-card h3 {{ font-size: 14px; font-weight: 600; margin-bottom: 16px; }}
.chart-card canvas {{ max-height: 280px; }}
.chart-card.full-width {{ grid-column: 1 / -1; }}
.table-card {{ background: var(--bg-card); border-radius: var(--radius); padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: var(--gap); overflow-x: auto; }}
.table-card h3 {{ font-size: 14px; font-weight: 600; margin-bottom: 16px; }}
table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
thead th {{ text-align: left; padding: 10px 12px; border-bottom: 2px solid var(--border); color: var(--text-secondary); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap; cursor: pointer; user-select: none; }}
thead th:hover {{ color: var(--accent); }}
tbody td {{ padding: 10px 12px; border-bottom: 1px solid #f0f0f0; max-width: 400px; }}
tbody tr:hover {{ background: #f8f9fa; }}
tbody tr:last-child td {{ border-bottom: none; }}
.post-link {{ color: var(--accent); text-decoration: none; font-weight: 500; }}
.post-link:hover {{ text-decoration: underline; }}
.content-preview {{ overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 350px; display: block; }}
.badge {{ display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }}
.badge-text {{ background: #e8f0fe; color: #0a66c2; }}
.badge-image {{ background: #e6f4ea; color: #057642; }}
.badge-video {{ background: #fce8e6; color: #cc1016; }}
.badge-article {{ background: #fef7e0; color: #8a6d00; }}
.badge-poll {{ background: #f3e8fd; color: #7c3aed; }}
.badge-carousel {{ background: #e0f2f1; color: #00695c; }}
.health-row {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: var(--gap); margin-bottom: var(--gap); }}
.health-card {{ background: var(--bg-card); border-radius: var(--radius); padding: 16px 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); display: flex; align-items: center; gap: 12px; }}
.health-dot {{ width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }}
.health-dot.green {{ background: var(--positive); }}
.health-dot.yellow {{ background: #f59e0b; }}
.health-dot.red {{ background: var(--negative); }}
.health-dot.gray {{ background: #ccc; }}
.health-info {{ font-size: 13px; }}
.health-info strong {{ display: block; font-size: 12px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.3px; }}
.footer {{ text-align: center; padding: 16px; font-size: 12px; color: var(--text-secondary); }}
@media (max-width: 768px) {{
    .header {{ flex-direction: column; align-items: flex-start; }}
    .kpi-row {{ grid-template-columns: repeat(2, 1fr); }}
    .chart-row {{ grid-template-columns: 1fr; }}
    .tab-btn {{ padding: 10px 12px; font-size: 13px; }}
}}
</style>
</head>
<body>
<div class="dashboard">
<div class="header"><h1>LinkedIn Feed Tracker</h1><div class="header-meta" id="header-meta"></div></div>
<div class="tab-bar">
    <button class="tab-btn active" onclick="switchTab('network')">Network Activity</button>
    <button class="tab-btn" onclick="switchTab('performance')">Your Post Analytics</button>
    <button class="tab-btn" onclick="switchTab('system')">System Health</button>
</div>
<div class="tab-content active" id="tab-network">
    <div class="kpi-row" id="network-kpis"></div>
    <div class="chart-row">
        <div class="chart-card"><h3>Feed Volume by Date</h3><canvas id="chart-feed-volume"></canvas></div>
        <div class="chart-card"><h3>Post Types in Your Feed</h3><canvas id="chart-feed-types"></canvas></div>
    </div>
    <div class="table-card"><h3>Top Posts in Your Network</h3><div id="table-top-feed-posts"></div></div>
    <div class="table-card"><h3>Most Active Connections</h3><div id="table-top-authors"></div></div>
</div>
<div class="tab-content" id="tab-performance">
    <div class="kpi-row" id="perf-kpis"></div>
    <div class="chart-row">
        <div class="chart-card"><h3>Engagement by Post</h3><canvas id="chart-own-engagement"></canvas></div>
        <div class="chart-card"><h3>Performance by Post Type</h3><canvas id="chart-own-types"></canvas></div>
    </div>
    <div class="chart-row"><div class="chart-card full-width"><h3>Connection Growth</h3><canvas id="chart-connection-growth"></canvas></div></div>
    <div class="table-card"><h3>Your Posts — Ranked by Engagement</h3><div id="table-own-posts"></div></div>
</div>
<div class="tab-content" id="tab-system">
    <div class="health-row" id="health-cards"></div>
    <div class="table-card"><h3>Collection Run History</h3><div id="table-collection-runs"></div></div>
</div>
<div class="footer" id="footer"></div>
</div>
<script>
const D = {dj};
const COLORS = ['#0a66c2','#057642','#dd5143','#f5a623','#7c3aed','#00695c','#8a6d00','#c44e52'];

function switchTab(tab) {{
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');
    event.target.classList.add('active');
}}

function fmt(n) {{ if (n == null) return '0'; if (n >= 1e6) return (n/1e6).toFixed(1)+'M'; if (n >= 1e3) return (n/1e3).toFixed(1)+'K'; return n.toLocaleString(); }}
function pct(n, d) {{ if (!d) return '0%'; return ((n/d)*100).toFixed(1) + '%'; }}
function badgeClass(t) {{ return {{'text':'badge-text','image':'badge-image','video':'badge-video','article':'badge-article','poll':'badge-poll','carousel':'badge-carousel'}}[t] || 'badge-text'; }}
function truncate(s, n) {{ if (!s) return '—'; s = s.replace(/Reaction button state:.*$/i, '').trim(); return s.length > n ? s.substring(0, n) + '...' : s; }}
function makeLink(url, text) {{ if (!url) return text; return `<a href="${{url}}" target="_blank" class="post-link">${{text}}</a>`; }}

function sortTable(tableId, data, columns, defaultSortCol, defaultSortDir) {{
    let sortCol = defaultSortCol || 0, sortDir = defaultSortDir || 'desc';
    function render() {{
        const sorted = [...data].sort((a, b) => {{
            const av = a[columns[sortCol].field] ?? -Infinity, bv = b[columns[sortCol].field] ?? -Infinity;
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return sortDir === 'asc' ? cmp : -cmp;
        }});
        let html = '<table><thead><tr>';
        columns.forEach((col, i) => {{
            const arrow = i === sortCol ? (sortDir === 'asc' ? ' &#9650;' : ' &#9660;') : '';
            html += `<th data-col="${{i}}">${{col.label}}${{arrow}}</th>`;
        }});
        html += '</tr></thead><tbody>';
        if (!sorted.length) html += `<tr><td colspan="${{columns.length}}" style="text-align:center;padding:32px;color:#999;">No data yet</td></tr>`;
        sorted.forEach(row => {{
            html += '<tr>';
            columns.forEach(col => {{ const val = row[col.field]; html += `<td>${{col.render ? col.render(val, row) : (val != null ? val : '—')}}</td>`; }});
            html += '</tr>';
        }});
        html += '</tbody></table>';
        document.getElementById(tableId).innerHTML = html;
        document.querySelectorAll(`#${{tableId}} th`).forEach(th => {{
            th.addEventListener('click', () => {{
                const ci = parseInt(th.dataset.col);
                if (ci === sortCol) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
                else {{ sortCol = ci; sortDir = 'desc'; }}
                render();
            }});
        }});
    }}
    render();
}}

document.getElementById('header-meta').textContent = `Generated ${{new Date(D.generated_at).toLocaleString()}}`;
document.getElementById('footer').textContent = `LinkedIn Feed Tracker — Data as of ${{new Date(D.generated_at).toLocaleString()}}`;

// === TAB 1: NETWORK ACTIVITY ===
(function() {{
    const kpis = [
        {{ label: 'Connections', value: fmt(D.total_connections), sub: `+${{D.new_connections}} new`, subClass: D.new_connections > 0 ? 'positive' : 'neutral' }},
        {{ label: 'Feed Posts Collected', value: fmt(D.feed_stats.total), sub: `${{D.feed_stats.unique_authors}} unique authors`, subClass: 'neutral' }},
        {{ label: 'Avg Likes (Feed)', value: (D.feed_stats.avg_likes || 0).toFixed(1), sub: `Max: ${{D.feed_stats.max_likes || 0}}`, subClass: 'neutral' }},
        {{ label: 'Collection Runs', value: fmt(D.collection_runs.length), sub: `${{D.collection_runs.filter(r => r.status === 'ok').length}} successful`, subClass: 'neutral' }},
    ];
    let html = '';
    kpis.forEach(k => {{ html += `<div class="kpi-card"><div class="kpi-label">${{k.label}}</div><div class="kpi-value">${{k.value}}</div><div class="kpi-sub ${{k.subClass}}">${{k.sub}}</div></div>`; }});
    document.getElementById('network-kpis').innerHTML = html;
}})();

(function() {{
    const dates = D.feed_by_date.map(d => d.post_date), counts = D.feed_by_date.map(d => d.count), likes = D.feed_by_date.map(d => d.total_likes);
    if (dates.length > 0) {{
        new Chart(document.getElementById('chart-feed-volume'), {{
            type: 'bar', data: {{ labels: dates, datasets: [
                {{ label: 'Posts', data: counts, backgroundColor: COLORS[0]+'CC', borderRadius: 4, yAxisID: 'y' }},
                {{ label: 'Total Likes', data: likes, type: 'line', borderColor: COLORS[1], backgroundColor: COLORS[1]+'20', tension: 0.3, yAxisID: 'y1' }}
            ] }},
            options: {{ responsive: true, maintainAspectRatio: false, interaction: {{ mode: 'index', intersect: false }},
                plugins: {{ legend: {{ position: 'top', labels: {{ usePointStyle: true }} }} }},
                scales: {{ y: {{ beginAtZero: true, title: {{ display: true, text: 'Posts' }} }}, y1: {{ beginAtZero: true, position: 'right', title: {{ display: true, text: 'Likes' }}, grid: {{ display: false }} }} }} }}
        }});
    }}
}})();

(function() {{
    const labels = D.feed_by_type.map(d => d.post_type || 'unknown'), data = D.feed_by_type.map(d => d.count);
    if (labels.length > 0) {{
        new Chart(document.getElementById('chart-feed-types'), {{
            type: 'doughnut', data: {{ labels, datasets: [{{ data, backgroundColor: COLORS.slice(0, labels.length).map(c => c+'CC'), borderColor: '#fff', borderWidth: 2 }}] }},
            options: {{ responsive: true, maintainAspectRatio: false, cutout: '55%',
                plugins: {{ legend: {{ position: 'right', labels: {{ usePointStyle: true, padding: 12 }} }},
                    tooltip: {{ callbacks: {{ label: ctx => {{ const total = ctx.dataset.data.reduce((a,b) => a+b, 0); return `${{ctx.label}}: ${{ctx.parsed}} (${{((ctx.parsed/total)*100).toFixed(0)}}%)`; }} }} }} }} }}
        }});
    }}
}})();

sortTable('table-top-feed-posts', D.feed_posts, [
    {{ field: 'author_name', label: 'Author', render: v => `<span class="content-preview">${{truncate(v, 40)}}</span>` }},
    {{ field: 'content_short', label: 'Content', render: v => `<span class="content-preview">${{truncate(v, 80)}}</span>` }},
    {{ field: 'post_type', label: 'Type', render: v => `<span class="badge ${{badgeClass(v)}}">${{v || 'unknown'}}</span>` }},
    {{ field: 'likes', label: 'Likes', render: v => fmt(v) }},
    {{ field: 'comments', label: 'Comments', render: v => fmt(v) }},
    {{ field: 'post_date', label: 'Date' }},
], 3, 'desc');

sortTable('table-top-authors', D.top_authors, [
    {{ field: 'author_name', label: 'Connection', render: v => `<span class="content-preview">${{truncate(v, 50)}}</span>` }},
    {{ field: 'post_count', label: 'Posts', render: v => fmt(v) }},
    {{ field: 'total_likes', label: 'Total Likes', render: v => fmt(v) }},
    {{ field: 'total_comments', label: 'Total Comments', render: v => fmt(v) }},
], 1, 'desc');

// === TAB 2: YOUR POST ANALYTICS ===
(function() {{
    const s = D.own_stats;
    const totalEng = (s.total_likes||0)+(s.total_comments||0)+(s.total_reposts||0);
    const avgEng = s.total > 0 ? (totalEng/s.total).toFixed(1) : '0';
    const clr = s.total > 0 ? ((s.avg_comments||0)/Math.max(s.avg_likes||1,1)) : 0;
    const kpis = [
        {{ label: 'Posts Tracked', value: fmt(s.total), sub: `${{s.baseline_count}} baseline + ${{s.tracked_count}} tracked`, subClass: 'neutral' }},
        {{ label: 'Avg Engagement', value: avgEng, sub: 'per post (likes+comments+reposts)', subClass: 'neutral' }},
        {{ label: 'Total Likes', value: fmt(s.total_likes||0), sub: `Avg ${{(s.avg_likes||0).toFixed(1)}} per post`, subClass: 'neutral' }},
        {{ label: 'Total Comments', value: fmt(s.total_comments||0), sub: `Comment:Like ratio ${{clr.toFixed(2)}}`, subClass: clr > 0.3 ? 'positive' : 'neutral' }},
        {{ label: 'Connections', value: fmt(D.total_connections), sub: `+${{D.new_connections}} since baseline`, subClass: D.new_connections > 0 ? 'positive' : 'neutral' }},
    ];
    let html = '';
    kpis.forEach(k => {{ html += `<div class="kpi-card"><div class="kpi-label">${{k.label}}</div><div class="kpi-value">${{k.value}}</div><div class="kpi-sub ${{k.subClass}}">${{k.sub}}</div></div>`; }});
    document.getElementById('perf-kpis').innerHTML = html;
}})();

(function() {{
    const posts = D.own_posts.slice(0, 20), labels = posts.map((p, i) => `#${{i+1}}`);
    if (posts.length > 0) {{
        new Chart(document.getElementById('chart-own-engagement'), {{
            type: 'bar', data: {{ labels, datasets: [
                {{ label: 'Likes', data: posts.map(p => p.likes), backgroundColor: COLORS[0]+'CC', borderRadius: 4 }},
                {{ label: 'Comments', data: posts.map(p => p.comments), backgroundColor: COLORS[1]+'CC', borderRadius: 4 }},
                {{ label: 'Reposts', data: posts.map(p => p.reposts), backgroundColor: COLORS[3]+'CC', borderRadius: 4 }},
            ] }},
            options: {{ responsive: true, maintainAspectRatio: false,
                plugins: {{ legend: {{ position: 'top', labels: {{ usePointStyle: true }} }},
                    tooltip: {{ callbacks: {{ title: items => truncate(posts[items[0].dataIndex].content_short, 60) }} }} }},
                scales: {{ x: {{ stacked: true, grid: {{ display: false }} }}, y: {{ stacked: true, beginAtZero: true }} }} }}
        }});
    }}
}})();

(function() {{
    const types = D.own_by_type;
    if (types.length > 0) {{
        new Chart(document.getElementById('chart-own-types'), {{
            type: 'bar', data: {{ labels: types.map(t => t.post_type || 'unknown'), datasets: [
                {{ label: 'Avg Likes', data: types.map(t => (t.avg_likes||0).toFixed(1)), backgroundColor: COLORS[0]+'CC', borderRadius: 4 }},
                {{ label: 'Avg Comments', data: types.map(t => (t.avg_comments||0).toFixed(1)), backgroundColor: COLORS[1]+'CC', borderRadius: 4 }},
                {{ label: 'Avg Reposts', data: types.map(t => (t.avg_reposts||0).toFixed(1)), backgroundColor: COLORS[3]+'CC', borderRadius: 4 }},
            ] }},
            options: {{ responsive: true, maintainAspectRatio: false,
                plugins: {{ legend: {{ position: 'top', labels: {{ usePointStyle: true }} }} }},
                scales: {{ x: {{ grid: {{ display: false }} }}, y: {{ beginAtZero: true, title: {{ display: true, text: 'Avg per Post' }} }} }} }}
        }});
    }}
}})();

(function() {{
    const growth = D.connection_growth;
    if (growth.length > 0) {{
        let cum = 0;
        const cd = growth.map(g => {{ cum += g.count; return {{ x: g.day, y: cum }}; }});
        new Chart(document.getElementById('chart-connection-growth'), {{
            type: 'line', data: {{ datasets: [{{ label: 'Total Connections', data: cd, borderColor: COLORS[0], backgroundColor: COLORS[0]+'15', fill: true, tension: 0.3, pointRadius: 4, pointHoverRadius: 7, borderWidth: 2.5 }}] }},
            options: {{ responsive: true, maintainAspectRatio: false,
                plugins: {{ legend: {{ display: false }}, tooltip: {{ callbacks: {{ label: ctx => `${{fmt(ctx.parsed.y)}} connections` }} }} }},
                scales: {{ x: {{ type: 'category', grid: {{ display: false }} }}, y: {{ beginAtZero: false, title: {{ display: true, text: 'Connections' }} }} }} }}
        }});
    }}
}})();

sortTable('table-own-posts', D.own_posts.map(p => ({{
    ...p, total_engagement: (p.likes||0)+(p.comments||0)+(p.reposts||0),
    clean_content: (p.content_short||'').replace(/Reaction button state:.*$/i, '').trim()
}})), [
    {{ field: 'clean_content', label: 'Content', render: (v, row) => {{ const t = truncate(v, 70); return row.post_url ? makeLink(row.post_url, t) : t; }} }},
    {{ field: 'post_type', label: 'Type', render: v => `<span class="badge ${{badgeClass(v)}}">${{v||'?'}}</span>` }},
    {{ field: 'likes', label: 'Likes', render: v => fmt(v) }},
    {{ field: 'comments', label: 'Comments', render: v => fmt(v) }},
    {{ field: 'reposts', label: 'Reposts', render: v => fmt(v) }},
    {{ field: 'total_engagement', label: 'Total', render: v => `<strong>${{fmt(v)}}</strong>` }},
    {{ field: 'posted_at_raw', label: 'Posted', render: v => v || '—' }},
    {{ field: 'is_baseline', label: 'Source', render: v => v ? 'Baseline' : 'Tracked' }},
], 5, 'desc');

// === TAB 3: SYSTEM HEALTH ===
(function() {{
    const lr = D.collection_runs[0], okC = D.collection_runs.filter(r => r.status==='ok').length;
    const now = new Date(), age = lr ? Math.round((now - new Date(lr.ran_at))/(1000*60*60)) : null;
    const cards = [
        {{ label: 'Last Collection', value: lr ? new Date(lr.ran_at).toLocaleString() : 'Never', dot: age!=null ? (age<26?'green':age<50?'yellow':'red') : 'gray' }},
        {{ label: 'Last Status', value: lr ? (lr.status==='ok'?`OK — ${{lr.posts_new}} new posts`:'Error') : 'N/A', dot: lr?(lr.status==='ok'?'green':'red'):'gray' }},
        {{ label: 'Success Rate', value: D.collection_runs.length>0?`${{okC}}/${{D.collection_runs.length}} (${{pct(okC,D.collection_runs.length)}})`:'N/A', dot: !D.collection_runs.length?'gray':(okC/D.collection_runs.length>0.8?'green':'yellow') }},
        {{ label: 'Profile Scraping', value: D.profile_runs>0?`${{D.profile_runs}} runs completed`:'Not yet started', dot: D.profile_runs>0?'green':'yellow' }},
        {{ label: 'Own Posts', value: `${{D.own_stats.total}} tracked (${{D.own_stats.baseline_count}} baseline)`, dot: D.own_stats.total>0?'green':'yellow' }},
        {{ label: 'Connections DB', value: `${{fmt(D.total_connections)}} synced`, dot: D.total_connections>0?'green':'red' }},
    ];
    let html = '';
    cards.forEach(c => {{ html += `<div class="health-card"><div class="health-dot ${{c.dot}}"></div><div class="health-info"><strong>${{c.label}}</strong>${{c.value}}</div></div>`; }});
    document.getElementById('health-cards').innerHTML = html;
}})();

sortTable('table-collection-runs', D.collection_runs, [
    {{ field: 'ran_at', label: 'Time', render: v => new Date(v).toLocaleString() }},
    {{ field: 'status', label: 'Status', render: v => `<span class="badge ${{v==='ok'?'badge-image':'badge-video'}}">${{v}}</span>` }},
    {{ field: 'posts_found', label: 'Found', render: v => fmt(v) }},
    {{ field: 'posts_new', label: 'New', render: v => fmt(v) }},
    {{ field: 'duration_ms', label: 'Duration', render: v => v?(v/1000).toFixed(1)+'s':'—' }},
    {{ field: 'notes', label: 'Notes', render: v => `<span class="content-preview">${{truncate(v, 60)}}</span>` }},
], 0, 'desc');
</script>
</body>
</html>'''

if __name__ == "__main__":
    print("Extracting data from feeds.db...")
    data = extract_data()
    print(f"  Own posts: {len(data['own_posts'])}")
    print(f"  Feed posts: {len(data['feed_posts'])}")
    print(f"  Connections: {data['total_connections']}")
    html = generate_html(data)
    with open(OUTPUT_PATH, 'w') as f:
        f.write(html)
    print(f"Dashboard saved to {OUTPUT_PATH}")
```

## Step 3 — Run the Script

1. Write the Python script above (with the correct DB_PATH and OUTPUT_PATH substituted) to a temporary file.
2. Run it with `python3`.
3. Present the generated HTML file to the user using a `computer://` link.

## Step 4 — Present Results

After generating, tell the user:
- How many own posts, feed posts, and connections are in the dashboard
- That they can open it in any browser
- That re-running `/show-dashboard` anytime regenerates it with fresh data

## Important Notes

- The dashboard has 3 tabs: **Network Activity**, **Your Post Analytics**, and **System Health**
- All tables are sortable by clicking column headers
- Own posts link directly to LinkedIn when a post_url is available
- Connection growth is tracked by comparing `added_at` timestamps in the connections table
- The HTML is fully self-contained — only external dependency is Chart.js from CDN
- If the database has very little data (first few days), the dashboard still renders gracefully with "No data yet" messages

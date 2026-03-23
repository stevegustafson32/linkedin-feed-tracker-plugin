#!/usr/bin/env python3
"""
LinkedIn Feed Tracker — Rich Interactive HTML Dashboard Generator

Reads from SQLite database and outputs a self-contained HTML dashboard with Chart.js.
Database location: /sessions/*/mnt/CoWork Os/LinkedIn Feed Tracker/feeds.db
Output: dashboard.html in the same directory as the DB
"""

import sqlite3
import json
from datetime import datetime
from pathlib import Path
import glob
import sys

def find_database():
    """Glob for feeds.db in any session."""
    pattern = "/sessions/*/mnt/CoWork Os/LinkedIn Feed Tracker/feeds.db"
    matches = glob.glob(pattern)
    if not matches:
        raise FileNotFoundError(f"No database found matching: {pattern}")
    return matches[0]

def get_data(db_path):
    """Extract all necessary data from the database."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    data = {}

    # Config
    cursor.execute("SELECT key, value FROM config;")
    config = {row['key']: row['value'] for row in cursor.fetchall()}
    data['linkedin_user'] = config.get('linkedin_user', 'LinkedIn User')

    # Connections count
    cursor.execute("SELECT COUNT(*) as cnt FROM connections;")
    data['total_connections'] = cursor.fetchone()['cnt']

    # Posts count
    cursor.execute("SELECT COUNT(*) as cnt FROM posts;")
    data['feed_posts'] = cursor.fetchone()['cnt']

    # Own posts count
    cursor.execute("SELECT COUNT(*) as cnt FROM own_posts;")
    data['own_posts'] = cursor.fetchone()['cnt']

    # Collection runs stats
    cursor.execute("""
        SELECT COUNT(*) as total,
               SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as successful
        FROM collection_runs;
    """)
    result = cursor.fetchone()
    data['collection_runs_total'] = result['total']
    data['collection_runs_successful'] = result['successful'] or 0

    # Days tracking
    cursor.execute("SELECT MIN(ran_at) as first_run FROM collection_runs WHERE status = 'ok';")
    first_run = cursor.fetchone()['first_run']
    if first_run:
        first_date = datetime.fromisoformat(first_run.replace('Z', '+00:00'))
        now = datetime.now(first_date.tzinfo) if first_date.tzinfo else datetime.now()
        days_tracking = (now - first_date).days
        data['days_tracking'] = max(0, days_tracking)
    else:
        data['days_tracking'] = 0

    # Your post performance
    cursor.execute("""
        SELECT id, content_short, likes, comments, reposts, post_type
        FROM own_posts
        ORDER BY (likes + comments + reposts) DESC;
    """)
    data['own_posts_list'] = [dict(row) for row in cursor.fetchall()]

    # Network activity over time
    cursor.execute("""
        SELECT ran_at, posts_found
        FROM collection_runs
        WHERE status = 'ok'
        ORDER BY ran_at;
    """)
    data['collection_timeline'] = [dict(row) for row in cursor.fetchall()]

    # Top authors
    cursor.execute("""
        SELECT author_name, COUNT(*) as post_count
        FROM posts
        GROUP BY author_name
        ORDER BY post_count DESC
        LIMIT 10;
    """)
    data['top_authors'] = [dict(row) for row in cursor.fetchall()]

    # Post type distribution (from posts table)
    cursor.execute("""
        SELECT post_type, COUNT(*) as count
        FROM posts
        GROUP BY post_type;
    """)
    data['post_type_distribution'] = [dict(row) for row in cursor.fetchall()]

    # Connection batch distribution
    cursor.execute("""
        SELECT batch_group, COUNT(*) as count
        FROM connections
        GROUP BY batch_group
        ORDER BY batch_group;
    """)
    data['batch_distribution'] = [dict(row) for row in cursor.fetchall()]

    # Top network posts
    cursor.execute("""
        SELECT author_name, content_short, likes, comments, post_type, post_date, post_url
        FROM posts
        ORDER BY (likes + comments) DESC
        LIMIT 10;
    """)
    data['top_posts'] = [dict(row) for row in cursor.fetchall()]

    # Collection run history
    cursor.execute("""
        SELECT ran_at, posts_found, posts_new, duration_ms, status
        FROM collection_runs
        ORDER BY ran_at DESC;
    """)
    data['collection_history'] = [dict(row) for row in cursor.fetchall()]

    # Last updated timestamp
    data['last_updated'] = datetime.now().isoformat()

    conn.close()
    return data

def escape_html(text):
    """Escape HTML special characters."""
    if not text:
        return ""
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;").replace("'", "&#39;")

def truncate(text, length=40):
    """Truncate text to a maximum length."""
    if not text:
        return ""
    text = str(text)
    return text[:length] + "..." if len(text) > length else text

def batch_to_day(batch_num):
    """Convert batch 0-6 to weekday."""
    days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    return days[int(batch_num) % 7]

def generate_top_posts_table(data):
    """Generate top network posts table HTML."""
    if not data['top_posts']:
        return ""

    rows = []
    for post in data['top_posts']:
        content_display = escape_html(truncate(post['content_short'], 40))
        if post.get('post_url'):
            content_display = f'<a href="{escape_html(post["post_url"])}" class="post-link" target="_blank">{content_display}</a>'

        row = f'''                        <tr>
                            <td><strong>{escape_html(post['author_name'])}</strong></td>
                            <td>{content_display}</td>
                            <td>
                                <span class="engagement-metric">👍 {post['likes']}</span>
                                <span class="engagement-metric">💬 {post['comments']}</span>
                            </td>
                            <td><small>{escape_html(post['post_type'])}</small></td>
                            <td><small class="small-text">{escape_html(post['post_date'] or 'Unknown')}</small></td>
                        </tr>'''
        rows.append(row)

    return f'''        <div class="section">
            <h2 class="section-title">Top Network Posts</h2>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Author</th>
                            <th>Content</th>
                            <th>Engagement</th>
                            <th>Type</th>
                            <th>Date</th>
                        </tr>
                    </thead>
                    <tbody>
{chr(10).join(rows)}
                    </tbody>
                </table>
            </div>
        </div>'''

def generate_collection_history_table(data):
    """Generate collection run history table HTML."""
    if not data['collection_history']:
        return ""

    rows = []
    for run in data['collection_history']:
        run_date = datetime.fromisoformat(run['ran_at'].replace('Z', '+00:00')).strftime('%b %d, %Y %I:%M %p')
        status_class = 'status-ok' if run['status'] == 'ok' else 'status-error'

        row = f'''                        <tr>
                            <td>{run_date}</td>
                            <td>{run['posts_found']}</td>
                            <td>{run['posts_new']}</td>
                            <td><small>{run['duration_ms']}ms</small></td>
                            <td><span class="{status_class}">{escape_html(run['status']).upper()}</span></td>
                        </tr>'''
        rows.append(row)

    return f'''        <div class="section">
            <h2 class="section-title">Collection Run History</h2>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Posts Found</th>
                            <th>New Posts</th>
                            <th>Duration</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
{chr(10).join(rows)}
                    </tbody>
                </table>
            </div>
        </div>'''

def generate_own_posts_table(data):
    """Generate your top performing posts table HTML."""
    if not data['own_posts_list']:
        return ""

    rows = []
    for post in data['own_posts_list']:
        engagement = post['likes'] + post['comments'] + post['reposts']
        row = f'''                        <tr>
                            <td>{escape_html(truncate(post['content_short'], 45))}</td>
                            <td>{post['likes']}</td>
                            <td>{post['comments']}</td>
                            <td>{post['reposts']}</td>
                            <td><strong>{engagement}</strong></td>
                            <td><small>{escape_html(post['post_type'])}</small></td>
                        </tr>'''
        rows.append(row)

    return f'''        <div class="section">
            <h2 class="section-title">Your Top Performing Posts</h2>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Content</th>
                            <th>Likes</th>
                            <th>Comments</th>
                            <th>Reposts</th>
                            <th>Total Engagement</th>
                            <th>Type</th>
                        </tr>
                    </thead>
                    <tbody>
{chr(10).join(rows)}
                    </tbody>
                </table>
            </div>
        </div>'''

def generate_html(data):
    """Generate the complete self-contained HTML dashboard."""

    # Prepare chart data
    collection_dates = []
    collection_counts = []
    for item in data['collection_timeline']:
        try:
            date = datetime.fromisoformat(item['ran_at'].replace('Z', '+00:00'))
            collection_dates.append(date.strftime('%b %d'))
            collection_counts.append(item['posts_found'])
        except:
            pass

    # Own posts chart data
    own_posts_labels = []
    own_posts_engagement = []
    own_posts_colors = []
    post_type_colors = {
        'image': '#0A66C2',      # LinkedIn blue
        'article': '#17A2B8',    # Cyan
        'text': '#FFC107',       # Amber
        'job': '#28A745',        # Green
        'milestone': '#6F42C1'   # Purple
    }

    for post in data['own_posts_list'][:10]:  # Top 10
        engagement = post['likes'] + post['comments'] + post['reposts']
        own_posts_labels.append(truncate(post['content_short'], 35))
        own_posts_engagement.append(engagement)
        own_posts_colors.append(post_type_colors.get(post['post_type'], '#0A66C2'))

    # Top authors chart
    author_labels = [a['author_name'] for a in data['top_authors']]
    author_counts = [a['post_count'] for a in data['top_authors']]

    # Post type distribution
    post_type_labels = [p['post_type'] for p in data['post_type_distribution']]
    post_type_counts = [p['count'] for p in data['post_type_distribution']]
    post_type_chart_colors = [post_type_colors.get(pt, '#999999') for pt in post_type_labels]

    # Batch distribution
    batch_labels = [batch_to_day(b['batch_group']) for b in data['batch_distribution']]
    batch_counts = [b['count'] for b in data['batch_distribution']]

    # Last updated
    last_updated = datetime.fromisoformat(data['last_updated']).strftime('%B %d, %Y at %I:%M %p')

    # Build section HTML
    own_posts_chart_section = ''
    if own_posts_labels:
        own_posts_chart_section = '''        <div class="section">
            <h2 class="section-title">Your Post Performance</h2>
            <div class="chart-container">
                <div class="chart-wrapper">
                    <canvas id="ownPostsChart"></canvas>
                </div>
            </div>
        </div>
'''

    collection_chart_section = ''
    if collection_dates:
        collection_chart_section = '''            <div class="section">
                <h2 class="section-title">Collection Activity</h2>
                <div class="chart-container">
                    <div class="chart-wrapper">
                        <canvas id="collectionChart"></canvas>
                    </div>
                </div>
            </div>
'''

    post_type_chart_section = ''
    if post_type_labels:
        post_type_chart_section = '''            <div class="section">
                <h2 class="section-title">Post Type Distribution</h2>
                <div class="chart-container">
                    <div class="chart-wrapper">
                        <canvas id="postTypeChart"></canvas>
                    </div>
                </div>
            </div>
'''

    top_authors_section = ''
    if author_labels:
        top_authors_section = '''        <div class="section">
            <h2 class="section-title">Top Authors in Your Network</h2>
            <div class="chart-container">
                <div class="chart-wrapper">
                    <canvas id="topAuthorsChart"></canvas>
                </div>
            </div>
        </div>
'''

    batch_section = ''
    if batch_labels:
        batch_section = '''        <div class="section">
            <h2 class="section-title">Connection Batch Distribution (7-Day Rotation)</h2>
            <div class="chart-container">
                <div class="chart-wrapper">
                    <canvas id="batchChart"></canvas>
                </div>
            </div>
        </div>
'''

    top_posts_table = generate_top_posts_table(data)
    collection_history_table = generate_collection_history_table(data)
    own_posts_table = generate_own_posts_table(data)

    # Chart initialization scripts
    own_posts_script = ''
    if own_posts_labels:
        own_posts_script = f'''        // Your Post Performance Chart
        const ownPostsCtx = document.getElementById('ownPostsChart');
        if (ownPostsCtx) {{
            new Chart(ownPostsCtx, {{
                type: 'barh',
                data: {{
                    labels: {json.dumps(own_posts_labels)},
                    datasets: [{{
                        label: 'Total Engagement (Likes + Comments + Reposts)',
                        data: {json.dumps(own_posts_engagement)},
                        backgroundColor: {json.dumps(own_posts_colors)},
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1
                    }}]
                }},
                options: {{
                    ...chartOptions,
                    indexAxis: 'y',
                    plugins: {{
                        legend: {{
                            display: true
                        }}
                    }}
                }}
            }});
        }}
'''

    collection_script = ''
    if collection_dates:
        collection_script = f'''        // Collection Activity Chart
        const collectionCtx = document.getElementById('collectionChart');
        if (collectionCtx) {{
            new Chart(collectionCtx, {{
                type: 'bar',
                data: {{
                    labels: {json.dumps(collection_dates)},
                    datasets: [{{
                        label: 'Posts Found',
                        data: {json.dumps(collection_counts)},
                        backgroundColor: chartColors.primary,
                        borderColor: chartColors.primary,
                        borderWidth: 1
                    }}]
                }},
                options: chartOptions
            }});
        }}
'''

    post_type_script = ''
    if post_type_labels:
        post_type_script = f'''        // Post Type Distribution
        const postTypeCtx = document.getElementById('postTypeChart');
        if (postTypeCtx) {{
            new Chart(postTypeCtx, {{
                type: 'doughnut',
                data: {{
                    labels: {json.dumps(post_type_labels)},
                    datasets: [{{
                        data: {json.dumps(post_type_counts)},
                        backgroundColor: {json.dumps(post_type_chart_colors)},
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1
                    }}]
                }},
                options: {{
                    ...chartOptions,
                    plugins: {{
                        legend: {{
                            position: 'bottom'
                        }}
                    }}
                }}
            }});
        }}
'''

    top_authors_script = ''
    if author_labels:
        top_authors_script = f'''        // Top Authors Chart
        const topAuthorsCtx = document.getElementById('topAuthorsChart');
        if (topAuthorsCtx) {{
            new Chart(topAuthorsCtx, {{
                type: 'bar',
                data: {{
                    labels: {json.dumps(author_labels)},
                    datasets: [{{
                        label: 'Posts',
                        data: {json.dumps(author_counts)},
                        backgroundColor: chartColors.secondary,
                        borderColor: chartColors.secondary,
                        borderWidth: 1
                    }}]
                }},
                options: {{
                    ...chartOptions,
                    scales: {{
                        y: {{
                            beginAtZero: true,
                            grid: {{
                                color: gridColor
                            }},
                            ticks: {{
                                color: textColor,
                                stepSize: 1
                            }}
                        }},
                        x: {{
                            grid: {{
                                color: gridColor
                            }},
                            ticks: {{
                                color: textColor
                            }}
                        }}
                    }}
                }}
            }});
        }}
'''

    batch_script = ''
    if batch_labels:
        batch_script = f'''        // Batch Distribution Chart
        const batchCtx = document.getElementById('batchChart');
        if (batchCtx) {{
            new Chart(batchCtx, {{
                type: 'bar',
                data: {{
                    labels: {json.dumps(batch_labels)},
                    datasets: [{{
                        label: 'Connections',
                        data: {json.dumps(batch_counts)},
                        backgroundColor: chartColors.success,
                        borderColor: chartColors.success,
                        borderWidth: 1
                    }}]
                }},
                options: chartOptions
            }});
        }}
'''

    html = f'''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LinkedIn Feed Tracker — Dashboard</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}

        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
            background: linear-gradient(135deg, #0f1419 0%, #1a1f2e 100%);
            color: #e8e8e8;
            padding: 20px;
            min-height: 100vh;
        }}

        .container {{
            max-width: 1400px;
            margin: 0 auto;
        }}

        header {{
            margin-bottom: 40px;
            text-align: center;
        }}

        header h1 {{
            font-size: 2.5rem;
            font-weight: 700;
            color: #ffffff;
            margin-bottom: 8px;
            letter-spacing: -0.5px;
        }}

        header .user-info {{
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
            margin-bottom: 8px;
        }}

        header .user-name {{
            font-size: 1.1rem;
            color: #0A66C2;
            font-weight: 600;
        }}

        header .updated {{
            font-size: 0.9rem;
            color: #888;
        }}

        .stats-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 16px;
            margin-bottom: 40px;
        }}

        .stat-card {{
            background: rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            padding: 24px;
            text-align: center;
            transition: all 0.3s ease;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }}

        .stat-card:hover {{
            background: rgba(255, 255, 255, 0.08);
            border-color: rgba(10, 102, 194, 0.5);
            transform: translateY(-2px);
        }}

        .stat-card .value {{
            font-size: 2.5rem;
            font-weight: 700;
            color: #0A66C2;
            margin-bottom: 8px;
        }}

        .stat-card .label {{
            font-size: 0.9rem;
            color: #aaa;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }}

        .section {{
            margin-bottom: 40px;
        }}

        .section-title {{
            font-size: 1.4rem;
            font-weight: 700;
            color: #ffffff;
            margin-bottom: 20px;
            padding-bottom: 12px;
            border-bottom: 2px solid rgba(10, 102, 194, 0.3);
        }}

        .chart-container {{
            position: relative;
            background: rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            padding: 24px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            margin-bottom: 20px;
        }}

        .chart-wrapper {{
            position: relative;
            height: 350px;
        }}

        .two-column {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(500px, 1fr));
            gap: 20px;
        }}

        .three-column {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
            gap: 20px;
        }}

        .table-container {{
            background: rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            padding: 24px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            overflow-x: auto;
        }}

        table {{
            width: 100%;
            border-collapse: collapse;
        }}

        thead th {{
            background: rgba(10, 102, 194, 0.2);
            color: #0A66C2;
            padding: 16px;
            text-align: left;
            font-weight: 600;
            font-size: 0.9rem;
            border-bottom: 2px solid rgba(10, 102, 194, 0.3);
        }}

        tbody tr {{
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            transition: background 0.2s ease;
        }}

        tbody tr:hover {{
            background: rgba(10, 102, 194, 0.1);
        }}

        tbody td {{
            padding: 16px;
            font-size: 0.95rem;
        }}

        .status-ok {{
            color: #28A745;
            font-weight: 600;
        }}

        .status-error {{
            color: #DC3545;
            font-weight: 600;
        }}

        .post-link {{
            color: #0A66C2;
            text-decoration: none;
            transition: color 0.2s ease;
        }}

        .post-link:hover {{
            color: #0855a0;
            text-decoration: underline;
        }}

        .engagement-metric {{
            display: inline-block;
            background: rgba(10, 102, 194, 0.2);
            color: #0A66C2;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.85rem;
            margin-right: 8px;
            margin-bottom: 4px;
        }}

        .small-text {{
            font-size: 0.85rem;
            color: #888;
        }}

        @media (max-width: 768px) {{
            .stats-grid {{
                grid-template-columns: repeat(2, 1fr);
            }}

            .two-column {{
                grid-template-columns: 1fr;
            }}

            .three-column {{
                grid-template-columns: 1fr;
            }}

            header h1 {{
                font-size: 1.8rem;
            }}

            .user-info {{
                flex-direction: column;
            }}
        }}
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <header>
            <h1>LinkedIn Feed Tracker</h1>
            <div class="user-info">
                <span class="user-name">{escape_html(data['linkedin_user'])}</span>
            </div>
            <div class="updated">Last updated: {last_updated}</div>
        </header>

        <!-- Key Stats -->
        <div class="stats-grid">
            <div class="stat-card">
                <div class="value">{data['total_connections']:,}</div>
                <div class="label">Connections</div>
            </div>
            <div class="stat-card">
                <div class="value">{data['feed_posts']}</div>
                <div class="label">Feed Posts Collected</div>
            </div>
            <div class="stat-card">
                <div class="value">{data['own_posts']}</div>
                <div class="label">Your Posts Tracked</div>
            </div>
            <div class="stat-card">
                <div class="value">{data['collection_runs_successful']}/{data['collection_runs_total']}</div>
                <div class="label">Collection Runs (OK)</div>
            </div>
            <div class="stat-card">
                <div class="value">{data['days_tracking']}</div>
                <div class="label">Days Tracking</div>
            </div>
        </div>

        <!-- Your Post Performance -->
{own_posts_chart_section}
        <!-- Charts Section -->
        <div class="two-column">
{collection_chart_section}
{post_type_chart_section}
        </div>

        <!-- Top Authors -->
{top_authors_section}
        <!-- Connection Batch Distribution -->
{batch_section}
        <!-- Top Network Posts Table -->
{top_posts_table}

        <!-- Collection Run History -->
{collection_history_table}

        <!-- Your Top Posts Table -->
{own_posts_table}
    </div>

    <script>
        // Chart.js color palette
        const chartColors = {{
            primary: '#0A66C2',
            secondary: '#17A2B8',
            success: '#28A745',
            warning: '#FFC107',
            danger: '#DC3545',
            info: '#6F42C1',
            light: 'rgba(255, 255, 255, 0.1)'
        }};

        const gridColor = 'rgba(255, 255, 255, 0.1)';
        const textColor = '#e8e8e8';

        const chartOptions = {{
            responsive: true,
            maintainAspectRatio: false,
            plugins: {{
                legend: {{
                    labels: {{
                        color: textColor,
                        font: {{
                            size: 12
                        }}
                    }}
                }}
            }},
            scales: {{
                x: {{
                    grid: {{
                        color: gridColor
                    }},
                    ticks: {{
                        color: textColor
                    }}
                }},
                y: {{
                    grid: {{
                        color: gridColor
                    }},
                    ticks: {{
                        color: textColor
                    }}
                }}
            }}
        }};

{own_posts_script}
{collection_script}
{post_type_script}
{top_authors_script}
{batch_script}
    </script>
</body>
</html>
'''

    return html

def main():
    try:
        # Find database
        db_path = find_database()
        print(f"Found database: {db_path}")

        # Get data
        print("Extracting data...")
        data = get_data(db_path)

        # Generate HTML
        print("Generating HTML dashboard...")
        html = generate_html(data)

        # Write to file
        db_dir = Path(db_path).parent
        output_path = db_dir / "dashboard.html"

        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(html)

        print(f"\n✓ Dashboard generated successfully!")
        print(f"  Output: {output_path}")
        print(f"  Size: {len(html) / 1024:.1f} KB")
        print(f"\n  Data Summary:")
        print(f"    - Connections: {data['total_connections']:,}")
        print(f"    - Feed Posts: {data['feed_posts']}")
        print(f"    - Your Posts: {data['own_posts']}")
        print(f"    - Collection Runs: {data['collection_runs_successful']}/{data['collection_runs_total']} successful")
        print(f"    - Days Tracking: {data['days_tracking']}")

        return 0

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 1

if __name__ == '__main__':
    sys.exit(main())

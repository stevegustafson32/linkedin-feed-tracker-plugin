/**
 * setup.js — First-run wizard
 * Run: npm run setup
 *
 * Handles:
 *   1. LinkedIn browser login (saves session)
 *   2. Collection schedule preference
 *   3. Chromium install check
 */

const inquirer = require('inquirer');
const { execSync } = require('child_process');
const { setConfig, getConfig } = require('./database');
const { runLoginFlow } = require('./collector');

const chalk = require('chalk');

async function setup() {
  console.log('\n' + chalk.bold.blue('══════════════════════════════════════'));
  console.log(chalk.bold.blue('  LinkedIn Feed Tracker — Setup'));
  console.log(chalk.bold.blue('══════════════════════════════════════\n'));
  console.log('This takes about 3 minutes. You will need to log into LinkedIn once.\n');

  // Step 1: Install Playwright Chromium if needed
  console.log(chalk.dim('Step 1/4 — Checking browser...'));
  try {
    execSync('npx playwright install chromium --with-deps 2>/dev/null', { stdio: 'inherit' });
    console.log(chalk.green('✓  Chromium ready\n'));
  } catch {
    console.log(chalk.yellow('⚠️  Could not auto-install Chromium. Run manually: npx playwright install chromium\n'));
  }

  // Step 2: LinkedIn login
  console.log(chalk.dim('Step 2/4 — LinkedIn login'));
  const alreadySetup = getConfig('linkedin_user');
  if (alreadySetup) {
    const { redo } = await inquirer.prompt([{
      type: 'confirm',
      name: 'redo',
      message: `Already set up as "${alreadySetup}". Re-run login?`,
      default: false,
    }]);
    if (redo) await runLoginFlow();
    else console.log(chalk.green(`✓  Using existing session: ${alreadySetup}\n`));
  } else {
    await runLoginFlow();
  }

  // Step 3: Schedule preferences
  console.log(chalk.dim('Step 3/4 — Schedule preferences'));
  const { collectHour, reportDay } = await inquirer.prompt([
    {
      type: 'list',
      name: 'collectHour',
      message: 'What time should the nightly collection run?',
      choices: [
        { name: '9:00 PM',  value: '0 21 * * *' },
        { name: '10:00 PM', value: '0 22 * * *' },
        { name: '11:00 PM', value: '0 23 * * *' },
        { name: '6:00 AM (next morning)', value: '0 6 * * *' },
      ],
      default: '0 22 * * *',
    },
    {
      type: 'list',
      name: 'reportDay',
      message: 'When should the weekly report be generated?',
      choices: [
        { name: 'Sunday evening (8 PM)',  value: '0 20 * * 0' },
        { name: 'Monday morning (7 AM)',  value: '0 7 * * 1' },
        { name: 'Friday evening (6 PM)',  value: '0 18 * * 5' },
      ],
      default: '0 20 * * 0',
    },
  ]);

  setConfig('collect_time', collectHour);
  setConfig('report_time', reportDay);
  setConfig('max_load_more', '12');
  setConfig('lookback_hours', '26');

  // Step 4: Topic cluster configuration
  console.log(chalk.dim('\nStep 4/4 — Topic clusters'));
  console.log('Topics control how posts are categorized in your weekly report and dashboard.\n');

  const DEFAULT_TOPICS = [
    { name: 'AI & Technology',       keywords: ['ai', 'llm', 'gpt', 'claude', 'artificial intelligence', 'automation', 'machine learning', 'chatgpt', 'openai', 'agent'] },
    { name: 'Leadership & Career',   keywords: ['leadership', 'leader', 'hired', 'promoted', 'career', 'executive', 'ceo', 'management', 'team', 'talent', 'culture'] },
    { name: 'Business & Strategy',   keywords: ['growth', 'revenue', 'funding', 'startup', 'venture', 'market', 'product', 'launch', 'strategy', 'ipo', 'acquisition'] },
    { name: 'Finance & Investment',  keywords: ['invest', 'capital', 'fund', 'private equity', 'valuation', 'portfolio', 'asset', 'credit', 'debt', 'interest rate'] },
    { name: 'Founders & Startups',   keywords: ['founder', 'entrepreneur', 'building', 'bootstrapped', 'early stage', 'launch', 'mvp', 'side project'] },
    { name: 'Operations & Productivity', keywords: ['ops', 'process', 'workflow', 'productivity', 'efficiency', 'systems', 'tools', 'notion'] },
    { name: 'Sales & Revenue',       keywords: ['sales', 'pipeline', 'quota', 'cold outreach', 'crm', 'deals', 'closing', 'prospecting', 'revenue'] },
    { name: 'Work & Culture',        keywords: ['remote', 'hybrid', 'work life', 'burnout', 'mental health', 'diversity', 'inclusion', 'wellbeing'] },
  ];

  console.log('Default topics:');
  DEFAULT_TOPICS.forEach((t, i) => console.log(`  ${i + 1}. ${t.name}`));
  console.log('');

  const { topicAction } = await inquirer.prompt([{
    type: 'list',
    name: 'topicAction',
    message: 'How do you want to set up your topics?',
    choices: [
      { name: 'Use these defaults (recommended for first-time setup)', value: 'defaults' },
      { name: 'Remove some defaults I don\'t need',                    value: 'remove' },
      { name: 'Add my own topics to the defaults',                     value: 'add' },
      { name: 'Start from scratch — I\'ll define all my topics',       value: 'scratch' },
    ],
  }]);

  let topics = [...DEFAULT_TOPICS];

  if (topicAction === 'remove') {
    const { toRemove } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'toRemove',
      message: 'Uncheck topics you want to remove:',
      choices: DEFAULT_TOPICS.map(t => ({ name: t.name, checked: true })),
    }]);
    topics = DEFAULT_TOPICS.filter(t => toRemove.includes(t.name));
  } else if (topicAction === 'add') {
    let adding = true;
    while (adding) {
      const { topicName, topicKeywords, addMore } = await inquirer.prompt([
        { type: 'input', name: 'topicName', message: 'Topic name (e.g., "Healthcare"):' },
        { type: 'input', name: 'topicKeywords', message: 'Keywords (comma-separated):' },
        { type: 'confirm', name: 'addMore', message: 'Add another topic?', default: false },
      ]);
      if (topicName.trim() && topicKeywords.trim()) {
        topics.push({
          name: topicName.trim(),
          keywords: topicKeywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean),
        });
        console.log(chalk.green(`  ✓ Added: ${topicName.trim()}`));
      }
      adding = addMore;
    }
  } else if (topicAction === 'scratch') {
    topics = [];
    let adding = true;
    console.log('\nDefine your topics. You need at least one.\n');
    while (adding) {
      const { topicName, topicKeywords, addMore } = await inquirer.prompt([
        { type: 'input', name: 'topicName', message: 'Topic name:' },
        { type: 'input', name: 'topicKeywords', message: 'Keywords (comma-separated):' },
        { type: 'confirm', name: 'addMore', message: 'Add another topic?', default: true },
      ]);
      if (topicName.trim() && topicKeywords.trim()) {
        topics.push({
          name: topicName.trim(),
          keywords: topicKeywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean),
        });
        console.log(chalk.green(`  ✓ Added: ${topicName.trim()}`));
      }
      adding = addMore;
    }
    if (topics.length === 0) {
      console.log(chalk.yellow('  No topics added — using defaults.'));
      topics = [...DEFAULT_TOPICS];
    }
  }

  setConfig('topic_clusters', JSON.stringify(topics));
  console.log(chalk.green(`\n✓  ${topics.length} topic clusters saved.\n`));
  topics.forEach(t => console.log(`  • ${t.name} (${t.keywords.length} keywords)`));

  console.log('\n' + chalk.bold.green('══════════════════════════════════════'));
  console.log(chalk.bold.green('  Setup complete!'));
  console.log(chalk.bold.green('══════════════════════════════════════\n'));
  console.log('Commands:');
  console.log(chalk.cyan('  npm start') + '         — Start scheduler + dashboard (keep this running)');
  console.log(chalk.cyan('  npm run collect') + '   — Run a manual collection right now');
  console.log(chalk.cyan('  npm run report') + '    — Generate a report from collected data');
  console.log(chalk.cyan('  npm run topics') + '    — View or change your topic clusters');
  console.log(chalk.cyan('  npm run dash') + '      — Open dashboard only (no scheduler)\n');
  console.log(`Dashboard will be at: ${chalk.underline('http://localhost:3742')}\n`);
}

setup().catch(err => {
  console.error('\n❌  Setup failed:', err.message);
  process.exit(1);
});

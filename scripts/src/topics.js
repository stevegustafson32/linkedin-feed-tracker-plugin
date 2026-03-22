/**
 * topics.js — Manage topic clusters after initial setup
 * Run: npm run topics
 *
 * View, add, edit, or remove topic clusters used by the analyzer
 * for weekly report categorization and dashboard trends.
 */

const inquirer = require('inquirer');
const chalk    = require('chalk');
const { getConfig, setConfig } = require('./database');

const DEFAULT_CLUSTERS = [
  { name: 'AI & Technology',       keywords: ['ai', 'llm', 'gpt', 'claude', 'artificial intelligence', 'automation', 'machine learning', 'chatgpt', 'openai', 'agent'] },
  { name: 'Leadership & Career',   keywords: ['leadership', 'leader', 'hired', 'promoted', 'career', 'executive', 'ceo', 'management', 'team', 'talent', 'culture'] },
  { name: 'Business & Strategy',   keywords: ['growth', 'revenue', 'funding', 'startup', 'venture', 'market', 'product', 'launch', 'strategy', 'ipo', 'acquisition'] },
  { name: 'Finance & Investment',  keywords: ['invest', 'capital', 'fund', 'private equity', 'valuation', 'portfolio', 'asset', 'credit', 'debt', 'interest rate'] },
  { name: 'Founders & Startups',   keywords: ['founder', 'entrepreneur', 'building', 'bootstrapped', 'early stage', 'launch', 'mvp', 'side project'] },
  { name: 'Operations & Productivity', keywords: ['ops', 'process', 'workflow', 'productivity', 'efficiency', 'systems', 'tools', 'notion'] },
  { name: 'Sales & Revenue',       keywords: ['sales', 'pipeline', 'quota', 'cold outreach', 'crm', 'deals', 'closing', 'prospecting', 'revenue'] },
  { name: 'Work & Culture',        keywords: ['remote', 'hybrid', 'work life', 'burnout', 'mental health', 'diversity', 'inclusion', 'wellbeing'] },
];

function loadTopics() {
  const stored = getConfig('topic_clusters');
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {}
  }
  return [...DEFAULT_CLUSTERS];
}

function saveTopics(topics) {
  setConfig('topic_clusters', JSON.stringify(topics));
}

function showTopics(topics) {
  console.log(chalk.bold('\nCurrent topic clusters:\n'));
  topics.forEach((t, i) => {
    console.log(`  ${chalk.cyan(i + 1)}. ${chalk.bold(t.name)}`);
    console.log(`     Keywords: ${t.keywords.join(', ')}`);
  });
  console.log('');
}

async function run() {
  console.log('\n' + chalk.bold.blue('══════════════════════════════════════'));
  console.log(chalk.bold.blue('  Topic Cluster Manager'));
  console.log(chalk.bold.blue('══════════════════════════════════════\n'));

  let topics = loadTopics();
  let running = true;

  while (running) {
    showTopics(topics);

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'What do you want to do?',
      choices: [
        { name: 'Add a new topic',           value: 'add' },
        { name: 'Edit a topic\'s keywords',  value: 'edit' },
        { name: 'Remove a topic',            value: 'remove' },
        { name: 'Reset to defaults',         value: 'reset' },
        { name: 'Save and exit',             value: 'save' },
        { name: 'Exit without saving',       value: 'exit' },
      ],
    }]);

    if (action === 'add') {
      const { topicName, topicKeywords } = await inquirer.prompt([
        { type: 'input', name: 'topicName', message: 'Topic name:' },
        { type: 'input', name: 'topicKeywords', message: 'Keywords (comma-separated):' },
      ]);
      if (topicName.trim() && topicKeywords.trim()) {
        topics.push({
          name: topicName.trim(),
          keywords: topicKeywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean),
        });
        console.log(chalk.green(`  ✓ Added: ${topicName.trim()}\n`));
      }
    } else if (action === 'edit') {
      const { topicIdx } = await inquirer.prompt([{
        type: 'list',
        name: 'topicIdx',
        message: 'Which topic to edit?',
        choices: topics.map((t, i) => ({ name: `${i + 1}. ${t.name}`, value: i })),
      }]);
      const topic = topics[topicIdx];
      console.log(`  Current keywords: ${topic.keywords.join(', ')}`);
      const { newKeywords } = await inquirer.prompt([{
        type: 'input',
        name: 'newKeywords',
        message: 'New keywords (comma-separated, or press Enter to keep current):',
      }]);
      if (newKeywords.trim()) {
        topic.keywords = newKeywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
        console.log(chalk.green(`  ✓ Updated keywords for ${topic.name}\n`));
      }
    } else if (action === 'remove') {
      const { topicIdx } = await inquirer.prompt([{
        type: 'list',
        name: 'topicIdx',
        message: 'Which topic to remove?',
        choices: topics.map((t, i) => ({ name: `${i + 1}. ${t.name}`, value: i })),
      }]);
      const removed = topics.splice(topicIdx, 1)[0];
      console.log(chalk.yellow(`  ✗ Removed: ${removed.name}\n`));
    } else if (action === 'reset') {
      topics = [...DEFAULT_CLUSTERS];
      console.log(chalk.green('  ✓ Reset to default topics\n'));
    } else if (action === 'save') {
      saveTopics(topics);
      console.log(chalk.bold.green(`\n✓  ${topics.length} topic clusters saved.`));
      console.log('  Changes will take effect on the next weekly report run.\n');
      running = false;
    } else {
      console.log(chalk.dim('  Exited without saving.\n'));
      running = false;
    }
  }
}

run().catch(err => {
  console.error('\n❌  Error:', err.message);
  process.exit(1);
});

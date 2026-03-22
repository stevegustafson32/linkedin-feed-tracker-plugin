/**
 * health.js — Session health checker (Phase 2)
 *
 * Quickly verifies that the saved LinkedIn session is still valid.
 * Run standalone: npm run health
 * Returns { ok, user, lastRun, message }
 */

const { getBrowser, isLoggedIn } = require('./collector');
const { getConfig, getLastRuns } = require('./database');

async function checkHealth() {
  const user    = getConfig('linkedin_user', null);
  const lastRun = getLastRuns(1)[0] || null;

  if (!user) {
    return {
      ok:      false,
      user:    null,
      lastRun: null,
      message: 'Not set up yet. Run: npm run setup',
    };
  }

  let context;
  try {
    context = await getBrowser(true); // headless
    const page = await context.newPage();
    const loggedIn = await isLoggedIn(page);
    await context.close();

    return {
      ok:      loggedIn,
      user,
      lastRun: lastRun ? lastRun.ran_at : null,
      message: loggedIn
        ? `Session active — logged in as ${user}`
        : 'Session expired. Run: npm run setup to re-login',
    };
  } catch (err) {
    if (context) await context.close().catch(() => {});
    return {
      ok:      false,
      user,
      lastRun: lastRun ? lastRun.ran_at : null,
      message: `Health check failed: ${err.message}`,
    };
  }
}

module.exports = { checkHealth };

// Run standalone: node src/health.js
if (require.main === module) {
  console.log('\n🔍  Checking LinkedIn session health...\n');
  checkHealth().then(r => {
    console.log(r.ok ? `✅  ${r.message}` : `❌  ${r.message}`);
    if (r.lastRun) {
      console.log(`   Last collection: ${new Date(r.lastRun).toLocaleString()}`);
    }
    console.log('');
    process.exit(r.ok ? 0 : 1);
  });
}

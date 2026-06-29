/**
 * Login Helper - Opens browser for ChatGPT login.
 *
 * Run: npm run login -- --user alice
 *   (or just: npm run login  for single-user/default mode)
 *
 * Forces a visible (headful) window so you can log in interactively.
 * The persistent profile is saved to browser-data/<userId>/ and reused
 * by the headless server afterwards.
 */
require('dotenv').config();
// Force headful for interactive login, regardless of .env
process.env.HEADLESS = 'false';
const BrowserManager = require('./browser');

// Parse --user flag from argv
function parseUserArg() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--user');
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  // Also support --user=alice form
  for (const arg of args) {
    if (arg.startsWith('--user=')) return arg.slice(7);
  }
  return 'default';
}

async function main() {
  const userId = parseUserArg();
  console.log(`Opening ChatGPT in browser (headful) for user: ${userId}`);
  console.log('Please log in with your OpenAI account.');
  console.log('Press Ctrl+C when done.\n');

  const browser = new BrowserManager(userId, { headless: false });
  await browser.init();

  const loggedIn = await browser.isLoggedIn();
  if (loggedIn) {
    console.log(`✓ User '${userId}' appears to be logged in already!`);
  } else {
    console.log(`Waiting for login (user: ${userId})...`);
    const success = await browser.waitForLogin(180000);
    if (success) {
      console.log(`✓ Login successful! Session saved for user '${userId}'.`);
    } else {
      console.log('✗ Login timeout. Try again.');
    }
  }

  console.log('\nPress Ctrl+C to close the browser.');

  // Keep running
  await new Promise(() => {});
}

main().catch(console.error);

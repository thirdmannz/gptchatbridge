/**
 * Browser Manager - Persistent Playwright browser for ChatGPT.
 *
 * Each instance manages its own persistent context (browser-data/<userId>/),
 * so multiple users can run side-by-side with their own ChatGPT accounts.
 *
 * Uses Patchright (stealth fork) if available, falls back to standard Playwright.
 */
const log = require('./logger').child('Browser');
const { BROWSER: CFG } = require('./config');
let chromium;
try {
  // Patchright is a drop-in stealth replacement that passes Cloudflare detection
  chromium = require('patchright').chromium;
  log.info('[Browser] Using Patchright (stealth mode)');
} catch {
  chromium = require('playwright').chromium;
  log.info('[Browser] Using standard Playwright (install patchright for stealth mode)');
}
const path = require('path');
const fs = require('fs');

const ROOT_DATA = path.join(__dirname, '..', 'browser-data');
const CHATGPT_URL = 'https://chatgpt.com';

class BrowserManager {
  /**
   * @param {string} userId - unique user identifier (used for data dir)
   * @param {object} [opts] - { headless }
   */
  constructor(userId = 'default', opts = {}) {
    this.userId = userId;
    // Backward compat: 'default' user uses browser-data/ directly (not browser-data/default/)
    // This preserves existing login sessions from before multi-user support.
    // Multi-user mode uses browser-data/<userId>/ subdirectories.
    this.dataDir = userId === 'default' ? ROOT_DATA : path.join(ROOT_DATA, userId);
    this.headless = opts.headless ?? (process.env.HEADLESS !== 'false');
    this.browser = null;
    this.context = null;
    this.page = null;
    // Optional callback invoked after crash recovery to reset stale session state
    this.onResetSession = null;
  }

  async init() {
    if (this.browser) return this.page;

    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    this.browser = await chromium.launchPersistentContext(this.dataDir, {
      headless: this.headless,
      viewport: { width: CFG.VIEWPORT_WIDTH, height: CFG.VIEWPORT_HEIGHT },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=AutomationControlled,Translate',
        '--no-sandbox',
      ],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const pages = this.browser.pages();
    this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

    // Block unnecessary resources to reduce CPU/memory usage.
    // Allow images from OpenAI/DALL-E (generated content), block analytics/tracking.
    await this.page.route('**/*', (route) => {
      const url = route.request().url();
      const type = route.request().resourceType();
      // Block analytics, telemetry, and tracking pixels
      if (url.includes('analytics') || url.includes('telemetry') || url.includes('tracking') || url.includes('sentry') || url.includes('datadog') || url.includes('googletagmanager') || url.includes('doubleclick')) {
        return route.abort();
      }
      // Block font files (ChatGPT works fine with system fonts)
      if (type === 'font') {
        return route.abort();
      }
      // Allow everything else (images, scripts, styles, xhr, fetch, documents)
      route.continue();
    });

    const currentUrl = this.page.url();
    if (!currentUrl.includes('chatgpt.com')) {
      await this.page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page.waitForTimeout(3000);
    }

    log.info(`[Browser:${this.userId}] Started. Current URL: ${this.page.url()}`);
    return this.page;
  }

  async getPage() {
    if (this.page && !this.page.isClosed()) {
      try {
        await this.page.evaluate(() => document.title);
        return this.page;
      } catch (err) {
        log.info(`[Browser:${this.userId}] Health check failed, reinitializing:`, err.message);
        this.page = null;
        this.context = null;
        this.browser = null;
      }
    }

    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
      this.context = null;
      this.page = null;
    }

    const newPage = await this.init();
    if (this.onResetSession) this.onResetSession();
    return newPage;
  }

  async isLoggedIn() {
    const p = await this.getPage();
    const url = p.url();
    if (url.includes('/auth/login') || url.includes('/v1/auth')) {
      return false;
    }
    try {
      const hasNewChat = await p.locator('a[href="/"], nav').first().isVisible({ timeout: 3000 });
      return hasNewChat;
    } catch {
      return url.includes('chatgpt.com') && !url.includes('auth');
    }
  }

  async waitForLogin(timeout = 120000) {
    const p = await this.getPage();
    log.info(`[Browser:${this.userId}] Waiting for login... Please log in to ChatGPT in the browser window.`);

    if (!(await this.isLoggedIn())) {
      await p.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (await this.isLoggedIn()) {
        log.info(`[Browser:${this.userId}] Login successful!`);
        return true;
      }
      await p.waitForTimeout(2000);
    }
    return false;
  }

  async close() {
    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}

module.exports = BrowserManager;

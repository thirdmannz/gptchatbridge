/**
 * Browser Pool - Manages multiple BrowserManager + ChatGPTController instances,
 * one per user. Each user gets their own browser-data/<userId>/ directory and
 * their own ChatGPT session.
 *
 * User identity is established via API key (x-api-key header). The mapping
 * from API key → userId is loaded from users.json. If no users.json exists,
 * falls back to single-user mode with a 'default' user (backward compat).
 *
 * Browser contexts are lazily initialized — only launched when first request
 * for that user arrives. This avoids spawning N browsers at startup.
 */
const fs = require('fs');
const path = require('path');
const log = require('./logger').child('Pool');
const BrowserManager = require('./browser');
const ChatGPTController = require('./chatgpt');
const { POOL: CFG } = require('./config');

const USERS_FILE = path.join(__dirname, '..', 'users.json');
const MAX_CONCURRENT_USERS = CFG.MAX_CONCURRENT_USERS;

class BrowserPool {
  constructor() {
    /** @type {Map<string, {browser: BrowserManager, chatgpt: ChatGPTController}>} */
    this.users = new Map();
    /** @type {Map<string, string>} apiKey → userId */
    this.keyMap = new Map();
    this.singleUserMode = false;
    this._loadConfig();
  }

  _loadConfig() {
    try {
      const raw = fs.readFileSync(USERS_FILE, 'utf8');
      const config = JSON.parse(raw);
      // Format: { "alice": "key_alice_123", "bob": "key_bob_456" }
      for (const [userId, apiKey] of Object.entries(config)) {
        this.keyMap.set(String(apiKey), userId);
      }
      log.info(`[Pool] Loaded ${this.keyMap.size} user(s) from users.json`);
    } catch {
      // No users.json — single-user mode (backward compat)
      this.singleUserMode = true;
      log.info('[Pool] No users.json found — single-user mode (default user)');
    }
  }

  /**
   * Get the list of configured user IDs.
   * In single-user mode, returns ['default'].
   */
  getUserIds() {
    if (this.singleUserMode) return ['default'];
    return [...new Set(this.keyMap.values())];
  }

  /**
   * Resolve an API key to a user ID.
   * In single-user mode, always returns 'default'.
   * @returns {string|null} userId, or null if key is invalid
   */
  resolveApiKey(apiKey) {
    if (this.singleUserMode) return 'default';
    if (!apiKey) return null;
    return this.keyMap.get(apiKey) || null;
  }

  /**
   * Get or create the { browser, chatgpt } pair for a user.
   * Lazily initializes the browser on first access.
   * @param {string} userId
   * @returns {Promise<{browser: BrowserManager, chatgpt: ChatGPTController}>}
   */
  async get(userId = 'default') {
    let entry = this.users.get(userId);
    if (entry) return entry;

    if (this.users.size >= MAX_CONCURRENT_USERS) {
      throw new Error(`Max concurrent users reached (${MAX_CONCURRENT_USERS}). Set MAX_CONCURRENT_USERS to increase.`);
    }

    log.info(`[Pool] Initializing browser for user: ${userId}`);
    const browser = new BrowserManager(userId);
    const chatgpt = new ChatGPTController(browser);
    entry = { browser, chatgpt };
    this.users.set(userId, entry);
    return entry;
  }

  /**
   * Get the ChatGPT controller for a user (convenience method).
   * @param {string} userId
   * @returns {Promise<ChatGPTController>}
   */
  async getController(userId = 'default') {
    const entry = await this.get(userId);
    return entry.chatgpt;
  }

  /**
   * Initialize browsers for all configured users.
   * Called at server startup. Errors are logged but don't stop other users.
   */
  async initAll() {
    const userIds = this.getUserIds();
    for (const userId of userIds) {
      try {
        const entry = await this.get(userId);
        await entry.browser.init();
        const loggedIn = await entry.browser.isLoggedIn();
        if (loggedIn) {
          log.info(`[Pool] User '${userId}' — logged in`);
        } else {
          log.warn(`[Pool] User '${userId}' — NOT logged in. Run: npm run login -- --user ${userId}`);
        }
      } catch (err) {
        log.error(`[Pool] Failed to init browser for '${userId}': ${err.message}`);
      }
    }
  }

  /**
   * Close all browser contexts gracefully.
   */
  async closeAll() {
    const entries = [...this.users.values()];
    this.users.clear();
    await Promise.all(entries.map(e => e.browser.close().catch(() => {})));
    log.info('[Pool] All browsers closed');
  }

  /**
   * Get status for all users (for /api/health or /api/users).
   */
  async getStatus() {
    const result = [];
    for (const [userId, entry] of this.users) {
      try {
        const status = await entry.chatgpt.getStatus();
        result.push({ userId, ...status });
      } catch (err) {
        result.push({ userId, browser: 'error', error: err.message });
      }
    }
    return result;
  }
}

module.exports = BrowserPool;

/**
 * Centralized configuration — all tunable constants in one place.
 * Override via environment variables where noted.
 */

// ── Browser ────────────────────────────────────────────────────────
const BROWSER = {
  NAVIGATION_TIMEOUT: 20000,      // page.goto timeout (ms)
  SELECTOR_TIMEOUT: 8000,         // waitForSelector timeout (ms)
  SETTLE_FALLBACK: 2000,          // fallback wait if selector not found (ms)
  INITIAL_SETTLE: 3000,           // initial page settle after navigation (ms)
  VIEWPORT_WIDTH: 1400,
  VIEWPORT_HEIGHT: 900,
};

// ── ChatGPT DOM ────────────────────────────────────────────────────
const CHATGPT = {
  // Editor selectors — tried in order. Extracted to one place so UI changes
  // only need one edit.
  EDITOR_SELECTORS: ['#prompt-textarea', '.ProseMirror', 'div[contenteditable="true"]', 'textarea#prompt-textarea'],
  EDITOR_SELECTOR_STRING: '#prompt-textarea, .ProseMirror, [contenteditable="true"]',
  TURN_SELECTOR: '[data-testid^="conversation-turn-"]',
  SEND_BUTTON_SELECTORS: 'button[data-testid="send-button"], button[aria-label="Send prompt"]',
  STOP_BUTTON_SELECTORS: 'button[aria-label="Stop streaming"], button[aria-label="Stop generating"], [data-testid="stop-button"]',
  FILE_INPUT_SELECTORS: 'input[type="file"], input[accept]',
  FILE_CHIP_SELECTORS: '[data-testid="file-upload-chip"], [data-testid="attachment-chip"], .file-chip',
  CAPTCHA_SELECTORS: '[title*="captcha" i], [title*="verify" i], .captcha, #captcha, iframe[src*="captcha"], iframe[src*="challenge"]',
  // Max file size for uploads (10MB — matches ChatGPT web limit)
  MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
};

// ── Response Polling ───────────────────────────────────────────────
const POLLING = {
  INTERVAL: 500,                  // poll interval (ms)
  STABLE_ROUNDS: 3,               // consecutive stable rounds to consider done
  TURN_APPEAR_TIMEOUT: 60000,     // wait for first turn to appear (ms)
  RESPONSE_TIMEOUT: 180000,       // overall response timeout (ms)
  STABLE_TURNS_FALLBACK: 5,       // stable turn count rounds (no stop button edge case)
  BRIEF_SETTLE: 200,              // brief settle after turn appears (ms)
};

// ── Agent Loop ─────────────────────────────────────────────────────
const AGENT = {
  MAX_ITERATIONS: 20,             // max tool-call iterations before cap
  CONTEXT_MAX_FILES: 40,          // max files in repo context
  CONTEXT_MAX_FILE_BYTES: 16 * 1024,    // max bytes per file in context
  CONTEXT_MAX_TOTAL_BYTES: 256 * 1024,  // max total context bytes
  TRUNCATE_OUTPUT_BYTES: 32 * 1024,     // truncate tool output in prompt
};

// ── Tools ──────────────────────────────────────────────────────────
const TOOLS = {
  RUN_TIMEOUT_MS: 30000,          // shell command timeout (ms)
  MAX_FILE_READ_BYTES: 512 * 1024, // max file read (512KB)
  MAX_LIST_ENTRIES: 500,          // max dir entries
  EXEC_MAX_BUFFER: 1024 * 1024,   // exec maxBuffer (1MB)
  STDOUT_SLICE: 64 * 1024,        // stdout truncation (64KB)
  STDERR_SLICE: 16 * 1024,        // stderr truncation (16KB)
};

// ── API / Security ─────────────────────────────────────────────────
const API = {
  RATE_LIMIT_WINDOW: 60 * 1000,   // rate limit window (ms)
  RATE_LIMIT_MAX: 60,             // max requests per window per IP
  MAX_SESSION_ID_LEN: 200,        // max session ID length
  SESSION_ID_RE: /^[a-zA-Z0-9_-]+$/,
  BODY_LIMIT: '10mb',             // express.json body limit
};

// ── Server ─────────────────────────────────────────────────────────
const SERVER = {
  PORT: parseInt(process.env.PORT || '3400', 10),
  MEMORY_LOG_INTERVAL: 5 * 60 * 1000,  // memory log interval (ms)
  SHUTDOWN_TIMEOUT: 30000,       // force exit after this (ms)
  WS_HEARTBEAT_INTERVAL: 30000,  // WebSocket ping interval (ms)
};

// ── Pool ───────────────────────────────────────────────────────────
const POOL = {
  MAX_CONCURRENT_USERS: parseInt(process.env.MAX_CONCURRENT_USERS || '5', 10),
};

module.exports = {
  BROWSER,
  CHATGPT,
  POLLING,
  AGENT,
  TOOLS,
  API,
  SERVER,
  POOL,
};

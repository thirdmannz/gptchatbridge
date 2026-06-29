/**
 * ChatGPT DOM Controller - Interact with ChatGPT web version
 * 
 * Updated for current ChatGPT UI (2026):
 * - Input: #prompt-textarea (ProseMirror contenteditable div)
 * - Send: Enter key or send button near composer
 * - Messages: article-based structure in main content
 * - Sidebar: nav[aria-label="Chat history"] with conversation links
 */
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const log = require('./logger').child('ChatGPT');
const { BROWSER, CHATGPT: UI, POLLING } = require('./config');

class ChatGPTController {
  /**
   * @param {import('./browser')} browserManager - BrowserManager instance for this user
   */
  constructor(browserManager) {
    this.browser = browserManager;
    this.events = new EventEmitter();
    this.events.setMaxListeners(50);
    this.currentSessionId = null;
    this.currentModel = null; // e.g. 'gpt-5', 'o3', 'o4-mini'
    this.isBusy = false;
    this.state = { isThinking: false, isStreaming: false };
    // Wire up crash recovery: browser calls onResetSession after reinit
    this.browser.onResetSession = () => this.resetSession();
  }

  /** Reset stale session state after browser crash recovery */
  resetSession() {
    this.currentSessionId = null;
    this.isBusy = false;
    this.state = { isThinking: false, isStreaming: false };
  }

  // ── Model Selection ────────────────────────────────────────────

  static MODEL_ALIASES = {
    'gpt-5': 'gpt-5', 'gpt5': 'gpt-5',
    'gpt-5-thinking': 'gpt-5-thinking', 'gpt5-thinking': 'gpt-5-thinking',
    'gpt-5-pro': 'gpt-5-pro', 'gpt5-pro': 'gpt-5-pro',
    'o3': 'o3',
    'gpt-4-1': 'gpt-4-1', 'gpt4.1': 'gpt-4-1',
    'o4-mini': 'o4-mini', 'o4mini': 'o4-mini',
    'deep-research': 'deep-research',
  };

  setModel(model) {
    const alias = ChatGPTController.MODEL_ALIASES[model?.toLowerCase()?.trim()];
    if (!alias) throw new Error(`Unknown model: ${model}. Available: ${Object.keys(ChatGPTController.MODEL_ALIASES).join(', ')}`);
    this.currentModel = alias;
    return alias;
  }

  getModels() {
    return [...new Set(Object.values(ChatGPTController.MODEL_ALIASES))];
  }

  // Build the chatgpt.com URL with optional model param.
  _chatUrl(sessionId) {
    const base = sessionId
      ? `https://chatgpt.com/c/${sessionId}`
      : 'https://chatgpt.com/';
    return this.currentModel ? `${base}${base.includes('?') ? '&' : '?'}model=${this.currentModel}` : base;
  }

  // ── Session Management ───────────────────────────────────────

  async getSessions() {
    const page = await this.browser.getPage();

    // Wait for the SPA to actually load — the loading screen has no nav/editor.
    // Wait for either the editor or the sidebar to appear (whichever comes first).
    try {
      await page.waitForSelector(UI.EDITOR_SELECTOR_STRING + ', nav, [data-testid="open-sidebar-button"]', { timeout: 15000 });
    } catch {
      log.warn('[ChatGPT] Page did not load SPA within 15s — returning empty sessions');
      return [];
    }

    // Open sidebar if collapsed
    try {
      const sidebarToggle = await page.$('button[data-testid="open-sidebar-button"]');
      if (sidebarToggle) {
        const isVisible = await sidebarToggle.evaluate(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden';
        });
        if (isVisible) {
          await sidebarToggle.click();
          await page.waitForTimeout(1000);
        }
      }
    } catch {}

    // Extract sessions from sidebar — try multiple selector strategies
    const sessions = await page.evaluate(() => {
      const results = [];

      // Strategy 1: nav with aria-label="Chat history" (classic UI)
      // Strategy 2: any link with href starting with /c/ (universal)
      // Strategy 3: list items in sidebar containers (newer UI)
      const links = document.querySelectorAll(
        'nav[aria-label="Chat history"] a, ' +
        'nav a[href^="/c/"], ' +
        'a[href^="/c/"], ' +
        '[data-testid^="history-item"] a, ' +
        'aside a[href^="/c/"]'
      );
      links.forEach(link => {
        const href = link.getAttribute('href') || '';
        if (!href.startsWith('/c/')) return;
        const id = href.replace('/c/', '').split('?')[0];
        if (!id || results.find(s => s.id === id)) return;

        // Get title from various possible elements
        let title = '';
        const titleEl = link.querySelector('div[dir="auto"], span, p, [class*="title"]');
        if (titleEl) title = titleEl.textContent.trim();
        if (!title) title = link.textContent.trim().substring(0, 200);
        if (!title) title = 'Untitled';

        results.push({ id, title, href });
      });
      return results;
    });

    return sessions;
  }

  // ── Message Extraction ───────────────────────────────────────

  async _extractMessages() {
    const page = await this.browser.getPage();
    
    return await page.evaluate(() => {
      const messages = [];

      const stripNoise = (root) => {
        const clone = root.cloneNode(true);
        clone.querySelectorAll(
          '.sr-only, [class*="sr-only"], h4, nav, button, [data-testid*="action"], svg, script, style, form, textarea, input'
        ).forEach(el => el.remove());
        return clone?.textContent?.trim() || '';
      };
      
      // Find all conversation turns
      let turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
      if (turns.length === 0) {
        turns = document.querySelectorAll('[data-message-author-role]');
      }
      if (turns.length === 0) {
        turns = document.querySelectorAll('article');
      }
      
      turns.forEach((turn) => {
        let role = turn.getAttribute('data-turn');
        if (!role) role = turn.getAttribute('data-message-author-role');
        if (!role) {
          const testId = turn.getAttribute('data-testid') || '';
          const turnNum = parseInt(testId.replace('conversation-turn-', '')) || 0;
          role = turnNum % 2 === 1 ? 'user' : 'assistant';
        }

        // Extract text content
        let content = stripNoise(turn);
        if (!content && role === 'assistant') {
          const assistantNodes = turn.querySelectorAll('div.markdown, .markdown, [data-message-author-role="assistant"] .markdown, article .markdown');
          for (const node of assistantNodes) {
            const t = stripNoise(node);
            if (t) { content = t; break; }
          }
        }

        // Extract images
        const images = [];
        turn.querySelectorAll('img[src*="dalle"], img[src*="oai"], img[alt*="Generated"], img[data-testid*="image"]').forEach(img => {
          const src = img.getAttribute('src');
          const alt = img.getAttribute('alt') || '';
          if (src && !src.includes('avatar') && !src.includes('icon')) {
            images.push({ src, alt });
          }
        });

        if (content || images.length > 0) {
          messages.push({ role, content, images });
        }
      });

      return messages;
    });
  }

  // ── Send Message ─────────────────────────────────────────────

  // Simple promise queue — serializes requests instead of rejecting concurrent ones.
  _queue = [];
  _processing = false;

  _enqueue(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      this._processQueue();
    });
  }

  async _processQueue() {
    if (this._processing || this._queue.length === 0) return;
    this._processing = true;
    const { fn, resolve, reject } = this._queue.shift();
    try { resolve(await fn()); } catch (err) { reject(err); }
    finally { this._processing = false; this._processQueue(); }
  }

  async sendMessage(sessionId, prompt) {
    return this._enqueue(() => this._sendMessageInternal(sessionId, prompt));
  }

  async _sendMessageInternal(sessionId, prompt) {
    if (this.isBusy) throw new Error('ChatGPT is busy with another request');
    this.isBusy = true;

    try {
      const page = await this.browser.getPage();

      // Navigate to session or new chat (with optional model param)
      if (sessionId && this.currentSessionId !== sessionId) {
        this.events.emit('status', { status: 'navigating' });
        await page.goto(this._chatUrl(sessionId), { waitUntil: 'domcontentloaded', timeout: BROWSER.NAVIGATION_TIMEOUT });
        // Wait for the editor to appear instead of a fixed 2s delay
        try { await page.waitForSelector(UI.EDITOR_SELECTOR_STRING, { timeout: BROWSER.SELECTOR_TIMEOUT }); } catch { await page.waitForTimeout(2000); }
        this.currentSessionId = sessionId;
      } else if (!sessionId && !page.url().includes('chatgpt.com')) {
        await page.goto(this._chatUrl(null), { waitUntil: 'domcontentloaded', timeout: BROWSER.NAVIGATION_TIMEOUT });
        try { await page.waitForSelector(UI.EDITOR_SELECTOR_STRING, { timeout: BROWSER.SELECTOR_TIMEOUT }); } catch { await page.waitForTimeout(2000); }
      }

      this.events.emit('status', { status: 'typing' });

      // Find the editor — try multiple selectors with diagnostics
      const editorSelectors = UI.EDITOR_SELECTORS;
      let editor = null;
      const tried = [];
      for (const sel of editorSelectors) {
        tried.push(sel);
        editor = await page.$(sel);
        if (editor) break;
      }

      if (!editor) {
        // Diagnostic: dump what IS on the page for debugging
        const diag = await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          hasForm: !!document.querySelector('form'),
          hasTextarea: !!document.querySelector('textarea'),
          contenteditables: document.querySelectorAll('[contenteditable]').length,
          bodyText: document.body?.innerText?.slice(0, 200),
        }));
        throw new Error(`Could not find chat input editor. Tried: ${tried.join(', ')}. Page: ${JSON.stringify(diag)}`);
      }

      // Clear and type the message
      await editor.click();
      await page.waitForTimeout(300);

      // Use clipboard for reliability with ProseMirror
      await page.evaluate((text) => {
        const editor = document.querySelector('#prompt-textarea') || document.querySelector('.ProseMirror');
        if (editor) {
          editor.innerHTML = '';
          editor.focus();
          document.execCommand('insertText', false, text);
        }
      }, prompt);
      
      await page.waitForTimeout(500);

      // Click send button or press Enter
      const sendClicked = await page.evaluate(() => {
        const btn = document.querySelector('button[data-testid="send-button"]')
          || document.querySelector('button[aria-label="Send prompt"]');
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
        return false;
      });

      if (!sendClicked) {
        await page.keyboard.press('Enter');
      }

      this.events.emit('status', { status: 'thinking' });

      // Set up network interception for SSE stream from backend-api/conversation.
      // This gives true token-by-token streaming instead of DOM polling.
      let networkStreamText = '';
      let networkStreamDone = false;
      const responseHandler = async (response) => {
        const url = response.url();
        if (!url.includes('backend-api/conversation') && !url.includes('backend-anon')) return;
        const ct = response.headers()['content-type'] || '';
        if (!ct.includes('text/event-stream')) return;
        try {
          const body = await response.text();
          // Parse SSE: lines starting with "data: " contain JSON, terminated by "[DONE]"
          for (const line of body.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') { networkStreamDone = true; continue; }
            try {
              const evt = JSON.parse(data);
              // ChatGPT SSE uses JSON-patch style: evt.v or evt.p?.[0]?.[1] for text
              // The message field contains the full text in evt.message?.content?.parts
              if (evt.message?.content?.parts) {
                const parts = evt.message.content.parts;
                const text = parts.map(p => (typeof p === 'string' ? p : (p?.text || ''))).join('');
                if (text && text !== networkStreamText) {
                  const prev = networkStreamText;
                  networkStreamText = text;
                  this.events.emit('stream', {
                    delta: text.slice(prev.length),
                    full: text,
                    done: false,
                    phase: 'streaming',
                    sessionId: this.currentSessionId,
                    source: 'network',
                  });
                }
              }
            } catch {}
          }
        } catch {}
      };
      page.on('response', responseHandler);

      await page.waitForTimeout(1000);

      // Wait for response — DOM polling for completion detection + fallback text.
      // If network interception is providing text, pass it to skip redundant DOM scraping.
      const response = await this._waitForResponse(POLLING.RESPONSE_TIMEOUT, () => networkStreamText);

      // Clean up network listener
      page.off('response', responseHandler);

      this.isBusy = false;
      
      return { 
        prompt,
        response: response.content,
        url: page.url(),
        sessionId: this.currentSessionId
      };

    } catch (err) {
      this.isBusy = false;
      this.events.emit('status', { status: 'error', error: err.message });
      throw err;
    }
  }

  async _waitForResponse(timeout = POLLING.RESPONSE_TIMEOUT, getNetworkText = null) {
    const page = await this.browser.getPage();
    const startTime = Date.now();
    const STABLE_ROUNDS = POLLING.STABLE_ROUNDS;
    const POLL_INTERVAL = POLLING.INTERVAL;

    log.info('[ChatGPT] Waiting for response...');

    // Phase 1: Wait for ANY new conversation turn to appear (up to 60s)
    try {
      await page.waitForSelector(UI.TURN_SELECTOR, { timeout: POLLING.TURN_APPEAR_TIMEOUT });
      log.info('[ChatGPT] Conversation turn appeared');
      await page.waitForTimeout(POLLING.BRIEF_SETTLE); // brief settle, was 1000ms
    } catch {
      log.info('[ChatGPT] No conversation turn appeared in 60s');
      this.state.isThinking = false;
      this.state.isStreaming = false;
      emitStatus('done');
      this.events.emit('stream', { delta: '', full: '', done: true, phase: 'done', sessionId: this.currentSessionId });
      return { content: '' };
    }

    // Phase 2: Poll for text stability.
    // Single lightweight evaluate per poll — reads ONLY the last turn's text
    // + streaming state + captcha/login detection. No full _extractMessages() scrape.
    let lastEmittedFull = '';
    let lastText = '';
    let stableRounds = 0;
    let lastTurnCount = 0;
    let stableTurnCountRounds = 0;
    let lastPhase = null;
    let lastStatus = 'thinking'; // tracks emitted status to avoid spamming WS clients

    const emitStream = (full, done = false, phase = 'streaming') => {
      const delta = full.startsWith(lastEmittedFull)
        ? full.slice(lastEmittedFull.length)
        : full;
      this.events.emit('stream', { delta, full, done, phase, sessionId: this.currentSessionId });
      lastEmittedFull = full;
      lastPhase = phase;
    };

    // Emit a status transition only on change — WS forwards `status` events to
    // the dashboard, so this drives the thinking/generating/done indicator.
    // The old `thinking`/`streaming` events were never forwarded and left the
    // dashboard stuck on "Thinking..." for the entire response.
    const emitStatus = (status) => {
      if (lastStatus === status) return;
      lastStatus = status;
      this.events.emit('status', { status });
    };

    while (Date.now() - startTime < timeout) {
      await page.waitForTimeout(POLL_INTERVAL);

      // Check for captcha / login redirect before scraping DOM
      const currentUrl = page.url();
      if (currentUrl.includes('/auth/login') || currentUrl.includes('/v1/auth')) {
        this.isBusy = false;
        this.state.isThinking = false;
        this.state.isStreaming = false;
        const err = new Error('Session expired or not logged in. Run: npm run login');
        this.events.emit('status', { status: 'error', error: err.message });
        emitStream('', true, 'done');
        throw err;
      }

      // One evaluate: last turn text + turn count + streaming flag + captcha check.
      const snap = await page.evaluate(() => {
        // Captcha / challenge detection
        const captchaSel = '[title*="captcha" i], [title*="verify" i], .captcha, #captcha, iframe[src*="captcha"], iframe[src*="challenge"]';
        const hasCaptcha = !!document.querySelector(captchaSel);

        const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
        const turnCount = turns.length;
        let text = '';
        if (turns.length > 0) {
          const lastTurn = turns[turns.length - 1];
          const clone = lastTurn.cloneNode(true);
          clone.querySelectorAll('.sr-only, [class*="sr-only"], h4, nav, button, [data-testid*="action"], svg, script, style').forEach(el => el.remove());
          text = clone?.textContent?.trim() || '';
        }
        const stopBtn = document.querySelector('button[aria-label="Stop streaming"]')
                     || document.querySelector('button[aria-label="Stop generating"]')
                     || document.querySelector('[data-testid="stop-button"]');
        return { turnCount, text, isStreaming: !!stopBtn, hasCaptcha };
      });

      // Captcha detected — abort with clear error
      if (snap.hasCaptcha) {
        this.isBusy = false;
        this.state.isThinking = false;
        this.state.isStreaming = false;
        const err = new Error('Captcha/challenge detected. Complete verification in the browser, then retry.');
        this.events.emit('status', { status: 'error', error: err.message });
        emitStream('', true, 'done');
        throw err;
      }

      const timeElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      // Hybrid: prefer network-intercepted text if available (true token stream),
      // fall back to DOM-scraped text. Always use DOM for completion detection.
      const netText = getNetworkText ? getNetworkText() : '';
      const effectiveText = (netText && netText.length >= snap.text.length) ? netText : (snap.text || '');

      log.info(`[ChatGPT] Poll (${timeElapsed}s): turns=${snap.turnCount} streaming=${snap.isStreaming} textLen=${effectiveText.length} source=${netText && netText.length >= snap.text.length ? 'network' : 'dom'}`);

      if (snap.isStreaming) {
        // Still streaming — reset stability.
        stableRounds = 0;
        stableTurnCountRounds = 0;
        // Always emit a phase event so UI can show "generating" even before text.
        if (effectiveText && effectiveText !== lastEmittedFull) {
          emitStream(effectiveText, false, 'streaming');
        } else if (lastPhase !== 'streaming') {
          emitStream(effectiveText, false, 'streaming');
        }
        lastText = effectiveText;
        lastTurnCount = snap.turnCount;
        this.state.isThinking = false;
        this.state.isStreaming = true;
        emitStatus('streaming');
        continue;
      }

      // Not streaming — push any final text before stability check.
      if (effectiveText && effectiveText !== lastEmittedFull) {
        emitStream(effectiveText, false, 'streaming');
      }

      // Text stability
      if (effectiveText === lastText && effectiveText.length > 0) {
        stableRounds++;
        log.info(`[ChatGPT] Text stable round ${stableRounds}/${STABLE_ROUNDS}`);
      } else {
        stableRounds = 0;
        lastText = effectiveText;
      }

      // Turn count stability
      if (snap.turnCount === lastTurnCount) {
        stableTurnCountRounds++;
      } else {
        stableTurnCountRounds = 0;
        lastTurnCount = snap.turnCount;
      }

      // Done: non-empty assistant text stable for N rounds
      if (stableRounds >= STABLE_ROUNDS && effectiveText.length > 0) {
        log.info(`[ChatGPT] Response stable! Length=${effectiveText.length}`);
        this.state.isThinking = false;
        this.state.isStreaming = false;
        emitStatus('done');
        emitStream(effectiveText, true, 'done');
        return { content: effectiveText };
      }

      // Edge case: no stop button ever found AND text stable for a while
      if (!snap.isStreaming && effectiveText.length > 0 && stableTurnCountRounds >= POLLING.STABLE_TURNS_FALLBACK) {
        log.info(`[ChatGPT] No streaming detected, turns stable. Assuming done.`);
        this.state.isThinking = false;
        this.state.isStreaming = false;
        emitStatus('done');
        emitStream(effectiveText, true, 'done');
        return { content: effectiveText };
      }
    }

    // Timeout — return whatever we have
    log.info('[ChatGPT] Timeout waiting for response');
    this.state.isThinking = false;
    this.state.isStreaming = false;
    emitStatus('done');
    emitStream(lastText || lastEmittedFull, true, 'done');

    return { content: lastText || '' };
  }


  // ── Messages ──────────────────────────────────────────────────

  async getMessages(sessionId) {
    const page = await this.browser.getPage();
    // Navigate to the requested session if not already on it.
    if (sessionId && this.currentSessionId !== sessionId) {
      await page.goto(this._chatUrl(sessionId), { waitUntil: 'domcontentloaded', timeout: BROWSER.NAVIGATION_TIMEOUT });
      try { await page.waitForSelector(UI.EDITOR_SELECTOR_STRING, { timeout: BROWSER.SELECTOR_TIMEOUT }); } catch { await page.waitForTimeout(1500); }
      this.currentSessionId = sessionId;
    }
    const messages = await this._extractMessages();
    return messages;
  }

  // ── Status ──────────────────────────────────────────────────────

  async getStatus() {
    try {
      const page = await this.browser.getPage();
      const url = page.url();

      // Check login: URL doesn't contain /auth/login AND the page has actually
      // loaded past the splash screen (editor or nav present).
      const urlOk = !url.includes('/auth/login');
      let spaLoaded = false;
      if (urlOk) {
        try {
          // Quick check — don't block, just see if the editor/nav exists right now
          spaLoaded = await page.evaluate(() => {
            return !!(document.querySelector('#prompt-textarea, .ProseMirror, nav, [data-testid="open-sidebar-button"]'));
          });
        } catch { spaLoaded = false; }
      }
      const loggedIn = urlOk && spaLoaded;

      return {
        browser: 'connected',
        page: url,
        loggedIn,
        busy: this.isBusy,
        thinking: this.state.isThinking,
        streaming: this.state.isStreaming,
        currentSession: this.currentSessionId
      };
    } catch (err) {
      return {
        browser: 'error',
        error: err.message,
        busy: false,
        thinking: false,
        streaming: false
      };
    }
  }

  // ── Images ──────────────────────────────────────────────────────

  async getImages(sessionId) {
    const messages = await this._extractMessages();
    const images = [];
    messages.forEach(msg => {
      if (msg.images) {
        msg.images.forEach(img => images.push({ ...img, role: msg.role }));
      }
    });
    return images;
  }

  // ── Image Download ────────────────────────────────────────────────

  async downloadImage(url, filename) {
    const page = await this.browser.getPage();
    const downloadsDir = path.join(__dirname, '..', 'downloads');
    await fs.promises.mkdir(downloadsDir, { recursive: true });

    // Sanitize filename: strip path components, replace dangerous chars.
    // Prevents path traversal (e.g. "../../etc/passwd") from writing outside downloads/.
    const safeFilename = filename
      ? path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_')
      : `image_${Date.now()}.png`;
    const filePath = path.join(downloadsDir, safeFilename);
    // Double-check: normalized path must still be inside downloadsDir
    if (!path.normalize(filePath).startsWith(path.normalize(downloadsDir))) {
      throw new Error('Invalid filename — escapes downloads directory');
    }

    // Fetch the image via the browser page (reuses session cookies for oai/dalle URLs)
    const response = await page.goto(url, { waitUntil: 'commit', timeout: BROWSER.NAVIGATION_TIMEOUT + 10000 });
    const buffer = await response.body();
    await fs.promises.writeFile(filePath, buffer);

    // Navigate back to chatgpt so we don't leave the page on the image
    try { await page.goBack({ waitUntil: 'domcontentloaded', timeout: BROWSER.NAVIGATION_TIMEOUT }); } catch {}

    return filePath;
  }

  // ── File Upload ──────────────────────────────────────────────────

  async uploadFile(sessionId, filePath) {
    const page = await this.browser.getPage();

    // Validate file exists and is within size limit before passing to browser
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }
    if (stat.size > UI.MAX_UPLOAD_BYTES) {
      throw new Error(`File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max ${UI.MAX_UPLOAD_BYTES / 1024 / 1024}MB.`);
    }

    // Navigate to session if needed
    if (sessionId && this.currentSessionId !== sessionId) {
      await page.goto(this._chatUrl(sessionId), { waitUntil: 'domcontentloaded', timeout: BROWSER.NAVIGATION_TIMEOUT });
      try { await page.waitForSelector(UI.EDITOR_SELECTOR_STRING, { timeout: BROWSER.SELECTOR_TIMEOUT }); } catch { await page.waitForTimeout(2000); }
      this.currentSessionId = sessionId;
    }

    // Find the hidden file input — ChatGPT always has one in the composer area
    const fileInput = await page.$(UI.FILE_INPUT_SELECTORS.split(',')[0].trim())
      || await page.$(UI.FILE_INPUT_SELECTORS.split(',')[1].trim());
    if (!fileInput) throw new Error('Could not find file input on ChatGPT page');

    await fileInput.setInputFiles(filePath);

    // Wait for upload to complete — the send button becomes enabled or a file chip appears
    await page.waitForTimeout(1000);
    try {
      await page.waitForSelector(UI.FILE_CHIP_SELECTORS, { timeout: 15000 });
    } catch {
      // Some models show upload differently — just wait a bit
      await page.waitForTimeout(2000);
    }

    return { uploaded: true, file: path.basename(filePath) };
  }

  // ── Debug ───────────────────────────────────────────────────────

  async getDebugInfo() {
    const page = await this.browser.getPage();
    const testIds = await page.evaluate(() => {
      const ids = new Set();
      document.querySelectorAll('[data-testid]').forEach(el => {
        ids.add(el.getAttribute('data-testid'));
      });
      return [...ids].sort();
    });

    const ariaLabels = await page.evaluate(() => {
      const labels = new Set();
      document.querySelectorAll('[aria-label]').forEach(el => {
        labels.add(el.getAttribute('aria-label'));
      });
      return [...labels].sort();
    });

    return {
      url: page.url(),
      testIds,
      ariaLabels,
      hasComposer: !!(await page.$('#prompt-textarea') || await page.$('.ProseMirror')),
      hasStopButton: !!(await page.$('button[aria-label="Stop streaming"]') || await page.$('button[aria-label="Stop generating"]')),
      hasSendButton: !!(await page.$('button[data-testid="send-button"]') || await page.$('button[aria-label="Send prompt"]'))
    };
  }

  async getDebugDOM() {
    const page = await this.browser.getPage();
    return await page.evaluate(() => {
      return document.body.innerHTML.substring(0, 5000);
    });
  }

  // ── Create New Chat ──────────────────────────────────────────────

  async createNewChat() {
    const page = await this.browser.getPage();

    // Simply navigate to home -- this starts a new chat
    await page.goto(this._chatUrl(null), { waitUntil: 'domcontentloaded', timeout: BROWSER.NAVIGATION_TIMEOUT });
    try { await page.waitForSelector(UI.EDITOR_SELECTOR_STRING, { timeout: BROWSER.SELECTOR_TIMEOUT }); } catch { await page.waitForTimeout(2000); }

    this.currentSessionId = null;
    return { success: true, url: page.url() };
  }

  close() {
    return this.browser.close();
  }
}

module.exports = ChatGPTController;

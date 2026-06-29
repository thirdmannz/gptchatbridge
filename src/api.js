/**
 * REST API Routes for ChatGPT Bridge
 *
 * Exported as a factory: createApiRouter(pool) → express.Router
 * The pool resolves the user from the x-api-key header and attaches
 * req.chatgpt + req.browserManager for downstream routes.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const agent = require('./agent');
const { API: CFG } = require('./config');

// ── Input validation helpers ───────────────────────────────────────
const SESSION_ID_RE = CFG.SESSION_ID_RE;
const MAX_SESSION_ID_LEN = CFG.MAX_SESSION_ID_LEN;

function isValidSessionId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_SESSION_ID_LEN && SESSION_ID_RE.test(id);
}

function parseIndex(raw) {
  const idx = parseInt(raw, 10);
  if (isNaN(idx) || idx < 0 || !Number.isFinite(idx)) return null;
  return idx;
}

// ── Rate limiting (in-memory, per-IP token bucket) ────────────────
const RATE_LIMIT_WINDOW = CFG.RATE_LIMIT_WINDOW;
const RATE_LIMIT_MAX = CFG.RATE_LIMIT_MAX;
const rateBuckets = new Map();

// Periodic cleanup of stale rate-limit entries (prevents unbounded Map growth)
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets.entries()) {
    if (now - bucket.timestamp > RATE_LIMIT_WINDOW) rateBuckets.delete(ip);
  }
}, RATE_LIMIT_WINDOW).unref();

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.timestamp > RATE_LIMIT_WINDOW) {
    bucket = { timestamp: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ ok: false, error: 'Rate limit exceeded. Max 60 requests/min.' });
  }
  next();
}

/**
 * @param {import('./browser-pool')} pool
 * @returns {express.Router}
 */
function createApiRouter(pool) {
  const router = express.Router();

  // Apply rate limiting to all /api routes
  router.use(rateLimit);

  // ── Auth + user resolution ──────────────────────────────────────
  // Health check is global (no per-user auth). Everything else requires
  // a valid x-api-key header (unless in single-user mode).
  router.use(async (req, res, next) => {
    if (req.path === '/health' || req.path === '/users') return next();

    const apiKey = req.headers['x-api-key'];
    const userId = pool.resolveApiKey(apiKey);
    if (!userId) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid or missing API key. Set x-api-key header.',
        code: 'ERR_AUTH',
      });
    }
    try {
      const entry = await pool.get(userId);
      req.userId = userId;
      req.chatgpt = entry.chatgpt;
      req.browserManager = entry.browser;
      next();
    } catch (err) {
      res.status(503).json({ ok: false, error: err.message });
    }
  });

  // ── Users (list configured users — no auth required) ────────────
  router.get('/users', (req, res) => {
    res.json({ ok: true, users: pool.getUserIds(), singleUserMode: pool.singleUserMode });
  });

  // ── Status ────────────────────────────────────────────────────────
  router.get('/status', async (req, res) => {
    try {
      const status = await req.chatgpt.getStatus();
      res.json({ ok: true, user: req.userId, ...status });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Health check (for load balancers / monitoring) ────────────────
  // Global — reports pool-wide status across all users.
  router.get('/health', async (req, res) => {
    try {
      const users = await pool.getStatus();
      const anyHealthy = users.some(u => u.browser === 'connected' && u.loggedIn);
      res.status(anyHealthy ? 200 : 503).json({
        ok: anyHealthy,
        users,
        singleUserMode: pool.singleUserMode,
      });
    } catch {
      res.status(503).json({ ok: false, error: 'health check failed' });
    }
  });

  // ── Metrics (Prometheus format) ───────────────────────────────────
  // No auth required — same as /health. Returns process + per-user metrics.
  router.get('/metrics', async (req, res) => {
    try {
      const mem = process.memoryUsage();
      const users = await pool.getStatus();
      const healthyUsers = users.filter(u => u.browser === 'connected' && u.loggedIn).length;
      const uptimeSec = process.uptime();

      const lines = [
        '# HELP bridge_uptime_seconds Process uptime in seconds',
        '# TYPE bridge_uptime_seconds counter',
        `bridge_uptime_seconds ${uptimeSec.toFixed(0)}`,
        '',
        '# HELP bridge_process_resident_memory_bytes RSS memory in bytes',
        '# TYPE bridge_process_resident_memory_bytes gauge',
        `bridge_process_resident_memory_bytes ${mem.rss}`,
        '',
        '# HELP bridge_process_heap_used_bytes Heap used in bytes',
        '# TYPE bridge_process_heap_used_bytes gauge',
        `bridge_process_heap_used_bytes ${mem.heapUsed}`,
        '',
        '# HELP bridge_process_heap_total_bytes Heap total in bytes',
        '# TYPE bridge_process_heap_total_bytes gauge',
        `bridge_process_heap_total_bytes ${mem.heapTotal}`,
        '',
        '# HELP bridge_users_total Total configured users',
        '# TYPE bridge_users_total gauge',
        `bridge_users_total ${users.length}`,
        '',
        '# HELP bridge_users_healthy Healthy users (connected + logged in)',
        '# TYPE bridge_users_healthy gauge',
        `bridge_users_healthy ${healthyUsers}`,
        '',
        '# HELP bridge_user_busy Whether user is busy (1=yes, 0=no)',
        '# TYPE bridge_user_busy gauge',
      ];
      for (const u of users) {
        const labels = `{user="${u.userId}"}`;
        lines.push(`bridge_user_busy${labels} ${u.busy ? 1 : 0}`);
      }
      res.set('Content-Type', 'text/plain; version=0.0.4');
      res.send(lines.join('\n') + '\n');
    } catch (err) {
      res.status(500).set('Content-Type', 'text/plain').send('# Error collecting metrics\n');
    }
  });

  // ── Models ─────────────────────────────────────────────────────────
  router.get('/models', (req, res) => {
    res.json({ ok: true, models: req.chatgpt.getModels(), current: req.chatgpt.currentModel });
  });

  router.post('/model', (req, res) => {
    try {
      const { model } = req.body;
      if (!model) return res.status(400).json({ ok: false, error: 'model is required' });
      const alias = req.chatgpt.setModel(model);
      res.json({ ok: true, model: alias });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // ── Sessions ──────────────────────────────────────────────────────
  router.get('/sessions', async (req, res) => {
    try {
      const sessions = await req.chatgpt.getSessions();
      res.json({ ok: true, sessions, count: sessions.length });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/sessions/:id', async (req, res) => {
    if (!isValidSessionId(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'Invalid session ID', code: 'ERR_INVALID_SESSION' });
    }
    try {
      const messages = await req.chatgpt.getMessages(req.params.id);
      res.json({ ok: true, sessionId: req.params.id, messages, count: messages.length });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/sessions/:id/messages', async (req, res) => {
    if (!isValidSessionId(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'Invalid session ID', code: 'ERR_INVALID_SESSION' });
    }
    const { prompt, repoContext, repoPath } = req.body;
    if (!prompt) {
      return res.status(400).json({ ok: false, error: 'prompt is required' });
    }

    // Optionally inject read-only repo context into the prompt
    let effectivePrompt = prompt;
    if (repoContext && repoPath) {
      const root = path.resolve(repoPath);
      try {
        const stat = await fs.promises.stat(root);
        if (!stat.isDirectory()) throw new Error('not a directory');
        const ctx = await agent.buildRepoContext(root, repoContext === true ? {} : repoContext);
        effectivePrompt = `${ctx}\n\n---\n\nUser request:\n${prompt}`;
      } catch (err) {
        return res.status(400).json({ ok: false, error: `repoContext build failed: ${err.message}` });
      }
    }

    // SSE streaming mode: ?stream=1
    if (req.query.stream === '1' || req.query.stream === 'true') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      const sse = (obj) => res.write(`data: ${JSON.stringify(obj).replace(/\n/g,'\\n')}\n\n`);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        req.chatgpt.events.off('stream', streamHandler);
      };

      const streamHandler = (data) => {
        if (data.sessionId === req.params.id || !data.sessionId) {
          sse({ type: 'stream', ...data });
          if (data.done) {
            cleanup();
            res.end();
          }
        }
      };
      req.chatgpt.events.on('stream', streamHandler);

      // Kick off the send; ignore the resolved value (SSE carries the content).
      req.chatgpt.sendMessage(req.params.id, effectivePrompt).catch((err) => {
        cleanup();
        sse({ type: 'error', error: err.message });
        res.end();
      });

      // Clean up if client disconnects early
      req.on('close', cleanup);
      return;
    }

    try {
      const response = await req.chatgpt.sendMessage(req.params.id, effectivePrompt);
      res.json({ ok: true, response });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // SSE: subscribe to stream events for a session (read-only, no send)
  router.get('/sessions/:id/stream', (req, res) => {
    if (!isValidSessionId(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'Invalid session ID', code: 'ERR_INVALID_SESSION' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const sse = (obj) => res.write(`data: ${JSON.stringify(obj).replace(/\n/g,'\\n')}\n\n`);
    sse({ type: 'subscribed', sessionId: req.params.id });

    const streamHandler = (data) => {
      if (data.sessionId === req.params.id || !data.sessionId) {
        sse({ type: 'stream', ...data });
      }
    };
    req.chatgpt.events.on('stream', streamHandler);

    const statusHandler = (data) => sse({ type: 'status', ...data });
    req.chatgpt.events.on('status', statusHandler);

    req.on('close', () => {
      req.chatgpt.events.off('stream', streamHandler);
      req.chatgpt.events.off('status', statusHandler);
    });
  });

  // New chat
  router.post('/sessions/new', async (req, res) => {
    try {
      const result = await req.chatgpt.createNewChat();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Agent Loop ────────────────────────────────────────────────────
  // POST /api/sessions/:id/agent
  // body: { prompt, repoPath, stream? }
  // stream=1 -> SSE with each iteration/tool_call/tool_result/assistant/done
  // otherwise -> JSON with final result
  router.post('/sessions/:id/agent', async (req, res) => {
    if (!isValidSessionId(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'Invalid session ID', code: 'ERR_INVALID_SESSION' });
    }
    const { prompt, repoPath, repoContext } = req.body;
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });
    if (!repoPath) return res.status(400).json({ ok: false, error: 'repoPath is required' });

    const root = path.resolve(repoPath);
    try {
      const stat = await fs.promises.stat(root);
      if (!stat.isDirectory()) throw new Error('not a directory');
    } catch {
      return res.status(400).json({ ok: false, error: `repoPath does not exist or is not a directory: ${root}` });
    }

    // Optionally inject read-only repo context into the prompt
    let effectivePrompt = prompt;
    if (repoContext) {
      try {
        const ctx = await agent.buildRepoContext(root, repoContext === true ? {} : repoContext);
        effectivePrompt = `${ctx}\n\n---\n\nUser request:\n${prompt}`;
      } catch (err) {
        return res.status(400).json({ ok: false, error: `repoContext build failed: ${err.message}` });
      }
    }

    const wantStream = req.query.stream === '1' || req.query.stream === 'true' || req.body.stream === true;

    if (wantStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      const sse = (obj) => res.write(`data: ${JSON.stringify(obj).replace(/\n/g,'\\n')}\n\n`);
      sse({ type: 'start', sessionId: req.params.id, repoPath: root });

      try {
        const result = await agent.runAgentLoop(req.chatgpt, req.params.id, effectivePrompt, root, (evt) => {
          sse({ type: 'agent', ...evt });
        });
        sse({ type: 'done', ok: true, ...result });
      } catch (err) {
        sse({ type: 'error', error: err.message });
      }
      res.end();
    } else {
      try {
        const result = await agent.runAgentLoop(req.chatgpt, req.params.id, effectivePrompt, root);
        res.json({ ok: true, ...result });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    }
  });

  // ── Images ────────────────────────────────────────────────────────
  router.get('/sessions/:id/images', async (req, res) => {
    if (!isValidSessionId(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'Invalid session ID', code: 'ERR_INVALID_SESSION' });
    }
    try {
      const images = await req.chatgpt.getImages(req.params.id);
      res.json({ ok: true, images, count: images.length });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/sessions/:id/images/:index/save', async (req, res) => {
    if (!isValidSessionId(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'Invalid session ID', code: 'ERR_INVALID_SESSION' });
    }
    const idx = parseIndex(req.params.index);
    if (idx === null) {
      return res.status(400).json({ ok: false, error: 'Invalid image index', code: 'ERR_INVALID_INDEX' });
    }
    try {
      const images = await req.chatgpt.getImages(req.params.id);
      if (idx >= images.length) {
        return res.status(404).json({ ok: false, error: 'Image index out of range' });
      }
      const filePath = await req.chatgpt.downloadImage(images[idx].src, req.body.filename);
      res.json({ ok: true, path: filePath });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Direct image save by URL
  router.post('/images/save', async (req, res) => {
    const { url, filename } = req.body;
    if (!url) {
      return res.status(400).json({ ok: false, error: 'url is required' });
    }
    try {
      const filePath = await req.chatgpt.downloadImage(url, filename);
      res.json({ ok: true, path: filePath });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── File Upload ───────────────────────────────────────────────────
  // Upload a local file to the ChatGPT composer (file must be accessible from the bridge process).
  router.post('/sessions/:id/upload', async (req, res) => {
    if (!isValidSessionId(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'Invalid session ID', code: 'ERR_INVALID_SESSION' });
    }
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ ok: false, error: 'filePath is required' });
    try {
      const result = await req.chatgpt.uploadFile(req.params.id, filePath);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Debug routes (gated by ENABLE_DEBUG env var) ──────────────────
  if (process.env.ENABLE_DEBUG === 'true') {
    registerDebugRoutes(router);
  }

  return router;
}

/**
 * Debug routes — only mounted when ENABLE_DEBUG=true.
 * Separated to keep production surface area minimal.
 */
function registerDebugRoutes(router) {

// Debug: inspect actual DOM structure
router.get('/debug', async (req, res) => {
  try {
    const page = await req.browserManager.getPage();
    const url = page.url();
    
    const info = await page.evaluate(() => {
      const r = {};
      
      // Input elements
      const pm = document.querySelector('.ProseMirror');
      r.proseMirror = pm ? { tag: pm.tagName, classes: pm.className, html: pm.outerHTML.substring(0,500) } : null;
      
      const ta = document.querySelector('textarea');
      r.textarea = ta ? { tag: ta.tagName, id: ta.id, placeholder: ta.placeholder, html: ta.outerHTML.substring(0,300) } : null;
      
      const ce = document.querySelector('[contenteditable="true"]');
      r.contentEditable = ce ? { tag: ce.tagName, classes: ce.className, role: ce.getAttribute('role'), html: ce.outerHTML.substring(0,500) } : null;
      
      // Buttons near bottom-right (send button area)
      r.sendCandidates = [];
      document.querySelectorAll('button').forEach(btn => {
        const rect = btn.getBoundingClientRect();
        if (rect.y > window.innerHeight * 0.6 && rect.x > window.innerWidth * 0.6) {
          r.sendCandidates.push({
            testId: btn.getAttribute('data-testid'),
            ariaLabel: btn.getAttribute('aria-label'),
            disabled: btn.disabled,
            html: btn.outerHTML.substring(0,300)
          });
        }
      });
      
      // Main content
      const main = document.querySelector('main');
      r.mainExists = !!main;
      r.mainHTML = main ? main.innerHTML.substring(0,2000) : null;
      
      // All data-testid
      r.testIds = Array.from(document.querySelectorAll('[data-testid]')).map(e => e.getAttribute('data-testid'));
      
      // Sidebar nav links
      r.navLinks = Array.from(document.querySelectorAll('nav a, aside a')).slice(0,15).map(a => ({
        href: a.href, text: a.textContent.trim().substring(0,80), testId: a.getAttribute('data-testid')
      }));
      
      r.title = document.title;
      return r;
    });
    
    res.json({ ok: true, url, ...info });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Debug: Sidebar DOM ────────────────────────────────────────────
router.get('/debug/sidebar', async (req, res) => {
  try {
    const page = await req.browserManager.getPage();
    const info = await page.evaluate(() => {
      // Find nav elements
      const navs = Array.from(document.querySelectorAll('nav'));
      const navInfo = navs.map(n => ({
        ariaLabel: n.getAttribute('aria-label'),
        className: n.className,
        childCount: n.children.length,
        innerHTML: n.innerHTML.substring(0, 2000)
      }));

      // Find all links with /c/ pattern
      const links = Array.from(document.querySelectorAll('a[href*="/c/"]'));
      const linkInfo = links.map(a => ({
        href: a.getAttribute('href'),
        text: a.textContent.trim().substring(0, 100),
        visible: a.offsetParent !== null
      }));

      // Also look for any list items in sidebar
      const sidebarEl = document.querySelector('nav[aria-label="Chat history"]') ||
                        document.querySelector('[id*="sidebar"]') ||
                        document.querySelector('aside');
      
      return {
        url: window.location.href,
        navCount: navs.length,
        navs: navInfo,
        chatLinks: linkInfo,
        sidebarHTML: sidebarEl ? sidebarEl.innerHTML.substring(0, 3000) : 'NO SIDEBAR FOUND',
        bodyClasses: document.body.className,
        allAriaLabels: Array.from(document.querySelectorAll('[aria-label]')).map(e => ({
          tag: e.tagName,
          label: e.getAttribute('aria-label'),
          visible: e.offsetParent !== null
        })).slice(0, 30)
      };
    });
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Debug: Full page HTML snippet ─────────────────────────────────
router.get('/debug/dom', async (req, res) => {
  try {
    const page = await req.browserManager.getPage();
    const html = await page.evaluate(() => {
      // Find the main chat content area
      const main = document.querySelector('main') || document.querySelector('[id="main"]') || document.querySelector('.flex.flex-col');
      const target = main || document.body;
      const html = target.innerHTML.substring(0, 15000);
      // Also get structured message info
      const msgs = [];
      document.querySelectorAll('article, [data-message-author-role], [data-testid*="conversation"]').forEach(el => {
        msgs.push({
          tag: el.tagName,
          role: el.getAttribute('data-message-author-role'),
          testid: el.getAttribute('data-testid'),
          classes: el.className.substring(0, 100),
          text: el.textContent.substring(0, 200)
        });
      });
      return JSON.stringify({ html, msgs });
    });
    const parsed = JSON.parse(html);
    res.json({ ok: true, url: page.url(), html: parsed.html, msgs: parsed.msgs });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── Debug: Assistant turn state ────────────────────────────────
router.get('/debug/assistant', async (req, res) => {
  try {
    const page = await req.browserManager.getPage();
    const info = await page.evaluate(() => {
      const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
      const results = Array.from(turns).map((t, i) => {
        const clone = t.cloneNode(true);
        clone.querySelectorAll('.sr-only, [class*="sr-only"], h4, nav, button, [data-testid*="action"], svg').forEach(el => el.remove());
        return {
          index: i,
          rawText: t.textContent.substring(0, 300),
          cleanedText: clone.textContent.trim().substring(0, 300),
          hasThinking: t.querySelector('[data-testid="thinking-indicator"]') !== null,
          hasStop: t.querySelector('button[aria-label="Stop streaming"]') !== null,
          innerHTML: t.innerHTML.substring(0, 500)
        };
      });
      const stopBtn = document.querySelector('button[aria-label="Stop streaming"]');
      return {
        turnCount: turns.length,
        stopButtonVisible: !!stopBtn,
        turns: results
      };
    });
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Debug: Navigate to session and inspect DOM ────────────────
router.get('/debug/dom/:sessionId', async (req, res) => {
  try {
    const page = await req.browserManager.getPage();
    await page.goto('https://chatgpt.com/c/' + req.params.sessionId, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    
    const result = await page.evaluate(() => {
      // Get all text content from main area
      const main = document.querySelector('main');
      const articles = main ? main.querySelectorAll('article') : [];
      const msgs = [];
      articles.forEach(a => {
        msgs.push({
          tag: 'article',
          text: (a.textContent || '').substring(0, 500),
          html: (a.innerHTML || '').substring(0, 1000)
        });
      });
      
      // Also check for any elements with message-related attributes
      const allEls = main ? main.querySelectorAll('*') : [];
      const interesting = [];
      allEls.forEach(el => {
        const attrs = el.attributes;
        for (let i = 0; i < attrs.length; i++) {
          const name = attrs[i].name;
          if (name.includes('message') || name.includes('role') || name.includes('author') || name.includes('testid') || name.includes('conversation')) {
            interesting.push({
              tag: el.tagName,
              attr: name + '=' + attrs[i].value,
              text: (el.textContent || '').substring(0, 100)
            });
          }
        }
      });
      
      // Get main innerHTML
      const mainHtml = main ? main.innerHTML.substring(0, 10000) : '';
      
      return JSON.stringify({ msgs, interesting: interesting.slice(0, 50), mainHtml });
    });
    
    const parsed = JSON.parse(result);
    res.json({ ok: true, url: page.url(), ...parsed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Debug: Find all buttons ──────────────────────────────────
router.get('/debug/buttons', async (req, res) => {
  try {
    const page = await req.browserManager.getPage();
    const result = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      return buttons.map(b => ({
        ariaLabel: b.getAttribute('aria-label'),
        testid: b.getAttribute('data-testid'),
        type: b.getAttribute('type'),
        disabled: b.disabled,
        className: (b.className || '').substring(0, 80),
        text: (b.textContent || '').trim().substring(0, 50),
        html: b.outerHTML.substring(0, 200)
      }));
    });
    res.json({ ok: true, count: result.length, buttons: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Debug: Find input element ─────────────────────────────────
router.get('/debug/input', async (req, res) => {
  try {
    const page = await req.browserManager.getPage();
    const result = await page.evaluate(() => {
      const checks = {};
      // Check various selectors
      checks['#prompt-textarea'] = !!document.querySelector('#prompt-textarea');
      checks['.ProseMirror'] = !!document.querySelector('.ProseMirror');
      checks['[contenteditable="true"]'] = !!document.querySelector('[contenteditable="true"]');
      checks['textarea'] = !!document.querySelector('textarea');
      checks['[role="textbox"]'] = !!document.querySelector('[role="textbox"]');
      checks['button[data-testid="send-button"]'] = !!document.querySelector('button[data-testid="send-button"]');
      checks['button[aria-label="Send prompt"]'] = !!document.querySelector('button[aria-label="Send prompt"]');
      checks['[data-testid="composer"]'] = !!document.querySelector('[data-testid="composer"]');
      checks['.composer-parent'] = !!document.querySelector('.composer-parent');
      
      // Get all contenteditable elements
      const editables = document.querySelectorAll('[contenteditable="true"]');
      checks['contenteditable_count'] = editables.length;
      checks['contenteditable_tags'] = Array.from(editables).map(e => e.tagName + '.' + e.className.substring(0, 50));
      
      // Get all textareas
      const textareas = document.querySelectorAll('textarea');
      checks['textarea_count'] = textareas.length;
      checks['textarea_ids'] = Array.from(textareas).map(e => e.id || e.name || e.className.substring(0, 30));
      
      return checks;
    });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
}

module.exports = createApiRouter;
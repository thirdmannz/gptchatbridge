/**
 * ChatGPT Bridge Server
 *
 * Bridges ChatGPT web version with Hermes Agent via REST API + WebSocket.
 * Supports multi-user mode (each user has their own browser + ChatGPT account).
 *
 * Single-user mode: no users.json → one 'default' user, no API key needed.
 * Multi-user mode: users.json present → each user needs x-api-key header.
 */
require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { execSync } = require('child_process');

const createApiRouter = require('./src/api');
const { createWsHandler, HEARTBEAT_INTERVAL } = require('./src/ws');
const BrowserPool = require('./src/browser-pool');
const { SERVER: CFG } = require('./src/config');
const log = require('./src/logger').child('Server');

const PORT = CFG.PORT;

// Auto-kill old processes on port before binding (cross-platform)
function killPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr ":${port}" | findstr LISTENING`, { encoding: 'utf8', timeout: 5000 });
      const pids = [...new Set(out.split('\n').map(l => l.trim().split(/\s+/).pop()).filter(Boolean))];
      for (const pid of pids) {
        try { execSync(`taskkill //F //PID ${pid}`, { timeout: 5000 }); } catch {}
      }
      if (pids.length) log.info(`Killed old process(es) on port ${port}: ${pids.join(', ')}`);
    } else {
      try { execSync(`fuser -k ${port}/tcp`, { timeout: 5000, stdio: 'ignore' }); } catch {}
    }
  } catch {}
}

// ── Global error handlers (prevent silent crashes) ──────────────────
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', err);
});

async function main() {
  console.log(`
  ╔══════════════════════════════════════╗
  ║       ChatGPT Bridge Server          ║
  ║    http://localhost:${PORT}              ║
  ╚══════════════════════════════════════╝
  `);

  // Initialize browser pool (loads users.json if present)
  const pool = new BrowserPool();
  const userIds = pool.getUserIds();
  log.info(`Configured users: ${userIds.join(', ')}${pool.singleUserMode ? ' (single-user mode)' : ''}`);

  // Express app
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // CORS — restrict in production via ALLOWED_ORIGINS env var
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin || '*');
    }
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // Request logging middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      log.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    });
    next();
  });

  // Serve dashboard
  app.use(express.static(path.join(__dirname, 'public')));

  // API routes (factory receives pool)
  app.use('/api', createApiRouter(pool));

  // Create HTTP server
  const server = http.createServer(app);

  // WebSocket server — pass pool for per-user routing
  const wss = new WebSocket.Server({ server, path: '/ws' });
  const wsHandler = createWsHandler(pool);
  wss.on('connection', (ws, req) => wsHandler.setup(ws, req));

  // WS keepalive — terminate dead connections
  const heartbeatTimer = setInterval(() => wsHandler.heartbeat(wss), HEARTBEAT_INTERVAL);
  wss.on('close', () => clearInterval(heartbeatTimer));

  // Kill old processes on port before binding
  killPort(PORT);

  // Start server
  server.listen(PORT, () => {
    log.info(`HTTP + WebSocket listening on port ${PORT}`);
    log.info(`Dashboard: http://localhost:${PORT}`);
    log.info(`REST API:  http://localhost:${PORT}/api`);
  });

  // Initialize browsers for all configured users
  log.info('Launching browsers...');
  await pool.initAll();

  // ── Memory monitoring ────────────────────────────────────────────
  const memTimer = setInterval(() => {
    const usage = process.memoryUsage();
    const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
    const heapRatio = usage.heapUsed / usage.heapTotal;
    log.info(`Memory: RSS=${mb(usage.rss)}MB heap=${mb(usage.heapUsed)}/${mb(usage.heapTotal)}MB (${(heapRatio * 100).toFixed(0)}%) external=${mb(usage.external)}MB`);
    if (heapRatio > 0.9) {
      log.warn(`Heap usage >90% — consider restarting or increasing MAX_CONCURRENT_USERS limit`);
    }
  }, CFG.MEMORY_LOG_INTERVAL);
  memTimer.unref();

  // ── Graceful shutdown ────────────────────────────────────────────
  let isShuttingDown = false;
  async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log.info(`${signal} received — starting graceful shutdown`);
    clearInterval(memTimer);

    // 1. Stop accepting new connections
    server.close((err) => {
      if (err) log.error('Error closing HTTP server:', err.message);
    });

    // 2. Close WebSocket connections
    wss.clients.forEach((ws) => {
      try { ws.close(1000, 'Server shutting down'); } catch {}
    });

    // 3. Close all browsers
    try {
      await pool.closeAll();
    } catch (err) {
      log.error('Error closing browsers:', err.message);
    }

    log.info('Shutdown complete');
    process.exit(0);

    // Force exit after 30s if something hangs
    setTimeout(() => {
      log.error('Shutdown timeout — forcing exit');
      process.exit(1);
    }, 30000).unref();
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

main().catch(err => {
  log.error('Fatal error:', err);
  process.exit(1);
});

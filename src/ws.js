/**
 * WebSocket Handler - Real-time status updates per user.
 *
 * The user is resolved from the `x-api-key` query param on the WS URL:
 *   ws://host:port/ws?user=alice&key=<apiKey>
 * In single-user mode, no key is needed.
 *
 * Also implements ping/pong keepalive to detect dead connections.
 */
const log = require('./logger').child('WS');

const HEARTBEAT_INTERVAL = 30000; // 30 seconds

/**
 * @param {import('./browser-pool')} pool
 * @returns {{ setup: function, heartbeat: function }}
 */
function createWsHandler(pool) {
  /**
   * Called for each new WebSocket connection.
   * Expects req.query (parsed by the ws server's URL handling).
   */
  function setup(ws, req) {
    // Resolve user from query param
    const url = new URL(req.url, 'http://localhost');
    const apiKey = url.searchParams.get('key') || '';
    const userId = pool.resolveApiKey(apiKey);

    if (!userId) {
      ws.close(1008, 'Invalid or missing API key');
      return;
    }

    log.info(`[WS] Client connected for user: ${userId}`);

    // Mark connection alive for keepalive
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const send = (obj) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    };

    // Lazily get the chatgpt controller for this user
    let chatgpt = null;
    pool.get(userId).then(entry => { chatgpt = entry.chatgpt; }).catch(err => {
      send({ type: 'error', error: `Failed to init user: ${err.message}` });
    });

    // Forward chatgpt status events to this WebSocket client
    const statusHandler = (data) => send({ type: 'status', ...data });
    const streamHandler = (data) => send({ type: 'stream', ...data });

    // Attach listeners once we have the controller
    const tryAttach = () => {
      if (chatgpt) {
        chatgpt.events.on('status', statusHandler);
        chatgpt.events.on('stream', streamHandler);
      } else {
        setTimeout(tryAttach, 100);
      }
    };
    tryAttach();

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.type) {
          case 'ping':
            send({ type: 'pong' });
            break;

          case 'getStatus':
            if (!chatgpt) return send({ type: 'error', error: 'Not initialized' });
            const status = await chatgpt.getStatus();
            send({ type: 'status', user: userId, ...status });
            break;

          case 'subscribe':
            send({ type: 'subscribed', user: userId });
            break;
        }
      } catch (err) {
        send({ type: 'error', error: err.message });
      }
    });

    ws.on('close', () => {
      log.info(`[WS] Client disconnected for user: ${userId}`);
      if (chatgpt) {
        chatgpt.events.off('status', statusHandler);
        chatgpt.events.off('stream', streamHandler);
      }
    });
  }

  /**
   * Heartbeat — call periodically to terminate dead connections.
   * Should be called via setInterval in server.js.
   */
  function heartbeat(wss) {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        log.info('[WS] Terminating dead connection');
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }

  return { setup, heartbeat };
}

module.exports = { createWsHandler, HEARTBEAT_INTERVAL };

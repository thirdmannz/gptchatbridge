# Todo

## Done (this session)
- [x] Fix network stream `delta` always empty (computed after `networkStreamText` reassignment) — `src/chatgpt.js`
- [x] Fix dashboard stuck on "Thinking..." — poll loop emitted dead `thinking`/`streaming` events that WS never forwarded; replaced with `emitStatus('streaming'|'done')` — `src/chatgpt.js`, `public/app.js`
- [x] Fix Docker base image `node:22-noble` doesn't exist → `node:22-bookworm` — `Dockerfile`
- [x] Fix stale Chromium SingletonLock blocking bridge launch → cleanup in entrypoint scripts — `scripts/start-server.sh`, `scripts/remote-login.sh`
- [x] Fix `getPage()` nulling `this.browser` before `close()` → orphan Chromium processes → "Opening in existing browser session" — `src/browser.js`
- [x] Add `_killOrphanChromium()` fallback in `init()` — kills stale chrome + cleans locks + retries — `src/browser.js`
- [x] Fix dashboard no auto-refresh → added 10s status polling, auto-refresh sessions on login transition, WS reconnect refresh, message load retry — `public/app.js`
- [x] Bilingual README (EN + 中文) + pushed to GitHub

## Current focus — needs fixing before daily use

### Performance
- [ ] **Message loading is slow (2-3s per session)** — `getMessages()` navigates to the session URL and waits for the editor selector, then does a full `_extractMessages()` DOM scrape. Every session switch pays this cost. Consider: cache last-scraped messages per session, or wait for `networkidle` instead of fixed timeouts, or scrape only when the session isn't already loaded.
- [ ] **`getSessions()` is slow (~1-2s)** — opens sidebar, waits 1s, then scrapes all links. Consider caching with TTL or invalidating only on send.

### Response extraction reliability
- [ ] **Long responses may not fully extract** — `_extractMessages()` uses `textContent` on the last turn, which may truncate or miss content in collapsed/expandable sections (code blocks, long outputs). Verify with a long code-generation response.
- [ ] **Extended thinking content not captured** — if ChatGPT shows a "thinking" section before the answer, `stripNoise()` may include or exclude it inconsistently. Need to decide: include thinking text as a separate field, or strip it.
- [ ] **Markdown formatting lost in extraction** — `stripNoise()` returns plain `textContent`, losing all markdown (code blocks, lists, links). The dashboard re-renders with `marked`, but the API returns plain text. Consider extracting innerHTML and converting to markdown, or keeping the DOM structure.

### Dashboard UX
- [ ] **No error recovery UI** — if the browser crashes or session expires mid-conversation, the dashboard shows "Thinking..." forever. The `finally` block hides the indicator, but WS-only observers don't get a clear error state. Need a visible error banner with a "Retry" button.
- [ ] **Session list doesn't update after sending a message** — new chats created via "New Chat" or sessions renamed by ChatGPT don't appear until manual refresh. Should auto-refresh sessions after a send completes.
- [ ] **No scroll-to-bottom on new messages** — when loading a long session, the view starts at the top. Should auto-scroll to the latest message.
- [ ] **Streaming preview doesn't render markdown** — during streaming, `pendingStreamFull` is rendered as markdown via `renderMarkdown()`, but incomplete markdown (unclosed code blocks) renders badly. Need a streaming-safe markdown renderer.
- [ ] **No message copy button** — each message should have a copy-to-clipboard button (was in the original PLAN.md but never implemented).

### API
- [ ] **`POST /api/sessions/:id/messages` not tested end-to-end** — the original todo item. Needs a real ChatGPT session to verify send + response extraction + streaming work together.
- [ ] **No session creation + send in one call** — `POST /api/sessions/new` creates a chat but doesn't send a prompt. `hermes-cli.js ask` works around this but the API doesn't have a combined endpoint. Consider `POST /api/sessions/new` with `{ prompt }` body.
- [ ] **Rate limiting is per-IP only** — in multi-user mode behind a reverse proxy, all users share one IP. Should rate-limit per API key instead.

## Later / nice to have

### Features
- [ ] Image generation download/copy handling — DALL-E images can be extracted but the UI for downloading/copying is minimal.
- [ ] Hermes-friendly command flow for planning in ChatGPT and copying results back.
- [ ] Session search by content (not just title) — would require scraping all sessions, which is expensive.
- [ ] Export session as markdown file.
- [ ] Model picker in the dashboard (currently API-only via `POST /api/model`).
- [ ] File upload from the dashboard (currently API-only via `POST /api/sessions/:id/upload`).

### Infrastructure
- [ ] **Health check endpoint returns 503 during browser startup** — `GET /api/health` returns 503 if the browser hasn't finished launching. Docker `restart: unless-stopped` + no healthcheck means the container stays "up" but unhealthy. Add a Docker `HEALTHCHECK` pointing at `/api/health`.
- [ ] **No log rotation in Docker** — logs go to stdout (fine for `docker logs`), but the app also writes to `./logs/` which grows unbounded. Either remove file logging in Docker or add rotation.
- [ ] **Browser crash recovery not tested** — `getPage()` has a reinit path, but it hasn't been tested with a real crash (e.g. OOM kill of Chromium).
- [ ] **No graceful handling of ChatGPT UI changes** — selectors are centralized in `src/config.js` but there's no alerting when they break. Consider a `/api/debug/diag` endpoint that reports which selectors matched.
- [ ] **PM2 config exists but is untested in production** — `ecosystem.config.js` is present but the Docker setup is the primary deployment path.

### Security
- [ ] **noVNC login has no password** — `remote-login.sh` uses `x11vnc -nopw`. Anyone on the LAN can control the browser during login. Add a VNC password via env var.
- [ ] **CORS default is `*`** — fine for dev, but the compose file hardcodes `ALLOWED_ORIGINS=*`. Should default to empty and require explicit config.
- [ ] **No HTTPS** — the dashboard and API are plain HTTP. For remote access, should document reverse proxy (nginx/caddy) setup or add native TLS.

## Notes
- Repo: https://github.com/thirdmannz/gptchatbridge
- Dashboard: `http://localhost:3400`
- API: `http://localhost:3400/api`
- Docker: `docker compose up -d` (bridge), `docker compose --profile login up login` (auth)
- Local dev: `npm start` (or `npm run start:xvfb` on headless)
- Tests: `npm test` (42 tests, all passing)
- Browser data: `./browser-data/` (gitignored, persisted via Docker volume)

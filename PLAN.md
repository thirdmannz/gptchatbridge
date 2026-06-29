# ChatGPT Bridge

## TL;DR
- ChatGPT web has no API — we need a bridge to control it programmatically
- Playwright + Express server + Dashboard UI that wraps ChatGPT with REST API
- Hermes can send prompts, read responses, extract images — all via HTTP

## Context
- User wants to use ChatGPT free web version (extended thinking) for planning
- Then feed results back into Hermes/Discord workflows
- Needs easy copy/paste, image download, session selection
- Windows host, git-bash shell, Node.js available

## Architecture

```
Browser (Playwright) ←→ ChatGPT DOM Controller ←→ Express REST API ←→ Hermes Agent
                              ↕                        ↕
                         Dashboard UI              WebSocket
```

## Milestones

### M1: Project Setup — 10min
- [ ] package.json with deps (playwright, express, ws, marked)
- [ ] .env config (PORT, etc.)
- [ ] Basic server.js entry point
  - _Run:_ `node server.js` starts on port 3400

### M2: Browser Manager — 15min
- [ ] Playwright persistent browser launch (`src/browser.js`)
- [ ] Auto-navigate to chatgpt.com
- [ ] Login detection (check if logged in or redirect to auth)
- [ ] Reusable page pool
  - _Run:_ `node -e "require('./src/browser').init()"` opens browser

### M3: ChatGPT DOM Controller — 20min
- [ ] Session list extraction from sidebar (`src/chatgpt.js`)
- [ ] Message content extraction (markdown + images)
- [ ] Send prompt to active session
- [ ] Wait for response completion (detect streaming end)
- [ ] Image URL extraction from DALL-E responses
- [ ] Extended thinking detection and wait
  - _Run:_ API returns session list and message content

### M4: REST API — 15min
- [ ] `GET /api/status` — bridge health
- [ ] `GET /api/sessions` — list all sessions
- [ ] `GET /api/sessions/:id` — get messages
- [ ] `POST /api/sessions/:id/messages` — send prompt, get response
- [ ] `GET /api/sessions/:id/images` — extract all image URLs
- [ ] `POST /api/sessions/:id/images/:index/save` — save to local disk
  - _Run:_ `curl http://localhost:3400/api/sessions`

### M5: Dashboard UI — 20min
- [ ] Session list sidebar with search
- [ ] Message viewer with markdown rendering
- [ ] One-click copy buttons per message
- [ ] Image gallery with preview + download
- [ ] Prompt input with send button
- [ ] Real-time status (thinking/streaming indicators)
  - _Run:_ Open http://localhost:3400 in browser

### M6: WebSocket Live Updates — 10min
- [ ] Streaming message updates
- [ ] Thinking/generating status
- [ ] New message notifications
  - _Run:_ Send prompt, see live updates in UI

## Final Verification
- [ ] `node server.js` starts, browser opens ChatGPT
- [ ] Dashboard shows sessions, can select and read
- [ ] Can send prompt and receive response via API
- [ ] Images can be downloaded via API and UI
- [ ] Hermes can call `POST /api/sessions/:id/messages` end-to-end

## Commit Plan
1. `feat: project setup with deps and config`
2. `feat: browser manager with persistent profile`
3. `feat: ChatGPT DOM controller`
4. `feat: REST API endpoints`
5. `feat: dashboard UI`
6. `feat: WebSocket live updates`

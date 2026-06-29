# ChatGPT Bridge

[English](#english) | [中文](#中文)

---

<a id="english"></a>

# English

Bridge between ChatGPT web (free tier) and any HTTP client. Wraps the ChatGPT web UI with a REST API + real-time dashboard, so you can programmatically control ChatGPT, stream responses, let ChatGPT read/write your repo, and download images — all without an OpenAI API key.

## Table of Contents

- [What It Does](#what-it-does)
- [How It Works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Setup — Docker (Recommended)](#setup--docker-recommended)
- [Setup — Local (No Docker)](#setup--local-no-docker)
- [Usage](#usage)
- [REST API Reference](#rest-api-reference)
- [CLI Helper](#cli-helper)
- [Agent Mode](#agent-mode)
- [Multi-User Mode](#multi-user-mode)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)

## What It Does

- **Controls ChatGPT web via API** — send prompts, read responses, list sessions, extract images, all over HTTP
- **Real-time streaming** — see ChatGPT's response appear token-by-token via WebSocket or SSE
- **Agent mode** — let ChatGPT read files, write files, and run shell commands in your repo
- **Dashboard** — a ChatGPT-style dark UI for browsing sessions, sending prompts, and viewing images
- **Remote login** — authenticate to ChatGPT from your browser via noVNC, even when the server is remote
- **Multi-user** — each user gets their own browser profile and ChatGPT account
- **Free tier** — uses ChatGPT's free web version with extended thinking (o3, o4-mini, gpt-5, etc.)
- **Stealth** — uses Patchright (stealth Playwright fork) to pass Cloudflare bot detection

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                        Your Machine                          │
│                                                              │
│  ┌─────────────┐    ┌──────────────┐    ┌────────────────┐  │
│  │  Dashboard   │    │  Hermes CLI  │    │  curl / script │  │
│  │  (browser)   │    │  (terminal)  │    │  (any client)  │  │
│  └──────┬───────┘    └──────┬───────┘    └───────┬────────┘  │
│         │ WebSocket          │ HTTP              │ HTTP      │
│         └──────────┬─────────┴───────────────────┘           │
│                    │                                         │
│         ┌──────────▼──────────┐                              │
│         │   Express Server     │  ← server.js (port 3400)    │
│         │   • REST API         │     src/api.js               │
│         │   • WebSocket        │     src/ws.js                │
│         │   • Static dashboard │     public/                  │
│         └──────────┬──────────┘                              │
│                    │                                         │
│         ┌──────────▼──────────┐                              │
│         │  ChatGPT Controller  │  ← src/chatgpt.js            │
│         │  • Send messages     │     DOM scraping + polling   │
│         │  • Extract responses │     Network SSE interception │
│         │  • List sessions     │                              │
│         │  • Download images   │                              │
│         └──────────┬──────────┘                              │
│                    │                                         │
│         ┌──────────▼──────────┐                              │
│         │  Browser Manager     │  ← src/browser.js            │
│         │  (Patchright/        │     Persistent profile in    │
│         │   Playwright)        │     browser-data/            │
│         └──────────┬──────────┘                              │
│                    │                                         │
│         ┌──────────▼──────────┐                              │
│         │  Chromium Browser    │  ← Headless (Xvfb in Docker) │
│         │  → chatgpt.com       │                              │
│         └─────────────────────┘                              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Flow explained

1. **Login (one-time):** A headful Chromium browser opens ChatGPT. You log in with your account. The session (cookies, localStorage) is saved to `browser-data/` — a persistent browser profile.

2. **Server starts:** The Express server launches a headless Chromium with the saved profile. It navigates to `chatgpt.com` and confirms it's logged in.

3. **You send a prompt:** `POST /api/sessions/:id/messages` → the controller navigates to that chat session, types your prompt into the ProseMirror editor, and clicks send.

4. **Response detection:** The controller polls the DOM every 500ms, reading only the last conversation turn's text. It also intercepts the SSE network stream from `backend-api/conversation` for true token-by-token streaming. Completion is detected when the text stabilizes for 3 consecutive polls and the "Stop generating" button disappears.

5. **Streaming:** Status transitions (`thinking` → `streaming` → `done`) and text deltas are emitted as events. WebSocket forwards them to the dashboard; SSE forwards them to HTTP clients.

6. **Agent mode:** The bridge injects a system prefix teaching ChatGPT a tool-call protocol (fenced `tool` blocks with JSON). After each reply, it scans for tool calls, executes them locally (read/write files, run commands), and feeds results back as the next prompt. Loops up to 20 iterations.

### Two Docker services

The project uses **one image, two services**:

| Service | Purpose | Port | When |
|---------|---------|------|------|
| `bridge` | Long-running API server + dashboard + Playwright | 3400 | Always on (`docker compose up -d`) |
| `login` | One-shot noVNC web client for interactive ChatGPT login | 6080 | Only when (re)authenticating (`docker compose --profile login up login`) |

They share the `./browser-data` volume. The login container writes the authenticated session; the bridge container reads it.

## Prerequisites

### Docker setup (recommended)
- **Docker** + **Docker Compose** installed
- A ChatGPT account (free tier works)
- A machine on your network (or port-forwarded) reachable from where you browse

### Local setup (no Docker)
- **Node.js 18+**
- **Chromium** (installed via `npx playwright install chromium`)
- A display (or `xvfb-run` for headless servers)
- A ChatGPT account

## Setup — Docker (Recommended)

### Step 1: Clone and configure

```bash
git clone https://github.com/thirdmannz/gptchatbridge.git
cd gptchatbridge

# (Optional) Copy env file and adjust
cp .env.example .env
```

### Step 2: Build the image

```bash
docker compose build
```

This builds a single image with Node.js, Chromium, Playwright, Patchright, Xvfb, and noVNC tools.

### Step 3: Log in to ChatGPT (one-time)

```bash
docker compose --profile login up login
```

Then:
1. Open `http://<server-ip>:6080/vnc.html` in your browser
2. Click the screen — you'll see a Chromium browser desktop
3. Log in to ChatGPT with your account
4. Wait for "Login successful" in the terminal output
5. Press `Ctrl+C` to stop the login container

The session is saved to `./browser-data/` and persists across restarts.

> **Note:** The login container is a one-shot service. It only runs when you need to (re)authenticate. Don't leave it running — it exposes an unauthenticated remote desktop.

### Step 4: Start the bridge

```bash
docker compose up -d
```

### Step 5: Verify

```bash
# Check health
curl http://localhost:3400/api/health

# Check status (should show loggedIn: true)
curl http://localhost:3400/api/status

# List your ChatGPT sessions
curl http://localhost:3400/api/sessions
```

Open the dashboard at `http://<server-ip>:3400` from any browser on your network.

### Stopping

```bash
docker compose down           # stop the bridge
docker compose --profile login down  # stop the login service (if running)
```

### Re-authenticating (session expired)

```bash
docker compose --profile login up login
# → open http://<server-ip>:6080/vnc.html, log in again, Ctrl+C
docker compose up -d          # restart the bridge
```

## Setup — Local (No Docker)

### Step 1: Install dependencies

```bash
git clone https://github.com/thirdmannz/gptchatbridge.git
cd gptchatbridge
npm install
npx playwright install chromium
```

### Step 2: Log in to ChatGPT (one-time)

```bash
npm run login
```

A visible Chromium window opens. Log in to ChatGPT. The session is saved to `browser-data/`. Press `Ctrl+C` when done.

> On a headless server, use: `npm run login:xvfb` (requires `xvfb-run`).

### Step 3: Start the bridge

```bash
npm start
```

> On a headless server, use: `npm run start:xvfb`

### Step 4: Verify

```bash
curl http://localhost:3400/api/status
```

Open `http://localhost:3400` in your browser.

## Usage

### Dashboard

Open `http://<server-ip>:3400` for a ChatGPT-style dark UI:

- **Sidebar** — session list with search
- **Chat tab** — message rendering with markdown, real-time streaming preview, image thumbnails
- **Images tab** — DALL-E image gallery
- **Raw tab** — raw message text
- **Composer** — Chat/Agent mode toggle, repo path input, repo context checkbox
- **Agent timeline** — iteration markers, expandable tool-call cards

### Sending your first prompt

**Via the dashboard:**
1. Select a session from the sidebar (or start a new chat)
2. Type your prompt in the composer
3. Press Enter or click Send
4. Watch the response stream in real time

**Via the API:**
```bash
# List sessions
curl http://localhost:3400/api/sessions

# Send a prompt to a session
curl -X POST http://localhost:3400/api/sessions/{session-id}/messages \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "Write a haiku about debugging"}'
```

**Via the CLI:**
```bash
node hermes-cli.js sessions
node hermes-cli.js send <session-id> "your prompt"
```

## REST API Reference

All endpoints are under `/api`. In multi-user mode, include `x-api-key` header.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Pool-wide health (for load balancers) |
| `GET` | `/metrics` | Prometheus-format metrics |
| `GET` | `/users` | List configured users |
| `GET` | `/status` | Current browser + session status |
| `GET` | `/models` | List available models |
| `POST` | `/model` | Set current model (`{"model": "o3"}`) |
| `GET` | `/sessions` | List all ChatGPT sessions |
| `GET` | `/sessions/:id` | Get messages from a session |
| `POST` | `/sessions/:id/messages` | Send prompt, get response |
| `POST` | `/sessions/:id/messages?stream=1` | Send prompt with SSE streaming |
| `GET` | `/sessions/:id/stream` | Subscribe to stream events (read-only) |
| `POST` | `/sessions/new` | Start a new chat |
| `POST` | `/sessions/:id/agent` | Agent loop (read/write files, run commands) |
| `POST` | `/sessions/:id/agent?stream=1` | Agent loop with SSE streaming |
| `GET` | `/sessions/:id/images` | Extract images from a session |
| `POST` | `/sessions/:id/images/:index/save` | Save an image to disk |
| `POST` | `/images/save` | Save an image by URL |
| `POST` | `/sessions/:id/upload` | Upload a file to the ChatGPT composer |

### WebSocket

Connect to `ws://<server-ip>:3400/ws` for real-time updates:

```javascript
const ws = new WebSocket('ws://localhost:3400/ws');
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  // msg.type: 'status' | 'stream' | 'error' | 'pong'
  // status: { status: 'thinking' | 'streaming' | 'done' | 'error' }
  // stream: { delta, full, done, phase, sessionId }
};
```

## CLI Helper

```bash
node hermes-cli.js status                                    # check bridge status
node hermes-cli.js sessions                                  # list sessions
node hermes-cli.js messages <session-id>                     # read messages
node hermes-cli.js send <session-id> "your prompt"           # send prompt
node hermes-cli.js stream <session-id> "your prompt"         # SSE streaming
node hermes-cli.js ask "your prompt"                         # auto new chat
node hermes-cli.js agent <session-id> "prompt" /path/to/repo # agent loop
node hermes-cli.js agent <session-id> "prompt" /repo --context  # + repo context
node hermes-cli.js images <session-id>                       # list images
node hermes-cli.js save-image <url> [filename]               # save image
```

Set `BRIDGE_URL` env var to point to a remote bridge:
```bash
BRIDGE_URL=http://192.168.1.100:3400 node hermes-cli.js sessions
```

## Agent Mode

Agent mode lets ChatGPT read/write files and run commands in a local repo. The bridge injects a system prefix teaching ChatGPT a tool-call protocol, then executes each tool call locally and feeds results back.

### Available tools

| Tool | Args | Returns |
|------|------|---------|
| `read_file` | `{ path }` | file content |
| `write_file` | `{ path, content }` | bytes written |
| `list_dir` | `{ path }` | entries `[{name, type}]` |
| `run` | `{ cmd }` | stdout, stderr, exitCode |

- All paths are relative to the repo root and validated against path traversal
- `run` has a 30s timeout
- Loop runs up to 20 iterations

### Example

```bash
curl -X POST 'http://localhost:3400/api/sessions/{id}/agent?stream=1' \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "Fix the failing tests", "repoPath": "/path/to/repo", "repoContext": true}'
```

## Multi-User Mode

By default, the bridge runs in single-user mode (no API key needed). To enable multi-user mode:

1. Create `users.json`:
```json
{
  "alice": "key_alice_change_me",
  "bob": "key_bob_change_me"
}
```

2. Each user gets their own `browser-data/<userId>/` directory and ChatGPT account.

3. API requests must include `x-api-key` header:
```bash
curl -H "x-api-key: key_alice_change_me" http://localhost:3400/api/status
```

4. Log in each user separately:
```bash
npm run login -- --user alice
npm run login -- --user bob
```

In Docker:
```bash
docker compose --profile login up login alice
docker compose --profile login up login bob
```

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3400` | HTTP/WS server port |
| `HEADLESS` | `true` | Run browser headless (`false` for debugging) |
| `LOG_LEVEL` | `info` | Log level: trace, debug, info, warn, error |
| `MAX_CONCURRENT_USERS` | `5` | Max browser contexts (each ~150MB RAM) |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins |
| `ENABLE_DEBUG` | `false` | Expose `/api/debug/*` endpoints |
| `RESPONSE_TIMEOUT` | `300000` | Max wait for ChatGPT response (ms) |
| `SESSION_TIMEOUT` | `30000` | Session navigation timeout (ms) |

### Files

| File | Description |
|------|-------------|
| `server.js` | Entry point — starts Express + WebSocket + browser pool |
| `src/browser.js` | Browser manager — persistent Playwright/Patchright context |
| `src/browser-pool.js` | Multi-user browser pool with API key resolution |
| `src/chatgpt.js` | ChatGPT DOM controller — send, extract, poll, stream |
| `src/api.js` | REST API routes |
| `src/ws.js` | WebSocket handler for real-time updates |
| `src/agent.js` | Agent loop — tool-call protocol + local execution |
| `src/tools.js` | Agent tools (read/write/list/run) with safety checks |
| `src/config.js` | Centralized configuration constants |
| `src/logger.js` | Logger with child namespaces |
| `src/login.js` | Interactive login script |
| `public/` | Dashboard UI (HTML, CSS, JS) |
| `hermes-cli.js` | CLI helper |
| `Dockerfile` | Single image for both bridge and login services |
| `docker-compose.yml` | Service definitions |
| `scripts/start-server.sh` | Bridge container entrypoint (Xvfb + node) |
| `scripts/remote-login.sh` | Login container entrypoint (Xvfb + VNC + noVNC) |

## Troubleshooting

### "Profile appears to be in use by another Chromium process"

This happens when a previous container left a stale lock file. The startup scripts now clean these automatically. If it persists:

```bash
# Docker
docker exec chatgptbridge-bridge-1 rm -f /app/browser-data/SingletonLock /app/browser-data/SingletonCookie /app/browser-data/SingletonSocket

# Local
rm -f browser-data/SingletonLock browser-data/SingletonCookie browser-data/SingletonSocket
```

### "Session expired or not logged in"

Your ChatGPT session has expired. Re-authenticate:

```bash
# Docker
docker compose --profile login up login

# Local
npm run login
```

### "Captcha/challenge detected"

Cloudflare is challenging the browser. This usually means:
- You're using standard Playwright instead of Patchright (install `patchright`)
- Your IP is flagged — try a different network or VPN
- You're hitting ChatGPT too frequently

### Browser won't start in Docker ("Missing X server")

The container needs Xvfb for headful Patchright mode. Ensure `DISPLAY=:99` is set (it is by default in `docker-compose.yml`). The entrypoint script starts Xvfb automatically.

### Port 6080 not accessible

The login container isn't running. Start it:
```bash
docker compose --profile login up login
```
Then open `http://<server-ip>:6080/vnc.html` (note the `/vnc.html` path).

### Memory issues

Each browser context uses ~150MB. Reduce `MAX_CONCURRENT_USERS` or increase Docker's `shm_size` (default 2GB in compose).

---

<a id="中文"></a>

# 中文

ChatGPT 网页版（免费版）与 HTTP 客户端之间的桥梁。通过 REST API + 实时仪表盘封装 ChatGPT 网页界面，让你可以编程控制 ChatGPT、流式传输回复、让 ChatGPT 读写你的代码仓库、下载图片 —— 全部无需 OpenAI API 密钥。

## 目录

- [功能介绍](#功能介绍)
- [工作原理](#工作原理)
- [前置条件](#前置条件)
- [Docker 部署（推荐）](#docker-部署推荐)
- [本地部署（不用 Docker）](#本地部署不用-docker)
- [使用方法](#使用方法)
- [REST API 参考](#rest-api参考)
- [命令行工具](#命令行工具)
- [Agent 模式](#agent-模式)
- [多用户模式](#多用户模式)
- [配置说明](#配置说明)
- [常见问题](#常见问题)

## 功能介绍

- **通过 API 控制 ChatGPT 网页版** — 发送提示、读取回复、列出会话、提取图片，全部通过 HTTP
- **实时流式传输** — 通过 WebSocket 或 SSE 逐字查看 ChatGPT 的回复
- **Agent 模式** — 让 ChatGPT 读取文件、写入文件、在你的仓库中运行命令
- **仪表盘** — ChatGPT 风格的深色界面，浏览会话、发送提示、查看图片
- **远程登录** — 通过 noVNC 从浏览器登录 ChatGPT，即使服务器在远程
- **多用户** — 每个用户有独立的浏览器配置和 ChatGPT 账号
- **免费使用** — 使用 ChatGPT 免费网页版，支持扩展思考（o3、o4-mini、gpt-5 等）
- **反检测** — 使用 Patchright（Playwright 隐身分支）通过 Cloudflare 机器人检测

## 工作原理

```
┌─────────────────────────────────────────────────────────────┐
│                        你的机器                              │
│                                                              │
│  ┌─────────────┐    ┌──────────────┐    ┌────────────────┐  │
│  │  仪表盘      │    │  Hermes CLI  │    │  curl / 脚本   │  │
│  │  (浏览器)    │    │  (终端)       │    │  (任何客户端)   │  │
│  └──────┬───────┘    └──────┬───────┘    └───────┬────────┘  │
│         │ WebSocket          │ HTTP              │ HTTP      │
│         └──────────┬─────────┴───────────────────┘           │
│                    │                                         │
│         ┌──────────▼──────────┐                              │
│         │   Express 服务器     │  ← server.js (端口 3400)     │
│         │   • REST API        │     src/api.js               │
│         │   • WebSocket       │     src/ws.js                │
│         │   • 静态仪表盘       │     public/                  │
│         └──────────┬──────────┘                              │
│                    │                                         │
│         ┌──────────▼──────────┐                              │
│         │  ChatGPT 控制器      │  ← src/chatgpt.js            │
│         │  • 发送消息          │     DOM 抓取 + 轮询           │
│         │  • 提取回复          │     网络 SSE 拦截             │
│         │  • 列出会话          │                              │
│         │  • 下载图片          │                              │
│         └──────────┬──────────┘                              │
│                    │                                         │
│         ┌──────────▼──────────┐                              │
│         │  浏览器管理器         │  ← src/browser.js            │
│         │  (Patchright/        │     持久化配置在              │
│         │   Playwright)        │     browser-data/            │
│         └──────────┬──────────┘                              │
│                    │                                         │
│         ┌──────────▼──────────┐                              │
│         │  Chromium 浏览器     │  ← 无头模式 (Docker 中用 Xvfb) │
│         │  → chatgpt.com      │                              │
│         └─────────────────────┘                              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 流程说明

1. **登录（一次性）：** 打开一个有界面的 Chromium 浏览器访问 ChatGPT。你用账号登录后，会话（cookies、localStorage）保存到 `browser-data/` —— 一个持久化的浏览器配置目录。

2. **服务器启动：** Express 服务器用保存的配置启动一个无头 Chromium，导航到 `chatgpt.com` 并确认已登录。

3. **你发送提示：** `POST /api/sessions/:id/messages` → 控制器导航到该聊天会话，将你的提示输入到 ProseMirror 编辑器中，然后点击发送。

4. **回复检测：** 控制器每 500ms 轮询 DOM，只读取最后一轮对话的文本。同时拦截来自 `backend-api/conversation` 的 SSE 网络流，实现真正的逐字流式传输。当文本连续 3 次轮询保持稳定且"停止生成"按钮消失时，判定回复完成。

5. **流式传输：** 状态转换（`thinking` → `streaming` → `done`）和文本增量作为事件发出。WebSocket 将它们转发到仪表盘；SSE 将它们转发给 HTTP 客户端。

6. **Agent 模式：** 桥梁注入一个系统前缀，教 ChatGPT 使用工具调用协议（带 JSON 的 `tool` 代码块）。每次回复后，扫描工具调用，在本地执行（读写文件、运行命令），然后将结果作为下一个提示反馈回去。最多循环 20 次。

### 两个 Docker 服务

项目使用 **一个镜像，两个服务**：

| 服务 | 用途 | 端口 | 何时运行 |
|------|------|------|----------|
| `bridge` | 长期运行的 API 服务器 + 仪表盘 + Playwright | 3400 | 始终运行（`docker compose up -d`） |
| `login` | 一次性 noVNC 网页客户端，用于交互式 ChatGPT 登录 | 6080 | 仅在（重新）认证时（`docker compose --profile login up login`） |

它们共享 `./browser-data` 卷。登录容器写入认证会话；桥接容器读取它。

## 前置条件

### Docker 部署（推荐）
- 已安装 **Docker** + **Docker Compose**
- 一个 ChatGPT 账号（免费版即可）
- 一台你网络上（或已端口转发）可从浏览器访问的机器

### 本地部署（不用 Docker）
- **Node.js 18+**
- **Chromium**（通过 `npx playwright install chromium` 安装）
- 显示器（或无头服务器用 `xvfb-run`）
- 一个 ChatGPT 账号

## Docker 部署（推荐）

### 第 1 步：克隆和配置

```bash
git clone https://github.com/thirdmannz/gptchatbridge.git
cd gptchatbridge

# （可选）复制环境文件并调整
cp .env.example .env
```

### 第 2 步：构建镜像

```bash
docker compose build
```

这会构建一个包含 Node.js、Chromium、Playwright、Patchright、Xvfb 和 noVNC 工具的镜像。

### 第 3 步：登录 ChatGPT（一次性）

```bash
docker compose --profile login up login
```

然后：
1. 在浏览器中打开 `http://<服务器IP>:6080/vnc.html`
2. 点击屏幕 —— 你会看到一个 Chromium 浏览器桌面
3. 用你的账号登录 ChatGPT
4. 等待终端输出中出现 "Login successful"
5. 按 `Ctrl+C` 停止登录容器

会话保存到 `./browser-data/`，重启后仍然有效。

> **注意：** 登录容器是一次性服务。只在需要（重新）认证时运行。不要让它一直运行 —— 它会暴露一个无密码的远程桌面。

### 第 4 步：启动桥接服务

```bash
docker compose up -d
```

### 第 5 步：验证

```bash
# 检查健康状态
curl http://localhost:3400/api/health

# 检查状态（应显示 loggedIn: true）
curl http://localhost:3400/api/status

# 列出你的 ChatGPT 会话
curl http://localhost:3400/api/sessions
```

从网络上任何浏览器打开 `http://<服务器IP>:3400` 访问仪表盘。

### 停止

```bash
docker compose down           # 停止桥接服务
docker compose --profile login down  # 停止登录服务（如果在运行）
```

### 重新认证（会话过期）

```bash
docker compose --profile login up login
# → 打开 http://<服务器IP>:6080/vnc.html，重新登录，Ctrl+C
docker compose up -d          # 重启桥接服务
```

## 本地部署（不用 Docker）

### 第 1 步：安装依赖

```bash
git clone https://github.com/thirdmannz/gptchatbridge.git
cd gptchatbridge
npm install
npx playwright install chromium
```

### 第 2 步：登录 ChatGPT（一次性）

```bash
npm run login
```

会打开一个可见的 Chromium 窗口。登录 ChatGPT，会话保存到 `browser-data/`。完成后按 `Ctrl+C`。

> 在无头服务器上，使用：`npm run login:xvfb`（需要 `xvfb-run`）。

### 第 3 步：启动桥接服务

```bash
npm start
```

> 在无头服务器上，使用：`npm run start:xvfb`

### 第 4 步：验证

```bash
curl http://localhost:3400/api/status
```

在浏览器中打开 `http://localhost:3400`。

## 使用方法

### 仪表盘

打开 `http://<服务器IP>:3400`，进入 ChatGPT 风格的深色界面：

- **侧边栏** — 会话列表，带搜索功能
- **聊天标签** — 消息渲染，支持 Markdown，实时流式预览，图片缩略图
- **图片标签** — DALL-E 图片画廊
- **原始标签** — 原始消息文本
- **输入框** — 聊天/Agent 模式切换，仓库路径输入，仓库上下文复选框
- **Agent 时间线** — 迭代标记，可展开的工具调用卡片

### 发送你的第一个提示

**通过仪表盘：**
1. 从侧边栏选择一个会话（或开始新聊天）
2. 在输入框中输入你的提示
3. 按 Enter 或点击发送
4. 实时观看回复流式出现

**通过 API：**
```bash
# 列出会话
curl http://localhost:3400/api/sessions

# 向会话发送提示
curl -X POST http://localhost:3400/api/sessions/{会话ID}/messages \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "写一首关于调试的俳句"}'
```

**通过命令行：**
```bash
node hermes-cli.js sessions
node hermes-cli.js send <会话ID> "你的提示"
```

## REST API 参考

所有端点在 `/api` 下。多用户模式下需包含 `x-api-key` 请求头。

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 整体健康状态（用于负载均衡器） |
| `GET` | `/metrics` | Prometheus 格式指标 |
| `GET` | `/users` | 列出已配置的用户 |
| `GET` | `/status` | 当前浏览器 + 会话状态 |
| `GET` | `/models` | 列出可用模型 |
| `POST` | `/model` | 设置当前模型（`{"model": "o3"}`） |
| `GET` | `/sessions` | 列出所有 ChatGPT 会话 |
| `GET` | `/sessions/:id` | 获取会话消息 |
| `POST` | `/sessions/:id/messages` | 发送提示，获取回复 |
| `POST` | `/sessions/:id/messages?stream=1` | 发送提示，SSE 流式传输 |
| `GET` | `/sessions/:id/stream` | 订阅流式事件（只读） |
| `POST` | `/sessions/new` | 开始新聊天 |
| `POST` | `/sessions/:id/agent` | Agent 循环（读写文件、运行命令） |
| `POST` | `/sessions/:id/agent?stream=1` | Agent 循环，SSE 流式传输 |
| `GET` | `/sessions/:id/images` | 提取会话中的图片 |
| `POST` | `/sessions/:id/images/:index/save` | 保存图片到磁盘 |
| `POST` | `/images/save` | 通过 URL 保存图片 |
| `POST` | `/sessions/:id/upload` | 上传文件到 ChatGPT 输入框 |

### WebSocket

连接 `ws://<服务器IP>:3400/ws` 获取实时更新：

```javascript
const ws = new WebSocket('ws://localhost:3400/ws');
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  // msg.type: 'status' | 'stream' | 'error' | 'pong'
  // status: { status: 'thinking' | 'streaming' | 'done' | 'error' }
  // stream: { delta, full, done, phase, sessionId }
};
```

## 命令行工具

```bash
node hermes-cli.js status                                    # 检查桥接状态
node hermes-cli.js sessions                                  # 列出会话
node hermes-cli.js messages <会话ID>                         # 读取消息
node hermes-cli.js send <会话ID> "你的提示"                   # 发送提示
node hermes-cli.js stream <会话ID> "你的提示"                 # SSE 流式传输
node hermes-cli.js ask "你的提示"                             # 自动新建聊天
node hermes-cli.js agent <会话ID> "提示" /path/to/repo       # Agent 循环
node hermes-cli.js agent <会话ID> "提示" /repo --context     # + 仓库上下文
node hermes-cli.js images <会话ID>                           # 列出图片
node hermes-cli.js save-image <url> [文件名]                 # 保存图片
```

设置 `BRIDGE_URL` 环境变量指向远程桥接：
```bash
BRIDGE_URL=http://192.168.1.100:3400 node hermes-cli.js sessions
```

## Agent 模式

Agent 模式让 ChatGPT 在本地仓库中读写文件和运行命令。桥梁注入一个系统前缀，教 ChatGPT 使用工具调用协议，然后在本地执行每个工具调用并反馈结果。

### 可用工具

| 工具 | 参数 | 返回 |
|------|------|------|
| `read_file` | `{ path }` | 文件内容 |
| `write_file` | `{ path, content }` | 写入字节数 |
| `list_dir` | `{ path }` | 条目 `[{name, type}]` |
| `run` | `{ cmd }` | stdout, stderr, exitCode |

- 所有路径相对于仓库根目录，并验证防止路径遍历
- `run` 有 30 秒超时
- 循环最多 20 次迭代

### 示例

```bash
curl -X POST 'http://localhost:3400/api/sessions/{id}/agent?stream=1' \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "修复失败的测试", "repoPath": "/path/to/repo", "repoContext": true}'
```

## 多用户模式

默认情况下，桥接以单用户模式运行（无需 API 密钥）。要启用多用户模式：

1. 创建 `users.json`：
```json
{
  "alice": "key_alice_change_me",
  "bob": "key_bob_change_me"
}
```

2. 每个用户有自己的 `browser-data/<用户ID>/` 目录和 ChatGPT 账号。

3. API 请求必须包含 `x-api-key` 请求头：
```bash
curl -H "x-api-key: key_alice_change_me" http://localhost:3400/api/status
```

4. 分别登录每个用户：
```bash
npm run login -- --user alice
npm run login -- --user bob
```

在 Docker 中：
```bash
docker compose --profile login up login alice
docker compose --profile login up login bob
```

## 配置说明

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3400` | HTTP/WS 服务器端口 |
| `HEADLESS` | `true` | 无头模式运行浏览器（`false` 用于调试） |
| `LOG_LEVEL` | `info` | 日志级别：trace, debug, info, warn, error |
| `MAX_CONCURRENT_USERS` | `5` | 最大浏览器上下文数（每个约 150MB 内存） |
| `ALLOWED_ORIGINS` | `*` | 逗号分隔的 CORS 来源 |
| `ENABLE_DEBUG` | `false` | 暴露 `/api/debug/*` 端点 |
| `RESPONSE_TIMEOUT` | `300000` | 等待 ChatGPT 回复的最大时间（毫秒） |
| `SESSION_TIMEOUT` | `30000` | 会话导航超时（毫秒） |

### 文件说明

| 文件 | 说明 |
|------|------|
| `server.js` | 入口 — 启动 Express + WebSocket + 浏览器池 |
| `src/browser.js` | 浏览器管理器 — 持久化 Playwright/Patchright 上下文 |
| `src/browser-pool.js` | 多用户浏览器池，带 API 密钥解析 |
| `src/chatgpt.js` | ChatGPT DOM 控制器 — 发送、提取、轮询、流式传输 |
| `src/api.js` | REST API 路由 |
| `src/ws.js` | WebSocket 处理器，实时更新 |
| `src/agent.js` | Agent 循环 — 工具调用协议 + 本地执行 |
| `src/tools.js` | Agent 工具（读/写/列目录/运行），带安全检查 |
| `src/config.js` | 集中化配置常量 |
| `src/logger.js` | 带子命名空间的日志器 |
| `src/login.js` | 交互式登录脚本 |
| `public/` | 仪表盘界面（HTML、CSS、JS） |
| `hermes-cli.js` | 命令行工具 |
| `Dockerfile` | 单镜像，用于桥接和登录两个服务 |
| `docker-compose.yml` | 服务定义 |
| `scripts/start-server.sh` | 桥接容器入口脚本（Xvfb + node） |
| `scripts/remote-login.sh` | 登录容器入口脚本（Xvfb + VNC + noVNC） |

## 常见问题

### "Profile appears to be in use by another Chromium process"（配置文件被另一个 Chromium 进程占用）

这是因为之前的容器留下了过期的锁文件。启动脚本现在会自动清理。如果问题持续：

```bash
# Docker
docker exec chatgptbridge-bridge-1 rm -f /app/browser-data/SingletonLock /app/browser-data/SingletonCookie /app/browser-data/SingletonSocket

# 本地
rm -f browser-data/SingletonLock browser-data/SingletonCookie browser-data/SingletonSocket
```

### "Session expired or not logged in"（会话过期或未登录）

你的 ChatGPT 会话已过期。重新认证：

```bash
# Docker
docker compose --profile login up login

# 本地
npm run login
```

### "Captcha/challenge detected"（检测到验证码/挑战）

Cloudflare 正在挑战浏览器。通常意味着：
- 你用的是标准 Playwright 而不是 Patchright（安装 `patchright`）
- 你的 IP 被标记 — 尝试换网络或 VPN
- 你访问 ChatGPT 过于频繁

### Docker 中浏览器无法启动（"Missing X server"）

容器需要 Xvfb 来运行有头模式的 Patchright。确保设置了 `DISPLAY=:99`（`docker-compose.yml` 中默认已设置）。入口脚本会自动启动 Xvfb。

### 端口 6080 无法访问

登录容器没有运行。启动它：
```bash
docker compose --profile login up login
```
然后打开 `http://<服务器IP>:6080/vnc.html`（注意 `/vnc.html` 路径）。

### 内存问题

每个浏览器上下文约用 150MB。减少 `MAX_CONCURRENT_USERS` 或增加 Docker 的 `shm_size`（compose 中默认 2GB）。

## License

MIT

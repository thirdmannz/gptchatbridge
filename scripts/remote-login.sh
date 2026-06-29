#!/bin/bash
# Remote login entrypoint — starts Xvfb + VNC + noVNC + browser.
# User connects to http://server-ip:6080 from their browser to log in.
# Session is saved to /app/browser-data/ (persisted via volume).

set -e

USER_ID="${1:-default}"
RESOLUTION="${VNC_RESOLUTION:-1280x900}"

# Clean stale Chromium Singleton locks left by previous containers.
for dir in /app/browser-data /app/browser-data/*; do
  [ -d "$dir" ] || continue
  for lockfile in SingletonLock SingletonCookie SingletonSocket; do
    rm -f "$dir/$lockfile" 2>/dev/null || true
  done
done

echo "╔══════════════════════════════════════════════════╗"
echo "║  ChatGPT Bridge — Remote Login                   ║"
echo "║                                                  ║"
echo "║  User:   ${USER_ID}                                      ║"
echo "║  Open:   http://<server-ip>:${NOVNC_PORT:-6080}                 ║"
echo "║                                                  ║"
echo "║  1. Click the screen in noVNC                    ║"
echo "║  2. Log in to ChatGPT with your account          ║"
echo "║  3. Wait for 'Login successful' in the logs      ║"
echo "║  4. Ctrl+C to stop (session is saved)            ║"
echo "╚══════════════════════════════════════════════════╝"

# 1. Start Xvfb (virtual framebuffer)
Xvfb :99 -screen 0 "$RESOLUTION"x24 -ac -nolisten tcp &
XVFB_PID=$!
sleep 1
echo "[login] Xvfb started (PID $XVFB_PID, display :99, $RESOLUTION)"

# 2. Start fluxbox (minimal window manager — needed for proper rendering)
DISPLAY=:99 fluxbox &
FLUXBOX_PID=$!
sleep 0.5
echo "[login] Fluxbox window manager started"

# 3. Start x11vnc (VNC server on the virtual display)
x11vnc -display :99 -rfbport "${VNC_PORT:-5900}" -nopw -forever -shared -bg -o /app/logs/x11vnc.log
sleep 0.5
echo "[login] x11vnc started on port ${VNC_PORT:-5900}"

# 4. Start websockify/noVNC (web-based VNC client)
websockify --web=/usr/share/novnc/ "${NOVNC_PORT:-6080}" localhost:"${VNC_PORT:-5900}" &
WS_PID=$!
sleep 1
echo "[login] noVNC web client started on port ${NOVNC_PORT:-6080}"
echo ""
echo ">>> Open http://<this-server-ip>:${NOVNC_PORT:-6080}/vnc.html in your browser <<<"
echo ""

# 5. Start the login script (headful browser)
export DISPLAY=:99
export HEADLESS=false
node src/login.js --user "$USER_ID" &
LOGIN_PID=$!

# 6. Wait for login or Ctrl+C
wait $LOGIN_PID 2>/dev/null || true

# Cleanup
echo "[login] Shutting down..."
kill $WS_PID $FLUXBOX_PID $XVFB_PID 2>/dev/null || true
echo "[login] Done. Session saved in browser-data/${USER_ID}/"

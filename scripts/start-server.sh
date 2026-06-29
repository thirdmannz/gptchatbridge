#!/bin/bash
# Server entrypoint — starts Xvfb (for Patchright headful mode to pass Cloudflare)
# then launches the bridge server.

set -e

# Clean stale Chromium Singleton locks left by previous containers.
# Each container has a different hostname, so any existing SingletonLock
# symlink points to a dead process on a different "computer" and blocks launch.
# Note: use -L (symlink) check, not -e, because dangling symlinks fail -e.
for dir in /app/browser-data /app/browser-data/*; do
  [ -d "$dir" ] || continue
  for lockfile in SingletonLock SingletonCookie SingletonSocket; do
    rm -f "$dir/$lockfile" 2>/dev/null || true
  done
done

# Start Xvfb if not already running (needed for headful Patchright to pass Cloudflare)
if [ -z "$DISPLAY" ] || [ "$DISPLAY" = ":99" ]; then
  if ! pgrep -x Xvfb > /dev/null 2>&1; then
    Xvfb :99 -screen 0 "${VNC_RESOLUTION:-1280x900}"x24 -ac -nolisten tcp &
    sleep 1
    echo "[server] Xvfb started (display :99)"
  fi
  export DISPLAY=:99
fi

# Start the bridge server
exec node server.js

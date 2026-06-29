# ChatGPT Bridge — Dockerfile
# Includes Chromium (via Playwright) + Patchright + noVNC for remote login.
#
# Build:  docker build -t chatgpt-bridge .
# Run:    docker compose up -d
# Login:  docker compose --profile login up login
#         → open http://server-ip:6080 in your browser

FROM node:22-bookworm

# Install Playwright system dependencies + Chromium + VNC tools
RUN npx --yes playwright@1.61.0 install --with-deps chromium && \
    apt-get update && apt-get install -y --no-install-recommends \
        x11vnc \
        novnc \
        websockify \
        xvfb \
        fluxbox \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install deps first (better layer caching)
COPY package*.json ./
RUN npm ci

# Copy application code
COPY . .

# Create directories for persistent data
RUN mkdir -p /app/browser-data /app/downloads /app/logs

# Ensure scripts are executable
RUN chmod +x scripts/*.sh

# Expose: 3400 = bridge API, 6080 = noVNC web client
EXPOSE 3400 6080

# Environment defaults
ENV PORT=3400 \
    HEADLESS=false \
    LOG_LEVEL=info \
    NODE_ENV=production \
    DISPLAY=:99 \
    VNC_PORT=5900 \
    NOVNC_PORT=6080 \
    VNC_RESOLUTION=1280x900

# Default: run the bridge server (with Xvfb for Patchright headful mode)
CMD ["/app/scripts/start-server.sh"]

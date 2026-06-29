// ChatGPT Bridge — PM2 Process Manager Config
//
// Usage:
//   pm2 start ecosystem.config.js
//   pm2 logs chatgpt-bridge
//   pm2 restart chatgpt-bridge
//   pm2 stop chatgpt-bridge
//   pm2 delete chatgpt-bridge
//
// PM2 handles: auto-restart on crash, log rotation, zero-downtime reload.
// For first-time login, run locally (not via PM2): npm run login

module.exports = {
  apps: [{
    name: 'chatgpt-bridge',
    script: 'server.js',
    cwd: __dirname,
    instances: 1,            // Single instance — browser contexts aren't shareable
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,     // 5s between restarts (don't hammer ChatGPT)
    max_memory_restart: '2G',// Restart if memory exceeds 2GB
    watch: false,
    env: {
      NODE_ENV: 'production',
      PORT: 3400,
      HEADLESS: 'true',
      LOG_LEVEL: 'info',
    },
    env_login: {
      NODE_ENV: 'development',
      HEADLESS: 'false',
    },
    // Log files (PM2 rotates automatically)
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    merge_logs: true,
    time: true,
  }],
};

// PM2 Ecosystem Configuration — HogaresRD
// Usage: pm2 start ecosystem.config.js
//
// ⚠️  Crash-loop alerting: PM2 will auto-restart up to `max_restarts: 20`
// times before giving up. Crash-loops, uncaught exceptions, and unhandled
// rejections are now alertable via the ALERT_WEBHOOK_URL env var
// (see utils/alerts.js + the process handlers near the top of server.js).
// If ALERT_WEBHOOK_URL is unset, alerts degrade to console.warn.
module.exports = {
  apps: [
    {
      name: 'hogaresrd',
      script: 'server.js',
      // Kept at 1 instance / fork mode on purpose. Cluster mode would
      // break 2-step flows that keep state in in-memory Maps per process:
      //   - admin OTP (login → verify must hit same worker)
      //   - Meta OAuth state (auth-url → callback)
      //   - rate limiters (_loginAttempts, _viewSeen)
      //   - listings cache
      // To enable cluster later: move those maps to SQLite/Redis first.
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1500M', // 2GB droplet — give Node 1.5GB headroom
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      // Logging
      error_file: '/var/log/hogaresrd/error.log',
      out_file: '/var/log/hogaresrd/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Restart policy
      //
      // ⚠️  Crash-loop alerting is currently log-only. PM2 will give up
      // after `max_restarts` consecutive failed boots within `min_uptime`,
      // but it does not page anyone — outages are only visible by tailing
      // /var/log/hogaresrd/error.log or running `pm2 status`.
      //
      // Future options for active alerting (out of scope for this PR):
      //   • `pm2 monit`          — local TTY dashboard (manual, not paging)
      //   • `pm2 plus` / Keymetrics — hosted metrics + restart alerts
      //   • A simple cron that grep's the error log and POSTs to Slack
      //
      // For now we bump max_restarts to 20 so a flappy crash gets a bit
      // more headroom before PM2 stops trying — better than truly silent
      // 10-restart cap.
      max_restarts: 20,
      min_uptime: '10s',
      restart_delay: 4000,
      autorestart: true,
      // Graceful reload — new process sends process.send('ready') after
      // the store cache is loaded, so PM2 doesn't kill the old one early.
      wait_ready: true,
      kill_timeout: 5000,
      listen_timeout: 15000,  // allow up to 15s for cache load before PM2 gives up
    },
  ],
};

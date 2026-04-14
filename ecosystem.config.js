// PM2 Ecosystem Configuration — HogaresRD
// Usage: pm2 start ecosystem.config.js
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
      max_restarts: 10,
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

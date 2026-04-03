// PM2 Ecosystem Configuration — HogaresRD
// Usage: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'hogaresrd',
      script: 'server.js',
      instances: 1,              // Single instance for SQLite compatibility
      exec_mode: 'fork',         // fork mode (not cluster) for SQLite
      watch: false,
      max_memory_restart: '512M',
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
      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 8000,
    },
  ],
};

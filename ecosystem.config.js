module.exports = {
  apps: [
    {
      name: 'moneygoup',
      script: 'node_modules/.bin/next',
      args: 'start -p 3001',
      cwd: '/var/www/html/moneygoup',
      // Restart Next.js if it exceeds 1.4 GB — leaves ~2.6 GB for Ollama +
      // TF subprocesses + MySQL on the 4 GB Enhanced VPS. Without this PM2
      // will let the process balloon until the OOM killer hits it, which can
      // take the whole web server down mid-sync.
      max_memory_restart: '1400M',
      // Restart policy: wait 5 s before restarting so any leftover TF child
      // processes have time to exit and release RAM before the new instance
      // tries to allocate.
      restart_delay: 5000,
      // Backoff: after 3 quick restarts, cool down for 30 s.
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      env_production: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      // Merge stdout + stderr into one PM2 log so tail -f shows everything.
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};

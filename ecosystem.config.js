module.exports = {
  apps: [
    {
      // ── Warm prediction service ─────────────────────────────────────────
      // Loads TF/sklearn/model artifacts once on startup and serves /predict
      // via HTTP, eliminating per-request Python cold-start overhead.
      //
      // Activation: set PREDICTION_SERVICE_URL=http://127.0.0.1:7861 in
      // .env.local or .env.production.  If unset, route.ts falls back to
      // the legacy spawn-per-request path so this entry is safe to deploy
      // even before the URL is configured.
      //
      // Memory: one warm worker holds ~600-800 MB steady-state (TF + sklearn +
      // model artifacts). Raise max_memory_restart if OOM-killed.
      name: 'prediction-service',
      script: 'venv/bin/python3',
      args: 'scripts/prediction_service.py',
      cwd: '/var/www/html/moneygoup',
      interpreter: 'none',
      max_memory_restart: '900M',
      restart_delay: 8000,
      exp_backoff_restart_delay: 200,
      max_restarts: 5,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // Health-check: PM2 won't mark this ready until /health returns 200.
      // Prevents Next.js from routing requests during the startup window.
      wait_ready: true,
      listen_timeout: 120000,
    },
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

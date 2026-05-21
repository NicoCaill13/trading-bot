'use strict';

module.exports = {
  apps: [
    {
      name:              'trading-bot',
      script:            'node_modules/.bin/tsx',
      args:              'src/index.ts',
      cwd:               __dirname,
      instances:         1,
      autorestart:       true,
      watch:             false,
      // Redémarre automatiquement si le process dépasse 400MB
      max_memory_restart: '400M',
      // Délai minimum entre deux restarts (évite les boucles crash rapides)
      min_uptime:        '30s',
      max_restarts:      5,
      env: {
        NODE_ENV: 'production',
      },
      // PM2 écrit ses propres logs en parallèle du logger applicatif
      out_file:          './logs/pm2-out.log',
      error_file:        './logs/pm2-error.log',
      merge_logs:        true,
      log_date_format:   'YYYY-MM-DD HH:mm:ss',
      // Envoie SIGTERM avant SIGKILL — laisse 10s au graceful shutdown
      kill_timeout:      10000,
      listen_timeout:    5000,
    },
  ],
};

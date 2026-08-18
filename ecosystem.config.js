'use strict';

const path = require('path');

const tsx = path.join(__dirname, 'node_modules/.bin/tsx');

const common = {
  interpreter: tsx,
  cwd: __dirname,
  instances: 1,
  autorestart: true,
  watch: false,
  min_uptime: '10s',
  max_restarts: 40,
  restart_delay: 10000,
  env: { NODE_ENV: 'production' },
  merge_logs: true,
  log_date_format: 'YYYY-MM-DD HH:mm:ss',
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'trading-bot',
      script: path.join(__dirname, 'src/index.ts'),
      min_uptime: '30s',
      max_memory_restart: '400M',
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      kill_timeout: 20000,
    },
    {
      ...common,
      name: 'trading-watchdog',
      script: path.join(__dirname, 'src/watchdog.ts'),
      out_file: './logs/pm2-watchdog-out.log',
      error_file: './logs/pm2-watchdog-error.log',
      kill_timeout: 10000,
    },
  ],
};

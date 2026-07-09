// PM2 config — keeps the app healthy on a small (2GB) server.
// Deploy:  pm2 delete metadata ; pm2 start ecosystem.config.js ; pm2 save
module.exports = {
  apps: [
    {
      name: 'metadata',
      script: 'server.js',
      env: { NODE_ENV: 'production', PORT: 3005 },
      autorestart: true,
      max_restarts: 40,
      restart_delay: 3000,
      max_memory_restart: '350M', // restart cleanly before it can starve the box
      kill_timeout: 8000,
    },
  ],
};

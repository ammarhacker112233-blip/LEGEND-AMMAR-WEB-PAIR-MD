// 🕷️ LEGEND-AMMAR — pm2 processes: bot + built-in web pairing server
module.exports = {
  apps: [
    {
      name: "LEGEND-AMMAR",
      script: "index.js",
      autorestart: true,
      max_restarts: 20,
      min_uptime: "5s",
      instances: 1,
      exec_mode: "fork",
    },
    {
      name: "LEGEND-AMMAR-PAIR",
      script: "pair.js",
      autorestart: true,
      max_restarts: 20,
      min_uptime: "5s",
      instances: 1,
      exec_mode: "fork",
      env: {
        // Railway exposes a single PORT for the service; pairing page runs on it
        // alongside the bot via pm2 process separation (bot uses its own WS port).
        PORT: "8000",
      },
    },
  ],
};

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
      // Do NOT set PORT here — Railway injects its own PORT for the service;
      // pair.js binds to process.env.PORT so Railway's proxy finds it.
    },
  ],
};

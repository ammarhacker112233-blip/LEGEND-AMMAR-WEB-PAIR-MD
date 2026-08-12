#!/bin/bash
# 🕷️ LEGEND-AMMAR startup for Railway
# 1. Bind Railway's PORT immediately with a tiny express server (page + api)
#    via pair.js — kept in FOREGROUND so the container stays alive.
# 2. The bot (index.js) runs in background.
set -u

echo "[🕷️] Starting on PORT=$PORT ..."

# Pairing web in background first so the port is bound quickly
node pair.js > pair_startup.log 2>&1 &
echo "[🕷️] pair.js spawned (PID $!)"

# Give pair.js a moment to bind the port (cold start can be slow)
sleep 3
if curl -s -o /dev/null -m 5 "http://127.0.0.1:${PORT:-8000}/"; then
  echo "[🕷️] pairing page is UP on port $PORT"
else
  echo "[🕷️] WARN: pairing page not yet up, continuing anyway"
fi

# Bot in background
node index.js > bot_startup.log 2>&1 &
echo "[🕷️] bot spawned (PID $!)"

# Foreground: wait forever (container dies when this exits)
wait

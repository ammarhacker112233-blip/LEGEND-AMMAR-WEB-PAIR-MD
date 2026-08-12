#!/bin/bash
# 🕷️ LEGEND-AMMAR startup for Railway
# pair.js binds Railway's PORT (HTTP page) FIRST, then the bot starts.
# If the bot ever tries to bind the same PORT, pair.js already owns it.

echo "[🕷️] Starting LEGEND-AMMAR pairing web on PORT=$PORT ..."
node pair.js &
PAIR_PID=$!

echo "[🕷️] Starting LEGEND-AMMAR bot ..."
exec node index.js

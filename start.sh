#!/bin/bash
# 🕷️ LEGEND-AMMAR startup for Railway
# Problem solved: index.js ALSO binds process.env.PORT ("JAWAD-MD Server Live"),
# so running pair.js + index.js on the same PORT crashed both (EADDRINUSE).
# Fix:
#   1. pair.js  → Railway's PORT (foreground-ish, page + pairing API)
#   2. index.js → an INTERNAL port only, plus SESSION_ID from SESSION_ID.txt
#
# SESSION contract (verified by running the obfuscated index.js in a VM):
#   the bot reads the env var SESSION_ID, format = IK~base64(gzip(creds.json))
# It does NOT fetch global.session at boot — SESSION_ID env is the only source.
set -u

APP="${PORT:-8080}"
export PORT="$APP"

# Internal port for the bot's own HTTP server (Railway proxy only routes to $PORT)
BOT_PORT=$((APP + 1))

echo "[🕷️] Starting on PORT=$PORT (bot internal: $BOT_PORT) ..."

# ---------- 1. Pairing web on Railway's PORT ----------
node pair.js > pair_startup.log 2>&1 &
echo "[🕷️] pair.js spawned (PID $!)"

# Give pair.js a moment to bind the port (cold start can be slow).
# NOTE: Railway image has no curl — use Node for the probe instead.
sleep 3
if node -e "const n=require('net');const s=n.createConnection(${APP},'127.0.0.1',{timeout:4000});s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))" 2>/dev/null; then
  echo "[🕷️] pairing page is UP on port $PORT"
else
  echo "[🕷️] WARN: pairing page not yet up; retrying in 5s ..."
  sleep 5
  if ! node -e "const n=require('net');const s=n.createConnection(${APP},'127.0.0.1',{timeout:4000});s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))" 2>/dev/null; then
    echo "[🕷️] WARN: pairing page STILL not up on port $PORT — continuing anyway"
  fi
fi

# ---------- 2. Bot with SESSION_ID ----------
# pair.js likhta hai: SESSION_ID.txt = IK~base64(gzip(creds.json))
SESSION_FILE="$PWD/SESSION_ID.txt"
BOT_SESSION_ID=""
# Railway secret support: LEGEND_SESSION env var (Dashboard → Variables).
# Railway ke env vars restart/redeploy ke baad bhi zinda rehte hain —
# SESSION_ID.txt (disk) wahan zinda NAHI rehti, isliye env priority hai.
if [ -n "${LEGEND_SESSION:-}" ]; then
  BOT_SESSION_ID="${LEGEND_SESSION}"
  echo "[🕷️] LEGEND_SESSION secret se session li (${#BOT_SESSION_ID} chars)"
  # File bhi likh do — pair.js ka /sessionid endpoint bhi yehi use karta hai
  printf '%s\n' "$BOT_SESSION_ID" > "$SESSION_FILE"
elif [ -f "$SESSION_FILE" ]; then
  BOT_SESSION_ID="$(cat "$SESSION_FILE")"
  echo "[🕷️] SESSION_ID.txt found (${#BOT_SESSION_ID} chars) — passing to bot"
else
  echo "[🕷️] WARN: SESSION_ID.txt nahi mila — pehle pairing page se pair karein"
fi
export SESSION_ID="$BOT_SESSION_ID"
export PORT="$BOT_PORT"
node index.js > bot_startup.log 2>&1 &
echo "[🕷️] bot spawned (PID $!) on internal port $BOT_PORT"

# Foreground: wait forever (container dies when this exits)
wait

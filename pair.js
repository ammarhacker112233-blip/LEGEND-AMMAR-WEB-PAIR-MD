// ============================================================
// 🕷️ LEGEND-AMMAR — Built-in Web Pairing Server
// Chalta hai bot ke saath hi usi Railway domain par.
// Page : https://<railway-domain>/
// Code : POST /api/pair  (phoneNumber)
// Sess : GET  /session?id=<phone>  → bot is ko fetch karke SAME session se chalta hai
// ============================================================
const express = require("express");
const path = require("path");
const fs = require("fs");
const makeWASocket =
  require("@whiskeysockets/baileys").default;
const {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");

// Railway assigns the single public PORT to the container. pair.js MUST bind it
// (the bot's own websocket does not use the HTTP port), otherwise Railway's
// proxy returns 502.
const PORT = Number(process.env.PORT || process.env.PAIR_PORT || 8000);
const AUTH_DIR = path.join(__dirname, ".pair-auth");

// ---------- Logger (terminal + pair.log) ----------
function plog(...args) {
  const line = `[🕷️ PAIR] ${new Date().toISOString()} ${args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(__dirname, "pair.log"), line + "\n");
  } catch {
    /* ignore */
  }
}

// ---------- Creds store: number → full Baileys creds ----------
const credsByNumber = (global.__credsByNumber =
  global.__credsByNumber || new Map());

const noopLogger = {
  level: "error",
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
  levelVal: 50,
};

function getAuthState() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  return useMultiFileAuthState(AUTH_DIR);
}

// Fingerprints proven against WhatsApp 405 on hosted servers
const BROWSER_VARIANTS = [
  ["Chrome", "Windows", "110.0.5481.177"],
  ["Ubuntu", "Chrome", "20.0.04"],
];

// Proven 405 fix version (Baileys issue #2370) — also try latest fetched version
const PINNED_VERSION = [2, 3000, 1033893291];
let fetchedVersion = null;
(async () => {
  try {
    fetchedVersion = await require("@whiskeysockets/baileys").fetchLatestBaileysVersion();
    plog("Fetched latest WA version:", fetchedVersion?.version || fetchedVersion);
  } catch (e) {
    plog("WARN: could not fetch latest WA version, using pinned", e?.message || e);
  }
})();

function attemptPairing(phoneNumber, attempt = 0) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (r) => {
      if (resolved) return;
      resolved = true;
      resolve(r);
    };

    let sock;
    getAuthState()
      .then(({ state, saveCreds }) => {
        // Rotate browser fingerprint per attempt (405/428 fix on hosted IPs)
        const browser = BROWSER_VARIANTS[attempt % BROWSER_VARIANTS.length];
        // Prefer latest fetched WA version; fall back to pinned 405-fix version
        const version = fetchedVersion || PINNED_VERSION;
        plog("Attempt", attempt + 1, "browser:", browser.join(" "), "version:", JSON.stringify(version));
        sock = makeWASocket({
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, noopLogger),
          },
          printQRInTerminal: false,
          logger: noopLogger,
          browser,
          version,
          connectTimeoutMs: 60000,
          defaultQueryTimeoutMs: undefined,
          keepAliveIntervalMs: 30000,
          qrTimeout: undefined,
          markOnlineOnConnect: false,
          syncFullHistory: false,
          getMessage: async () => undefined,
        });

        const entry = credsByNumber.get(phoneNumber) || { creds: {} };
        credsByNumber.set(phoneNumber, entry);

        sock.ev.on("creds.update", (updatedCreds) => {
          try {
            saveCreds(updatedCreds);
          } catch {
            /* ignore */
          }
          Object.assign(entry.creds, updatedCreds);
        });

        const timeout = setTimeout(() => {
          try {
            sock?.end(undefined);
          } catch {
            /* ignore */
          }
          finish({
            valid: false,
            error: new Error(
              "WhatsApp server se connect nahi ho saka, dobara try karein."
            ),
          });
        }, 30000);

        let codeRequested = false;
        sock.ev.on("connection.update", async (update) => {
          const { connection, lastDisconnect } = update;
          if ((connection === "connecting" || update.qr) && !codeRequested) {
            codeRequested = true;
            try {
              let code;
              try {
                code = await sock.requestPairingCode(phoneNumber);
              } catch (inner) {
                code = await sock.requestPairingCode(phoneNumber, {
                  method: "call",
                });
              }
              clearTimeout(timeout);
              try {
                sock?.end(undefined);
              } catch {
                /* ignore */
              }
              const codeStr = String(code).padStart(8, "0");
              plog("Pairing code generated for", phoneNumber);
              finish({ valid: true, code: codeStr });
            } catch {
              clearTimeout(timeout);
              try {
                sock?.end(undefined);
              } catch {
                /* ignore */
              }
              finish({
                valid: false,
                error: new Error(
                  "Pairing code nahi mil saka — WhatsApp ne mana kar diya, dobara try karein."
                ),
              });
            }
          } else if (connection === "close") {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === DisconnectReason.loggedOut || code === 401) {
              try {
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
              } catch {
                /* ignore */
              }
            }
            clearTimeout(timeout);
            finish({
              valid: false,
              error: new Error(
                "WhatsApp server se connect nahi ho saka, dobara try karein."
              ),
            });
          }
        });
      })
      .catch(() => {
        finish({
          valid: false,
          error: new Error("Pairing module me masla aa gaya, dobara try karein."),
        });
      });
  });
}

async function requestPairCode(phoneNumber) {
  // Per-attempt backoff: rapid reconnects on the same IP trigger WhatsApp
  // 429/405 rate limits that persist 15-40 min — space attempts out.
  const BACKOFF_MS = [3000, 10000];
  const MAX_ATTEMPTS = 3;
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    const result = await attemptPairing(phoneNumber, i);
    if (result.valid) return result.code;
    if (i < MAX_ATTEMPTS - 1) {
      const waitMs = BACKOFF_MS[i] || 10000;
      plog(`Attempt ${i + 1} failed, waiting ${waitMs / 1000}s before retry...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw new Error(
    "WhatsApp server se connect nahi ho saka, kuch der baad dobara try karein."
  );
}

// ---------- Rate limit ----------
const ipRequests = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const RATE = { max: 5, windowMs: 10 * 60 * 1000 };
  const entry = ipRequests.get(ip);
  if (!entry || entry.resetAt <= now) {
    ipRequests.set(ip, { count: 1, resetAt: now + RATE.windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= RATE.max;
}

// ---------- Express app ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "pair_public")));

app.post("/api/pair", async (req, res) => {
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error:
        "Aap ne bohat zyada requests bheji hain. 10 minute baad dobara try karein.",
    });
  }
  const raw = String(req.body?.phoneNumber || "").trim().replace(/^\+/, "");
  if (!/^\d{10,15}$/.test(raw)) {
    return res.status(400).json({ error: "Sahi number daalein (jaise 93770909827)." });
  }
  try {
    const code = await requestPairCode(raw);
    res.json({ code, expiresInSeconds: 300 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Session API: bot fetches this to obtain the SAME session that was paired.
// If the obfuscated bot requests /session.json?id=X or /session?id=X, we return
// the creds captured by the pairing socket for that phone number.
app.get(["/session", "/session.json", "/api/session"], (req, res) => {
  const raw = String(req.query?.id || req.query?.phone || "").trim();
  const id = raw.endsWith(".json") ? raw.slice(0, -5) : raw;
  const creds = id ? credsByNumber.get(id) : null;
  res.json({
    status: !!creds,
    data: creds ? { sessionId: JSON.stringify(creds.creds) } : null,
    error: creds ? null : "No session yet. Pehle pairing code se pair karein.",
  });
});

// Fallback: serve the pairing page
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "pair_public", "index.html"));
});

function startPairServer() {
  app.listen(PORT, () => {
    plog(`Pairing web on :${PORT}  https://<railway-domain>/`);
  });
}

module.exports = { startPairServer, requestPairCode, credsByNumber };

// Run directly: node pair.js
if (require.main === module) {
  startPairServer();
}

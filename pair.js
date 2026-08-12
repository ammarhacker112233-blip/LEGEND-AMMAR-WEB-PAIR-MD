// 🕷️ LEGEND-AMMAR — Built-in Web Pairing Server (v2)
// Chalta hai bot ke saath hi usi Railway domain par.
// Page : https://<railway-domain>/
// Code : POST /api/pair  (phoneNumber)  → pairing code + server socket 5 min zinda rehta hai
// Sess : GET  /session?id=<phone>  → bot is ko fetch karke SAME session se chalta hai
//
// v2 FIX: pehle code milte hi socket band ho jata tha — is liye WhatsApp ki
// session kabhi capture nahi hoti thi. Ab code ke baad socket 5 minute zinda
// rehta hai; jab user phone par code dalta hai to creds.update me full session
// aa jati hai aur /session se bot ko mil jati hai.
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
const PORT = Number(process.env.PAIR_PORT || process.env.PORT || 8000);
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

// ---------- Live pairing sockets: number → {sock, until, timer} ----------
const pendingByNumber = (global.__pendingByNumber =
  global.__pendingByNumber || new Map());

// KEEPER_MS: code entry ke baad WhatsApp tak creds pohanchne ka waqt (5 min).
const KEEPER_MS = 5 * 60 * 1000;

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
// Baileys issue #2370 confirmed "Mac OS" platform also resolves 405.
const BROWSER_VARIANTS = [
  ["Mac OS", "Desktop", "110.0.5481.177"],
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

/**
 * WhatsApp side ki session capture karta hai.
 * Jab user phone par code dalta hai to creds.update me identityKey aati hai —
 * tab session complete maani jati hai aur socket band kar dete hain (taake
 * baad me bot usi session ko safely connect kar sake).
 */
function captureCreds(phoneNumber, updatedCreds) {
  if (!updatedCreds || typeof updatedCreds !== "object") return false;
  const entry = credsByNumber.get(phoneNumber) || { creds: {} };
  Object.assign(entry.creds, updatedCreds);
  credsByNumber.set(phoneNumber, entry);
  const complete = !!(
    updatedCreds.identityKey && updatedCreds.registrationId !== undefined
  );
  if (complete) {
    plog("✅ Session COMPLETE for", phoneNumber, "— socket band, bot le jayega.");
  }
  return complete;
}

function endPending(phoneNumber, reason) {
  const pending = pendingByNumber.get(phoneNumber);
  if (!pending) return;
  pendingByNumber.delete(phoneNumber);
  try {
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.sock?.ws) pending.sock.ws?.end?.();
    pending.sock?.end?.(undefined);
  } catch {
    /* ignore */
  }
  plog(`Pending socket ended for ${phoneNumber}: ${reason}`);
}

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
      .then(async ({ state, saveCreds }) => {
        // Wipe the persisted auth dir before every pairing attempt so each
        // attempt starts with a clean identity — stale creds are a known
        // trigger for 405/loggedOut on WhatsApp's side.
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          fs.mkdirSync(AUTH_DIR, { recursive: true });
        } catch {
          /* ignore */
        }
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
          if (captureCreds(phoneNumber, updatedCreds)) {
            // Pairing complete — socket ka kaam ho gaya, band karo.
            endPending(phoneNumber, "pairing complete");
          }
        });

        const hardTimeout = setTimeout(() => {
          endPending(phoneNumber, "keeper timeout (5 min)");
          if (!resolved)
            finish({
              valid: false,
              error: new Error(
                "WhatsApp server se connect nahi ho saka, dobara try karein."
              ),
            });
        }, 30000 + KEEPER_MS);

        // v2: socket zinda rakhna (keeper) — pehle yahan 30s baad band kar dete the.
        const pending = pendingByNumber.get(phoneNumber) || {};
        if (pending.timer) clearTimeout(pending.timer);
        pending.sock = sock;
        pending.timer = hardTimeout;
        pendingByNumber.set(phoneNumber, pending);

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
              clearTimeout(hardTimeout);
              // v2: code milne ke baad socket band NAHI karte — WhatsApp ke
              // creds aane tak (ya 5 min tak) zinda rehta hai.
              hardTimeout.ref?.();
              const codeStr = String(code).padStart(8, "0");
              plog("Pairing code generated for", phoneNumber, "— socket alive 5 min");
              finish({ valid: true, code: codeStr });
            } catch {
              clearTimeout(hardTimeout);
              endPending(phoneNumber, "code request failed");
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
            clearTimeout(hardTimeout);
            endPending(phoneNumber, `connection close (${code ?? "?"})`);
            if (!resolved)
              finish({
                valid: false,
                error: new Error(
                  "WhatsApp server se connect nahi ho saka, dobara try karein."
                ),
              });
          } else if (connection === "open") {
            plog("Socket OPEN for", phoneNumber);
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

// Request logger: Railway ke logs me har request ka URL + query dikhayega —
// is se pata chalega ke obfuscated bot session ke liye exactly kis path ko
// hit karta hai (agar /session se alag hua to humein pata chal jayega).
app.use((req, _res, next) => {
  const ua = String(req.headers["user-agent"] || "").slice(0, 80);
  if (/node|baileys|got|undici|axios/i.test(ua) || req.originalUrl.includes("session")) {
    plog(`REQ ${req.method} ${req.originalUrl} UA=${ua}`);
  }
  next();
});
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

/**
 * Pairing ki live halat: page se puchna ke "code ka intezar hai ya nahi".
 * GET /api/pair/status?id=<phone> → {waiting: true|false}
 */
app.get(["/pair.log", "/pair.log.json", "/api/debug/logs"], (_req, res) => {
  try {
    const lines = fs
      .readFileSync(path.join(__dirname, "pair.log"), "utf8")
      .trim()
      .split("\n")
      .slice(-300);
    res.type("json").json({ lines });
  } catch {
    res.json({ lines: [] });
  }
});

app.get("/api/pair/status", (req, res) => {
  const id = String(req.query?.id || "").trim();
  res.json({ waiting: !!id && !!pendingByNumber.get(id) });
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
    data: creds
      ? {
          // Canonical JAWAD-family format: base64 of creds.json so that any
          // fork (Khan/KhanXmd/Jawad) can load it with its own auth decoder.
          sessionId:
            "LEGEND-AMMAR:~" +
            Buffer.from(JSON.stringify(creds.creds)).toString("base64"),
          credsJson: JSON.stringify(creds.creds),
        }
      : null,
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

module.exports = { startPairServer, requestPairCode, credsByNumber, pendingByNumber };

// Run directly: node pair.js
if (require.main === module) {
  startPairServer();
}

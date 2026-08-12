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
// Bot ke liye SESSION_ID file (IK~ format) — TOP par const taake hoisting
// issue na aaye jab restore ke dauran exportSessionIdForBot bulaya jaye.
const SESSION_ID_FILE = path.join(__dirname, "SESSION_ID.txt");

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

// Boot-time persistence: deploy/restart ke baad bhi captured sessions
// zinda rahen. MultiFileAuthState ne .pair-auth/creds.json me save kiya
// hota hai — us ko number-keyed Map me wapas load kar lo.
function rehydrateStoredCreds() {
  const credsFile = path.join(AUTH_DIR, "creds.json");
  try {
    if (!fs.existsSync(credsFile)) return;
    const raw = JSON.parse(fs.readFileSync(credsFile, "utf8"));
    // creds.me.id = "93770909827:XX@s.whatsapp.net" — number nikalo.
    const me = raw?.me?.id;
    const num = me ? String(me).split(":")[0] : null;
    const phone = num && /^\d{10,15}$/.test(num) ? num : null;
    if (phone) {
      credsByNumber.set(phone, { creds: raw, restored: true });
      plog("✅ Stored session restored from disk for", phone);
    } else {
      // Number anjaan hai — phir bhi pehle available number par rakho taake
      // bot us ko utha sake; /session khali id par bhi serve karta hai.
      const any = credsByNumber.keys().next().value;
      credsByNumber.set(any || "_any", { creds: raw, restored: true });
      plog("⚠️ Stored session restored (number unknown), serving on any id");
    }
  } catch (e) {
    plog("⚠️ Could not rehydrate stored creds:", e?.message || e);
  }
  // Bot ko sirf COMPLETE session do — adhuri creds se connection fail hota hai.
  // Main creds incomplete hon to backup (.pair-auth-backup) check karo.
  const cur = credsByNumber.size ? [...credsByNumber.values()][0]?.creds : null;
  if (sessionIsComplete(cur)) {
    exportSessionIdForBot(cur);
  } else {
    try {
      const bak = path.join(__dirname, ".pair-auth-backup", "creds.json");
      if (fs.existsSync(bak)) {
        const raw = JSON.parse(fs.readFileSync(bak, "utf8"));
        if (sessionIsComplete(raw)) {
          plog("✅ Complete session restored from backup for bot");
          exportSessionIdForBot(raw);
        }
      }
    } catch { /* ignore */ }
  }
}
rehydrateStoredCreds();

// ---------- SESSION_ID export (IK~ format for the bot) ----------
// Bot ka index.js SESSION_ID env variable maangta hai, format:
//   IK~base64(gzip(creds.json))
// Jab bhi session capture ya restore ho, yeh file likh do — start.sh ise
// bot ko env me de dega. Bot ko /session fetch karne ki zaroorat nahi.
// (SESSION_ID_FILE const ab file ke top par defined hai.)
function exportSessionIdForBot(creds) {
  try {
    const zlib = require("zlib");
    const payload = zlib
      .gzipSync(JSON.stringify(creds))
      .toString("base64");
    fs.writeFileSync(SESSION_ID_FILE, `IK~${payload}`);
    plog("✅ SESSION_ID.txt exported (IK~ format,", payload.length, "chars)");
  } catch (e) {
    plog("⚠️ Could not export SESSION_ID.txt:", e?.message || e);
  }
}
if (credsByNumber.size) exportSessionIdForBot([...credsByNumber.values()][0].creds);
// NOTE: /sessionid handler registered with app below (after `const app`).
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
  // Ubuntu Chrome pehle — datacenter IPs par 428 (link reject) sab se kam
  // milta hai; Mac Desktop par WhatsApp zyada reject karta hai.
  ["Ubuntu", "Chrome", "20.0.04"],
  ["Chrome", "Windows", "110.0.5481.177"],
  ["Mac OS", "Desktop", "110.0.5481.177"],
];
// Per-phone concurrency: agar ek number ka socket abhi zinda hai to naya
// request mana karo — baar baar dabane se WhatsApp 428 deta hai.
const lastPairAt = new Map();

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
// Session "complete" = identity + account info dono aa gaye — tabhi WhatsApp
// connection ke qabil hoti hai. Adhuri creds (sirf noiseKey waghaira) se bot
// connect NAHI ho sakta — is liye bot ko sirf complete session denge.
function sessionIsComplete(creds) {
  return !!(
    creds && creds.identityKey && creds.account && creds.registrationId !== undefined
  );
}
function captureCreds(phoneNumber, updatedCreds) {
  if (!updatedCreds || typeof updatedCreds !== "object") return false;
  const entry = credsByNumber.get(phoneNumber) || { creds: {} };
  Object.assign(entry.creds, updatedCreds);
  credsByNumber.set(phoneNumber, entry);
  const complete = sessionIsComplete(entry.creds);
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
          // Stored session ka backup pehle le lo — naya attempt purani
          // session ko nahi bhoolna chahiye (session complete hone se pehle
          // koi nayi pairing ka attempt aaye to backup se restore hoga).
          // Sirf COMPLETE session ko backup karo — partial creds kabhi bhi
          // achhi session ko override na kare.
          const credsFile = path.join(AUTH_DIR, "creds.json");
          if (fs.existsSync(credsFile)) {
            try {
              const existing = JSON.parse(fs.readFileSync(credsFile, "utf8"));
              if (sessionIsComplete(existing)) {
                fs.mkdirSync(path.join(__dirname, ".pair-auth-backup"), { recursive: true });
                fs.copyFileSync(
                  credsFile,
                  path.join(__dirname, ".pair-auth-backup", "creds.json")
                );
                plog("✅ Good session backed up before wipe");
              }
            } catch { /* ignore */ }
          }
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          fs.mkdirSync(AUTH_DIR, { recursive: true });
        } catch {
          /* ignore */
        }
        // Rotate browser fingerprint per attempt (405/428 fix on hosted IPs):
        // attempt 1 = Ubuntu Chrome (sab se zyada reliable), attempt 2 =
        // Chrome Windows. Mac Desktop bilkul use nahi hota.
        const browser = BROWSER_VARIANTS[Math.min(attempt, 1)];
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
          // Sirf COMPLETE session bot ko do — partial creds se bot connect
          // nahi ho sakta (WhatsApp identity reject kar deta hai).
          const cur = credsByNumber.get(phoneNumber)?.creds;
          if (sessionIsComplete(cur)) exportSessionIdForBot(cur);
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

// ---------- Circuit breaker: repeated failures = IP rate window active ----------
// Har fail hone wala attempt WhatsApp ke 405/428 window ko REFRESH kar deta
// hai. Is liye jaldi retry karne se block LAMBA hota jaata hai. Rule:
//  2nd fail hone par is IP par 5 MINUTE ka sakht cooldown (koi attempt nahi),
//  jisse window khud expire ho sake. Server restart ya deploy se counter reset.
const FAIL_STAMPS = [];
const COOLDOWN_MS = 5 * 60 * 1000;
function isCoolingDown() {
  const now = Date.now();
  // sirf pichle COOLDOWN_MS me hone wale 2 fails count karo
  const recent = FAIL_STAMPS.filter((t) => now - t < COOLDOWN_MS);
  if (recent.length >= 2) {
    const oldest = recent[0];
    const remaining = COOLDOWN_MS - (now - oldest);
    plog(
      `IP cooldown active: WhatsApp rate window abhi zinda hai — ${Math.ceil(
        remaining / 60000
      )} min baad dobara try karein.`
    );
    return remaining;
  }
  return 0;
}
async function requestPairCode(phoneNumber) {
  const remaining = isCoolingDown();
  if (remaining > 0) {
    throw new Error(
      `WhatsApp is waqt is server ke IP ko mana kar raha hai. ${Math.ceil(
        remaining / 60000
      )} minute ruk kar dobara try karein — jaldi-jaldi dabane se block aur lamba ho jaata hai.`
    );
  }
  // Per-attempt backoff: rapid reconnects on the same IP trigger WhatsApp
  // 429/405 rate limits — space attempts out (longer = safer).
  // Per-phone concurrency guard: ek number ke liye sirf ek live pairing
  // ho sakti hai. Doosra dabane wala foran message paayega — baar baar
  // dabane se WhatsApp 428 deta hai aur purana code bhi expire kar deta hai.
  const lastAt = lastPairAt.get(phoneNumber) || 0;
  const pending = pendingByNumber.get(phoneNumber);
  const guard = Date.now() - lastAt < 90000 || (pending && pending.sock);
  if (guard && Date.now() - lastAt < 90000) {
    const wait = Math.ceil((90000 - (Date.now() - lastAt)) / 1000);
    throw new Error(
      `Is number ke liye pehle se ek code zinda hai — dobara mat dabayein! ${wait}s baad code purana ho jayega, tab naya maang sakte hain.`
    );
  }
  lastPairAt.set(phoneNumber, Date.now());
  const BACKOFF_MS = [5000, 15000];
  const MAX_ATTEMPTS = 2;
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    const result = await attemptPairing(phoneNumber, i);
    if (result.valid) return result.code;
    FAIL_STAMPS.push(Date.now());
    if (i < MAX_ATTEMPTS - 1) {
      const waitMs = BACKOFF_MS[i] || 15000;
      plog(`Attempt ${i + 1} failed, waiting ${waitMs / 1000}s before retry...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  const next = isCoolingDown();
  if (next > 0) {
    throw new Error(
      `WhatsApp server is server ke IP ko abhi mana kar raha hai (datacenter block — temporary). ${Math.ceil(
        next / 60000
      )} minute ruk kar dobara try karein — jaldi-jaldi dabane se block aur lamba ho jaata hai.`
    );
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
  let creds = id ? credsByNumber.get(id) : null;
  // Fallback: exact number match na mile to jo bhi stored session ho de do —
  // bot apne number ki session hi expect karta hai aur restore hamesha ek hi
  // number ki hoti hai.
  if (!creds && credsByNumber.size) {
    for (const [k, v] of credsByNumber) {
      if (k.startsWith("_") && v?.creds?.me) { creds = v; break; }
    }
  }
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

// ---------- Session ingest: backup portal (jawadtech.vercel.app) ya kisi aur
// source se mila base64 session seedha bot ke liye likho ----------
// Accepted formats (body: {session: "..."} POST, ya ?session= GET):
//   1. IK~base64(gzip(creds.json))        — humara apna format
//   2. LEGEND-AMMAR:~base64(creds.json)   — JAWAD-family canonical
//   3. plain base64(creds.json)           — raw creds
// Bot ka index.js creds ko `session/creds.json` me rakhta hai — yahan seedha
// wohi file likho taake next start par bot isi session se chalay.
app.post("/api/ingest", (req, res) => {
  const raw = String(req.body?.session || "").trim();
  try {
    const zlib = require("zlib");
    let creds = null;
    if (raw.startsWith("IK~")) {
      creds = JSON.parse(zlib.gunzipSync(Buffer.from(raw.slice(3), "base64")).toString());
    } else {
      const payload = raw.includes(":~") ? raw.split(":~")[1] : raw;
      creds = JSON.parse(Buffer.from(payload, "base64").toString());
    }
    // Completeness: Baileys-native creds.json (JAWAD-MD format) rakhta hai
    // identityKey top-level ya signalIdentities[0].identityKey me.
    const hasIdentity =
      !!creds?.identityKey ||
      Array.isArray(creds?.signalIdentities) && creds.signalIdentities.length > 0;
    if (!creds?.me?.id || !creds?.noiseKey || !hasIdentity) {
      throw new Error("creds.json incomplete (me/noiseKey/identity missing)");
    }
    const sessionDir = path.join(__dirname, "session");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "creds.json"),
      JSON.stringify(creds, null, 2)
    );
    // Bot ke liye IK~ file bhi — pair.js restart / next deploy par use hogi.
    exportSessionIdForBot(creds);
    plog("✅ Session ingested for", creds.me.id);
    res.json({
      status: true,
      data: { number: String(creds.me.id).split(":")[0] },
    });
  } catch (e) {
    plog("❌ Ingest failed:", e?.message || e);
    res.status(400).json({
      status: false,
      error: "Session format sahi nahi — base64(creds.json) ya IK~... paste karein.",
    });
  }
});

// Session-ID endpoint (IK~ format) — start.sh ise bot ke env me deta hai.
app.get("/sessionid", (_req, res) => {
  try {
    const txt = fs.readFileSync(SESSION_ID_FILE, "utf8").trim();
    res.json({ status: true, data: { sessionId: txt } });
  } catch {
    res.json({ status: false, data: null, error: "No session yet. Pehle pairing code se pair karein." });
  }
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

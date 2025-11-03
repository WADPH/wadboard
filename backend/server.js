// Wadboard API with session auth
//
// Data model on disk (data.json):
// db = {
//   services: [
//     { id, name, openUrl, checkUrl, method, notes,
//       lastStatus, lastChecked }
//       // method = "http" | "ping"
//   ],
//   links: [
//     { id, title, url, icon, notes }
//   ],
//   wol: [
//     { id, name, host, user, pass, scriptId, notes,
//       lastRun, lastResult }
//   ]
// }
//
// Security model:
// - Client sends password once to /api/login
// - Server compares with ADMIN_PASSWORD (kept ONLY here)
// - If ok -> server creates a session token and sets cookie adminToken (HttpOnly, SameSite=Strict)
// - For any modifying endpoint we require a valid session via requireAdmin()
// - /api/state returns sanitized data if not admin (WOL creds hidden)
// - No admin password is ever sent to frontend
//
// Requirements in package.json:
//   "type": "module",
//   deps: express, cookie-parser, node-fetch
//
// Termux note for "ping":
// child_process.exec('ping -c 1 -w 2 host') must work in your Termux.
// If ping is blocked, "ping" health check will always be DOWN.

import express from "express";
import cookieParser from "cookie-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import https from "https";
import { exec } from "child_process";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DATA_FILE = path.join(__dirname, "data.json");

// -----------------------
// Admin password (change this)
// -----------------------
const ADMIN_PASSWORD = "wadboard";

// -----------------------
// Session store (in-memory)
// -----------------------
const sessions = {}; // { token: { createdAt: number } }
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

function createSession() {
  // generate random 32-byte hex token
  const token = crypto.randomBytes(32).toString("hex");
  sessions[token] = { createdAt: Date.now() };
  return token;
}

function getSession(req) {
  // read and validate session by cookie
  const token = req.cookies.adminToken;
  if (!token) return null;
  const sess = sessions[token];
  if (!sess) return null;

  // expire old sessions
  if (Date.now() - sess.createdAt > SESSION_TTL_MS) {
    delete sessions[token];
    return null;
  }
  return { token, createdAt: sess.createdAt };
}

function requireAdmin(req, res, next) {
  // middleware to protect sensitive routes
  const s = getSession(req);
  if (!s) {
    return res.status(401).json({ error: "unauthorized" });
  }
  req.sessionToken = s.token;
  next();
}

// -----------------------
// In-memory DB
// -----------------------
let db = {
  services: [],
  links: [],
  wol: []
};

// Load DB from disk
function loadDB() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    db = JSON.parse(raw);

    // normalize services
    db.services = Array.isArray(db.services) ? db.services : [];
    db.services.forEach(svc => {
      if (svc.notes === undefined)       svc.notes = "";
      if (svc.lastStatus === undefined)  svc.lastStatus = "unknown";
      if (svc.lastChecked === undefined) svc.lastChecked = null;
      if (svc.method === undefined)      svc.method = "http"; // default
    });

    // normalize links
    db.links = Array.isArray(db.links) ? db.links : [];
    db.links.forEach(lnk => {
      if (lnk.notes === undefined) lnk.notes = "";
      if (lnk.icon === undefined)  lnk.icon = "🔗";
    });

    // normalize wol
    db.wol = Array.isArray(db.wol) ? db.wol : [];
    db.wol.forEach(task => {
      if (task.notes === undefined)      task.notes = "";
      if (task.lastRun === undefined)    task.lastRun = null;
      if (task.lastResult === undefined) task.lastResult = "never";
    });

  } catch (err) {
    console.error("Failed to load DB file. Using empty DB.");
    db = { services: [], links: [], wol: [] };
  }
}

// Save DB to disk
function saveDB() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
}

// Generate unique id
function makeId(prefix) {
  return prefix + "-" + Date.now();
}

// -----------------------
// Health check helpers
// -----------------------

// HTTPS agent that ignores self-signed certs
const insecureAgent = new https.Agent({
  rejectUnauthorized: false
});

// Decide if HTTP status is "UP"
function isHealthyHttpStatus(code) {
  // 200-399 -> UP
  // 401/403 -> UP (alive but needs auth)
  if ((code >= 200 && code < 400) || code === 401 || code === 403) {
    return true;
  }
  return false;
}

// Perform HTTP(S) GET (with optional insecure TLS)
async function httpAlive(urlToCheck) {
  // returns true if considered UP
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  async function tryOnce(allowInsecure) {
    const opts = { method: "GET", signal: controller.signal };
    if (allowInsecure && urlToCheck.startsWith("https")) {
      opts.agent = insecureAgent;
    }
    const res = await fetch(urlToCheck, opts);
    return isHealthyHttpStatus(res.status);
  }

  try {
    // normal attempt
    const ok1 = await tryOnce(false);
    if (ok1) {
      clearTimeout(timer);
      return true;
    }
    // second attempt with insecure TLS
    try {
      const ok2 = await tryOnce(true);
      clearTimeout(timer);
      return ok2;
    } catch {
      clearTimeout(timer);
      return false;
    }
  } catch {
    // first attempt threw
    try {
      const ok2 = await tryOnce(true);
      clearTimeout(timer);
      return ok2;
    } catch {
      clearTimeout(timer);
      return false;
    }
  }
}

// Ping via system ping (ICMP)
function pingHostOnce(host) {
  return new Promise(resolve => {
    // -c 1 : send 1 packet
    // -w 2 : 2s timeout
    exec(`ping -c 1 -w 2 ${host}`, (error) => {
      if (error) resolve(false);
      else resolve(true);
    });
  });
}

// Probe one service
async function probeService(svc) {
  // svc.method:
  //   "http" -> GET svc.checkUrl
  //   "ping" -> ICMP ping svc.checkUrl (hostname/IP)
  let status = "DOWN";

  if (svc.method === "ping") {
    try {
      const alive = await pingHostOnce(svc.checkUrl);
      status = alive ? "UP" : "DOWN";
    } catch {
      status = "DOWN";
    }
  } else {
    try {
      const ok = await httpAlive(svc.checkUrl);
      status = ok ? "UP" : "DOWN";
    } catch {
      status = "DOWN";
    }
  }

  svc.lastStatus  = status;
  svc.lastChecked = new Date().toISOString();
}

// Probe all services periodically
async function healthCheckAll() {
  try {
    for (const svc of db.services) {
      await probeService(svc);
    }
    saveDB();
  } catch (err) {
    console.error("healthCheckAll error:", err);
  }
}

// -----------------------
// Execute WOL task (MikroTik script)
// -----------------------
//
// We call:
// POST http://<host>/rest/system/script/run
// Authorization: Basic base64(user:pass)
// Body: { ".id":"*<scriptId>" }
//
// We store lastRun and lastResult in db.
async function executeWOLTask(task) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);

  let result = "error";
  let okFlag = false;

  try {
    const creds = Buffer.from(`${task.user}:${task.pass}`).toString("base64");
    const payload = { ".id": `*${task.scriptId}` };

    const res = await fetch(`http://${task.host}/rest/system/script/run`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Basic ${creds}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (res.status === 200) {
      okFlag = true;
      result = "ok";
    } else {
      result = "http_" + res.status;
    }
  } catch {
    result = "error";
  } finally {
    clearTimeout(timer);
  }

  task.lastRun    = new Date().toISOString();
  task.lastResult = result;
  saveDB();

  return { ok: okFlag, result };
}

// -----------------------
// Helpers to sanitize state for clients
// -----------------------
//
// If user is not admin we do NOT expose router creds etc.
// We only send minimal WOL info (name, notes, lastRun, lastResult).
function sanitizeForClient(isAdmin) {
  if (isAdmin) {
    return db;
  }

  return {
    services: db.services.map(s => ({ ...s })),
    links: db.links.map(l => ({ ...l })),
    wol: db.wol.map(w => ({
      id:         w.id,
      name:       w.name,
      notes:      w.notes || "",
      lastRun:    w.lastRun || null,
      lastResult: w.lastResult || "never"
      // host/user/pass/scriptId are hidden if not admin
    }))
  };
}

// -----------------------
// Express app
// -----------------------
const app = express();

// Parse JSON and cookies
app.use(express.json());
app.use(cookieParser());

// -----------------------
// Auth endpoints
// -----------------------

// POST /api/login  {password}
// Sets adminToken cookie if password is correct
app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "bad password" });
  }

  const token = createSession();

  // Set HttpOnly cookie. SameSite=Strict blocks CSRF from other sites.
  // secure:false so it also works over plain HTTP in LAN. In production
  // behind HTTPS you SHOULD set secure:true.
  res.cookie("adminToken", token, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: SESSION_TTL_MS,
    secure: false
  });

  return res.json({ ok: true });
});

// POST /api/logout
// Clears the session cookie and deletes server-side session
app.post("/api/logout", (req, res) => {
  const token = req.cookies.adminToken;
  if (token) {
    delete sessions[token];
  }

  res.clearCookie("adminToken", {
    sameSite: "strict",
    secure: false
  });

  return res.json({ ok: true });
});

// -----------------------
// Read-only state
// -----------------------
app.get("/api/state", (req, res) => {
  const isAdmin = !!getSession(req);
  res.json(sanitizeForClient(isAdmin));
});

// -----------------------
// SERVICES CRUD (protected)
// -----------------------

// Create service
app.post("/api/service", requireAdmin, (req, res) => {
  const { name, openUrl, checkUrl, method, notes } = req.body || {};
  if (!name || !openUrl || !checkUrl) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const safeMethod = (method === "ping" || method === "http") ? method : "http";

  const newSvc = {
    id: makeId("svc"),
    name,
    openUrl,
    checkUrl,
    method: safeMethod,
    notes: notes || "",
    lastStatus: "unknown",
    lastChecked: null
  };

  db.services.push(newSvc);
  saveDB();
  res.json(newSvc);
});

// Update service
app.put("/api/service/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  const svc = db.services.find(s => s.id === id);
  if (!svc) return res.status(404).json({ error: "Service not found" });

  const { name, openUrl, checkUrl, method, notes } = req.body || {};
  if (name      !== undefined) svc.name      = name;
  if (openUrl   !== undefined) svc.openUrl   = openUrl;
  if (checkUrl  !== undefined) svc.checkUrl  = checkUrl;
  if (notes     !== undefined) svc.notes     = notes;
  if (method    !== undefined) {
    svc.method = (method === "ping" || method === "http") ? method : "http";
  }

  saveDB();
  res.json(svc);
});

// Delete service
app.delete("/api/service/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  db.services = db.services.filter(s => s.id !== id);
  saveDB();
  res.json({ ok: true });
});

// Reorder services
app.put("/api/reorder/services", requireAdmin, (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: "order must be array" });
  }

  const map = new Map(db.services.map(s => [s.id, s]));
  const newList = [];
  for (const sid of order) {
    if (map.has(sid)) {
      newList.push(map.get(sid));
      map.delete(sid);
    }
  }
  for (const [, svc] of map) newList.push(svc);

  db.services = newList;
  saveDB();
  res.json({ ok: true });
});

// -----------------------
// LINKS CRUD (protected)
// -----------------------

app.post("/api/link", requireAdmin, (req, res) => {
  const { title, url, icon, notes } = req.body || {};
  if (!title || !url) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const newLink = {
    id: makeId("link"),
    title,
    url,
    icon: icon || "🔗",
    notes: notes || ""
  };

  db.links.push(newLink);
  saveDB();
  res.json(newLink);
});

app.put("/api/link/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  const lnk = db.links.find(l => l.id === id);
  if (!lnk) return res.status(404).json({ error: "Link not found" });

  const { title, url, icon, notes } = req.body || {};
  if (title !== undefined) lnk.title = title;
  if (url   !== undefined) lnk.url   = url;
  if (icon  !== undefined) lnk.icon  = icon;
  if (notes !== undefined) lnk.notes = notes;

  saveDB();
  res.json(lnk);
});

app.delete("/api/link/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  db.links = db.links.filter(l => l.id !== id);
  saveDB();
  res.json({ ok: true });
});

app.put("/api/reorder/links", requireAdmin, (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: "order must be array" });
  }

  const map = new Map(db.links.map(l => [l.id, l]));
  const newList = [];
  for (const lid of order) {
    if (map.has(lid)) {
      newList.push(map.get(lid));
      map.delete(lid);
    }
  }
  for (const [, lnk] of map) newList.push(lnk);

  db.links = newList;
  saveDB();
  res.json({ ok: true });
});

// -----------------------
// WOL CRUD / RUN (protected)
// -----------------------

app.post("/api/wol", requireAdmin, (req, res) => {
  const { name, host, user, pass, scriptId, notes } = req.body || {};
  if (!name || !host || !user || !pass || !scriptId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const newTask = {
    id: makeId("wol"),
    name,
    host,
    user,
    pass,
    scriptId,
    notes: notes || "",
    lastRun: null,
    lastResult: "never"
  };

  db.wol.push(newTask);
  saveDB();
  res.json(newTask);
});

app.put("/api/wol/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  const task = db.wol.find(a => a.id === id);
  if (!task) return res.status(404).json({ error: "WOL task not found" });

  const { name, host, user, pass, scriptId, notes } = req.body || {};
  if (name     !== undefined) task.name     = name;
  if (host     !== undefined) task.host     = host;
  if (user     !== undefined) task.user     = user;
  if (pass     !== undefined) task.pass     = pass;
  if (scriptId !== undefined) task.scriptId = scriptId;
  if (notes    !== undefined) task.notes    = notes;

  saveDB();
  res.json(task);
});

app.delete("/api/wol/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  db.wol = db.wol.filter(a => a.id !== id);
  saveDB();
  res.json({ ok: true });
});

app.put("/api/reorder/wol", requireAdmin, (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: "order must be array" });
  }

  const map = new Map(db.wol.map(a => [a.id, a]));
  const newList = [];
  for (const wid of order) {
    if (map.has(wid)) {
      newList.push(map.get(wid));
      map.delete(wid);
    }
  }
  for (const [, task] of map) newList.push(task);

  db.wol = newList;
  saveDB();
  res.json({ ok: true });
});

// Run WOL (execute MikroTik script)
app.post("/api/wol/:id/run", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const task = db.wol.find(a => a.id === id);
  if (!task) return res.status(404).json({ error: "WOL task not found" });

  const result = await executeWOLTask(task);
  res.json(result);
});

// -----------------------
// Start server
// -----------------------
const PORT = 4000;

loadDB();

// initial health probe
healthCheckAll().catch(err => {
  console.error("initial healthCheckAll error:", err);
});

app.listen(PORT, () => {
  console.log("Wadboard API running on port " + PORT);
});

// periodic health checks
setInterval(() => {
  healthCheckAll().catch(err => {
    console.error("interval healthCheckAll error:", err);
  });
}, 10000);

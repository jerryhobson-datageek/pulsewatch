'use strict';

const http   = require('http');
const https  = require('https');
const net    = require('net');
const tls    = require('tls');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { DatabaseSync } = require('node:sqlite');

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_PATH      = path.join(__dirname, 'config.json');
const MAINTENANCE_PATH = path.join(__dirname, 'maintenance.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();
const PORT             = process.env.PORT || config.port || 3000;
const HISTORY_SIZE     = 60;
const DEFAULT_TIMEOUT  = 5000;
const SESSION_TTL      = 24 * 60 * 60 * 1000; // 24 hours
const SSL_INTERVAL     = 6 * 60 * 60 * 1000;  // 6 hours
const SSL_WARNING_DAYS = config.sslWarningDays  ?? 30;
const SSL_CRITICAL_DAYS= config.sslCriticalDays ?? 7;

// ── SQLite history ────────────────────────────────────────────────────────────

const DB_PATH     = path.join(__dirname, 'history.db');
const HISTORY_DAYS = 30;

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS checks (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    svc_id INTEGER NOT NULL,
    status TEXT    NOT NULL,
    rt     INTEGER,
    ts     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_svc_ts ON checks(svc_id, ts);
`);
const stmtInsert  = db.prepare('INSERT INTO checks (svc_id, status, rt, ts) VALUES (?, ?, ?, ?)');
const stmtHistory = db.prepare('SELECT status, rt, ts FROM checks WHERE svc_id = ? ORDER BY ts DESC LIMIT ?');
const stmtPrune   = db.prepare('DELETE FROM checks WHERE ts < ?');

function pruneHistory() {
  stmtPrune.run(Date.now() - HISTORY_DAYS * 86_400_000);
}
pruneHistory();
setInterval(pruneHistory, 24 * 60 * 60 * 1000);

// ── Maintenance ───────────────────────────────────────────────────────────────

function loadMaintenance() {
  try { return JSON.parse(fs.readFileSync(MAINTENANCE_PATH, 'utf8')); }
  catch { return { windows: [] }; }
}

function saveMaintenance(data) {
  fs.writeFileSync(MAINTENANCE_PATH, JSON.stringify(data, null, 2));
}

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

function getActiveWindow(serviceId) {
  const now = Date.now();
  return loadMaintenance().windows.find(w =>
    w.serviceId === serviceId &&
    new Date(w.start).getTime() <= now &&
    new Date(w.end).getTime()   >= now
  ) || null;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

// sessions: Map<token, { username, role, createdAt }>
const sessions = new Map();

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) {
    sessions.delete(token);
    return null;
  }
  return s;
}

function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

// Returns session or sends 401/403 and returns null
function requireAuth(req, res, role = null) {
  const session = getSession(extractToken(req));
  if (!session) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return null;
  }
  if (role === 'admin' && session.role !== 'admin') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden — admin only' }));
    return null;
  }
  return session;
}

// ── Default credentials (first run) ──────────────────────────────────────────

function ensureCredentials() {
  config = loadConfig();
  if (config.credentials && config.credentials.length > 0) return;

  console.log('\n[Auth] No credentials found — creating defaults...');
  const adminSalt  = crypto.randomBytes(16).toString('hex');
  const viewerSalt = crypto.randomBytes(16).toString('hex');

  config.credentials = [
    {
      username: 'admin',
      role:     'admin',
      salt:     adminSalt,
      hash:     hashPassword('admin123', adminSalt),
    },
    {
      username: 'viewer',
      role:     'viewer',
      salt:     viewerSalt,
      hash:     hashPassword('viewer123', viewerSalt),
    },
  ];

  saveConfig(config);

  console.log('┌──────────────────────────────────────────┐');
  console.log('│  Default credentials created             │');
  console.log('│                                          │');
  console.log('│  Admin:   admin  / admin123              │');
  console.log('│  Viewer:  viewer / viewer123             │');
  console.log('│                                          │');
  console.log('│  ⚠  Change these after first login!     │');
  console.log('└──────────────────────────────────────────┘\n');
}

// ── Monitoring state ──────────────────────────────────────────────────────────

function isHTTPS(svc) {
  return svc.type !== 'TCP' && svc.url.startsWith('https://');
}

const state = {};
for (const svc of config.services) {
  state[svc.id] = {
    id:                svc.id,
    name:              svc.name,
    url:               svc.url,
    type:              svc.type || 'HTTP',
    status:            'pending',
    rt:                null,
    history:           stmtHistory.all(svc.id, HISTORY_SIZE).reverse(),
    lastCheck:         null,
    maintenance:       null,
    degradedThreshold: svc.degradedThreshold || null,
    ssl: isHTTPS(svc)
      ? { status: 'pending', daysLeft: null, expiry: null }
      : null,
  };
}

// ── SSL checker ───────────────────────────────────────────────────────────────

function checkSSL(hostname, port = 443) {
  return new Promise((resolve) => {
    const timeout = DEFAULT_TIMEOUT;
    const socket  = tls.connect(
      { host: hostname, port, servername: hostname, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        socket.destroy();
        if (!cert || !cert.valid_to) {
          return resolve({ status: 'error', daysLeft: null, expiry: null });
        }
        const expiry    = new Date(cert.valid_to);
        const daysLeft  = Math.floor((expiry - Date.now()) / 86_400_000);
        let   sslStatus = 'ok';
        if      (daysLeft <  0)                sslStatus = 'expired';
        else if (daysLeft <  SSL_CRITICAL_DAYS) sslStatus = 'critical';
        else if (daysLeft <  SSL_WARNING_DAYS)  sslStatus = 'warning';
        resolve({ status: sslStatus, daysLeft, expiry: expiry.toISOString() });
      }
    );
    socket.setTimeout(timeout, () => {
      socket.destroy();
      resolve({ status: 'error', daysLeft: null, expiry: null });
    });
    socket.on('error', () => resolve({ status: 'error', daysLeft: null, expiry: null }));
  });
}

async function runSSLCheck(svc) {
  if (!isHTTPS(svc) || svc.sslCheck === false) return;

  let parsed;
  try { parsed = new URL(svc.url); } catch { return; }

  const prev   = state[svc.id].ssl?.status;
  const result = await checkSSL(parsed.hostname, parseInt(parsed.port) || 443);
  state[svc.id].ssl = result;

  const icon = result.status === 'ok' ? '🔒' : result.status === 'warning' ? '⚠️ ' : '🔴';
  const days = result.daysLeft != null ? `${result.daysLeft}d` : 'err';
  console.log(`[SSL] ${icon} ${svc.name.padEnd(20)} ${result.status.padEnd(8)} ${days}`);

  // Alert on status change to warning/critical/expired
  if (prev && prev !== result.status && result.status !== 'ok' && result.status !== 'pending') {
    const msgs = {
      warning:  `SSL cert for ${svc.name} expires in ${result.daysLeft} days`,
      critical: `SSL cert for ${svc.name} expires in ${result.daysLeft} days — renew immediately`,
      expired:  `SSL cert for ${svc.name} has EXPIRED`,
      error:    `SSL check failed for ${svc.name}`,
    };
    console.warn(`[SSL ALERT] ${msgs[result.status]}`);
  }
}

// ── Checkers ──────────────────────────────────────────────────────────────────

function checkHTTP(svc) {
  return new Promise((resolve) => {
    const start = Date.now();
    let parsed;
    try { parsed = new URL(svc.url); }
    catch { return resolve({ status: 'down', rt: 0 }); }

    const lib     = parsed.protocol === 'https:' ? https : http;
    const timeout = svc.timeout || DEFAULT_TIMEOUT;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        timeout,
        headers:  { 'User-Agent': 'PulseWatch/1.0', Connection: 'close' },
      },
      (res) => {
        res.resume();
        const rt = Date.now() - start;
        resolve({ status: res.statusCode >= 200 && res.statusCode < 400 ? 'up' : 'down', rt });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 'down', rt: timeout }); });
    req.on('error',   () => resolve({ status: 'down', rt: Date.now() - start }));
    req.end();
  });
}

function checkTCP(svc) {
  return new Promise((resolve) => {
    const start   = Date.now();
    const timeout = svc.timeout || DEFAULT_TIMEOUT;
    const raw     = svc.url.replace(/^tcp:\/\//i, '');
    const colon   = raw.lastIndexOf(':');
    const host    = colon === -1 ? raw : raw.slice(0, colon);
    const port    = colon === -1 ? 80  : parseInt(raw.slice(colon + 1), 10);

    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.connect(port, host, () => {
      const rt = Date.now() - start;
      socket.destroy();
      resolve({ status: 'up', rt });
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ status: 'down', rt: timeout }); });
    socket.on('error',   () => resolve({ status: 'down', rt: Date.now() - start }));
  });
}

async function runCheck(svc) {
  let result;
  try {
    result = svc.type === 'TCP' ? await checkTCP(svc) : await checkHTTP(svc);
  } catch {
    result = { status: 'down', rt: 0 };
  }

  if (result.status === 'up' && svc.degradedThreshold && result.rt > svc.degradedThreshold) {
    result.status = 'degraded';
  }

  // Maintenance window overrides status and suppresses alerts
  const activeWindow = getActiveWindow(svc.id);
  if (activeWindow) result.status = 'maintenance';

  const d = state[svc.id];
  d.status      = result.status;
  d.rt          = result.status === 'maintenance' ? null : result.rt;
  d.lastCheck   = new Date().toISOString();
  d.maintenance = activeWindow
    ? { active: true, id: activeWindow.id, title: activeWindow.title, end: activeWindow.end }
    : null;
  const ts = Date.now();
  d.history.push({ status: result.status, rt: result.rt, ts });
  if (d.history.length > HISTORY_SIZE) d.history.shift();
  stmtInsert.run(svc.id, result.status, result.rt ?? null, ts);

  const icon = result.status === 'up' ? '✓' : result.status === 'maintenance' ? '🔧' : result.status === 'degraded' ? '⚠' : '✗';
  console.log(`[${d.lastCheck}] ${icon} ${svc.name.padEnd(20)} ${result.status.padEnd(12)} ${result.rt ?? '—'}ms`);
}

// Track intervals so we can stop monitoring a service on demand
const intervals = new Map(); // serviceId -> { check, ssl }

function startServiceMonitoring(svc, delay = 0) {
  const interval = (svc.interval || config.interval || 30) * 1000;
  setTimeout(() => {
    runCheck(svc);
    const checkId = setInterval(() => runCheck(svc), interval);
    let sslId = null;
    if (isHTTPS(svc) && svc.sslCheck !== false) {
      setTimeout(() => runSSLCheck(svc), 3000);
      sslId = setInterval(() => runSSLCheck(svc), SSL_INTERVAL);
    }
    intervals.set(svc.id, { check: checkId, ssl: sslId });
  }, delay);
}

function stopServiceMonitoring(serviceId) {
  const ids = intervals.get(serviceId);
  if (!ids) return;
  if (ids.check) clearInterval(ids.check);
  if (ids.ssl)   clearInterval(ids.ssl);
  intervals.delete(serviceId);
}

function startMonitoring() {
  config.services.forEach((svc, i) => startServiceMonitoring(svc, i * 600));
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) reject(new Error('Too large')); });
    req.on('end',  () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const INDEX_PATH = path.join(__dirname, 'index.html');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);

  // ── POST /api/login ────────────────────────────────────────────────────────
  if (pathname === '/api/login' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'Invalid JSON' }); }

    const { username, password } = body;
    if (!username || !password) return json(res, 400, { error: 'Username and password required' });

    config = loadConfig();
    const cred = (config.credentials || []).find(c => c.username === username);
    if (!cred) return json(res, 401, { error: 'Invalid credentials' });

    const attempt = hashPassword(password, cred.salt);
    if (attempt !== cred.hash) return json(res, 401, { error: 'Invalid credentials' });

    const token = generateToken();
    sessions.set(token, { username: cred.username, role: cred.role, createdAt: Date.now() });
    console.log(`[Auth] Login: ${cred.username} (${cred.role})`);
    return json(res, 200, { token, username: cred.username, role: cred.role });
  }

  // ── POST /api/logout ───────────────────────────────────────────────────────
  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = extractToken(req);
    if (token) {
      const s = sessions.get(token);
      if (s) console.log(`[Auth] Logout: ${s.username}`);
      sessions.delete(token);
    }
    return json(res, 200, { ok: true });
  }

  // ── GET /api/me ────────────────────────────────────────────────────────────
  if (pathname === '/api/me' && req.method === 'GET') {
    const session = requireAuth(req, res);
    if (!session) return;
    return json(res, 200, { username: session.username, role: session.role });
  }

  // ── GET /api/maintenance ──────────────────────────────────────────────────
  if (pathname === '/api/maintenance' && req.method === 'GET') {
    const session = requireAuth(req, res);
    if (!session) return;
    return json(res, 200, loadMaintenance());
  }

  // ── POST /api/maintenance ─────────────────────────────────────────────────
  if (pathname === '/api/maintenance' && req.method === 'POST') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'Invalid JSON' }); }

    const { serviceId, start, end, title, description } = body;
    if (!serviceId || !start || !end || !title)
      return json(res, 400, { error: 'serviceId, start, end and title are required' });
    if (new Date(end) <= new Date(start))
      return json(res, 400, { error: 'end must be after start' });

    config = loadConfig();
    const svcName = config.services.find(s => s.id === Number(serviceId))?.name || '';
    const win = {
      id:          generateId(),
      serviceId:   Number(serviceId),
      serviceName: svcName,
      title,
      description: description || '',
      start:       new Date(start).toISOString(),
      end:         new Date(end).toISOString(),
      createdBy:   session.username,
      createdAt:   new Date().toISOString(),
    };
    const data = loadMaintenance();
    data.windows.push(win);
    saveMaintenance(data);
    console.log(`[Maintenance] Scheduled: ${svcName} — ${title} (${win.start} → ${win.end})`);
    return json(res, 201, win);
  }

  // ── DELETE /api/maintenance/:id ───────────────────────────────────────────
  if (pathname.startsWith('/api/maintenance/') && req.method === 'DELETE') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    const id   = pathname.slice('/api/maintenance/'.length);
    const data = loadMaintenance();
    const idx  = data.windows.findIndex(w => w.id === id);
    if (idx === -1) return json(res, 404, { error: 'Window not found' });
    data.windows.splice(idx, 1);
    saveMaintenance(data);
    console.log(`[Maintenance] Deleted window ${id}`);
    return json(res, 200, { ok: true });
  }

  // ── GET /api/services (admin) ─────────────────────────────────────────────
  if (pathname === '/api/services' && req.method === 'GET') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    config = loadConfig();
    return json(res, 200, { services: config.services });
  }

  // ── POST /api/services (admin) — add new service ──────────────────────────
  if (pathname === '/api/services' && req.method === 'POST') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'Invalid JSON' }); }

    const { name, url, type, degradedThreshold, interval, sslCheck } = body;
    if (!name || !url || !type) return json(res, 400, { error: 'name, url and type are required' });
    if (!['HTTP', 'TCP'].includes(type)) return json(res, 400, { error: 'type must be HTTP or TCP' });

    config = loadConfig();
    const newId = (config.services.reduce((m, s) => Math.max(m, s.id), 0) || 0) + 1;
    const svc = {
      id: newId,
      name: name.trim(),
      url: url.trim(),
      type,
      ...(degradedThreshold ? { degradedThreshold: Number(degradedThreshold) } : {}),
      ...(interval          ? { interval:          Number(interval) }          : {}),
      ...(sslCheck === false ? { sslCheck: false } : {}),
    };
    config.services.push(svc);
    saveConfig(config);

    // Initialize state and start monitoring
    state[svc.id] = {
      id: svc.id, name: svc.name, url: svc.url, type: svc.type,
      status: 'pending', rt: null, history: [], lastCheck: null,
      maintenance: null,
      degradedThreshold: svc.degradedThreshold || null,
      ssl: isHTTPS(svc) ? { status: 'pending', daysLeft: null, expiry: null } : null,
    };
    startServiceMonitoring(svc);

    console.log(`[Services] Added: ${svc.name} (id=${svc.id}) by ${session.username}`);
    return json(res, 201, { service: svc });
  }

  // ── PUT /api/services/:id (admin) — update ────────────────────────────────
  if (pathname.startsWith('/api/services/') && req.method === 'PUT') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    const id = Number(pathname.slice('/api/services/'.length));
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'Invalid JSON' }); }

    config = loadConfig();
    const idx = config.services.findIndex(s => s.id === id);
    if (idx === -1) return json(res, 404, { error: 'Service not found' });
    const svc = config.services[idx];

    if (body.name !== undefined)              svc.name = String(body.name).trim();
    if (body.url  !== undefined)              svc.url  = String(body.url).trim();
    if (body.type !== undefined)              svc.type = body.type;
    if (body.degradedThreshold !== undefined) {
      if (body.degradedThreshold === null || body.degradedThreshold === '') delete svc.degradedThreshold;
      else svc.degradedThreshold = Number(body.degradedThreshold);
    }
    if (body.interval !== undefined) {
      if (body.interval === null || body.interval === '') delete svc.interval;
      else svc.interval = Number(body.interval);
    }
    if (body.sslCheck !== undefined) {
      if (body.sslCheck === false) svc.sslCheck = false;
      else delete svc.sslCheck;
    }
    saveConfig(config);

    // Update state in-place (preserve history)
    const s = state[svc.id];
    s.name = svc.name; s.url = svc.url; s.type = svc.type;
    s.degradedThreshold = svc.degradedThreshold || null;
    if (isHTTPS(svc) && !s.ssl) s.ssl = { status: 'pending', daysLeft: null, expiry: null };
    if (!isHTTPS(svc)) s.ssl = null;

    // Restart monitoring with new interval/config
    stopServiceMonitoring(svc.id);
    startServiceMonitoring(svc);

    console.log(`[Services] Updated: ${svc.name} (id=${svc.id}) by ${session.username}`);
    return json(res, 200, { service: svc });
  }

  // ── DELETE /api/services/:id (admin) ──────────────────────────────────────
  if (pathname.startsWith('/api/services/') && req.method === 'DELETE') {
    const session = requireAuth(req, res, 'admin');
    if (!session) return;
    const id = Number(pathname.slice('/api/services/'.length));
    config = loadConfig();
    const idx = config.services.findIndex(s => s.id === id);
    if (idx === -1) return json(res, 404, { error: 'Service not found' });
    const svc = config.services[idx];

    config.services.splice(idx, 1);
    saveConfig(config);
    stopServiceMonitoring(id);
    delete state[id];

    console.log(`[Services] Deleted: ${svc.name} (id=${id}) by ${session.username}`);
    return json(res, 200, { ok: true });
  }

  // ── GET /api/status ────────────────────────────────────────────────────────
  if (pathname === '/api/status' && req.method === 'GET') {
    const session = requireAuth(req, res);
    if (!session) return;
    return json(res, 200, { services: Object.values(state) });
  }

  // ── POST /api/change-password ──────────────────────────────────────────────
  if (pathname === '/api/change-password' && req.method === 'POST') {
    const session = requireAuth(req, res);
    if (!session) return;

    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'Invalid JSON' }); }

    const { currentPassword, newPassword } = body;
    if (!currentPassword || !newPassword) return json(res, 400, { error: 'currentPassword and newPassword required' });
    if (newPassword.length < 8) return json(res, 400, { error: 'New password must be at least 8 characters' });

    config = loadConfig();
    const cred = (config.credentials || []).find(c => c.username === session.username);
    if (!cred) return json(res, 404, { error: 'User not found' });

    if (hashPassword(currentPassword, cred.salt) !== cred.hash) {
      return json(res, 401, { error: 'Current password is incorrect' });
    }

    const newSalt = crypto.randomBytes(16).toString('hex');
    cred.salt = newSalt;
    cred.hash = hashPassword(newPassword, newSalt);
    saveConfig(config);

    // Invalidate all other sessions for this user
    for (const [t, s] of sessions) {
      if (s.username === session.username && t !== extractToken(req)) sessions.delete(t);
    }

    console.log(`[Auth] Password changed: ${session.username}`);
    return json(res, 200, { ok: true });
  }

  // ── Static files ───────────────────────────────────────────────────────────
  const filePath = pathname === '/' ? INDEX_PATH : path.join(__dirname, pathname);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type':  MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma':        'no-cache',
      'Expires':       '0',
    });
    res.end(data);
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

ensureCredentials();

server.listen(PORT, () => {
  console.log(`PulseWatch running → http://localhost:${PORT}\n`);
  startMonitoring();
});

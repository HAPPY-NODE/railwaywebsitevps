'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const httpProxy = require('http-proxy');
const multer = require('multer');

const { Store } = require('./store');
const auth = require('./auth');
const sessions = require('./sessions');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const USER_FILES_DIR = process.env.USER_FILES_DIR || path.join(__dirname, '..', 'userfiles');
const PORT = parseInt(process.env.PORT || '8080', 10);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const RES_W = parseInt(process.env.RES_WIDTH || '1280', 10);
const RES_H = parseInt(process.env.RES_HEIGHT || '720', 10);

const store = new Store(DATA_DIR);
auth.init(store);

// Ensure directories exist
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
try { fs.mkdirSync(USER_FILES_DIR, { recursive: true }); } catch (_) {}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

process.on('unhandledRejection', (e) => console.error('[process] unhandledRejection:', (e && e.stack) || e));
process.on('uncaughtException', (e) => console.error('[process] uncaughtException:', (e && e.stack) || e));

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });
proxy.on('error', (err, req, res) => {
  console.error('[proxy] error:', err.message);
  if (res && !res.headersSent && res.writeHead) {
    try { res.writeHead(502, { 'Content-Type': 'text/plain' }); } catch (_) {}
    try { res.end('Bad gateway'); } catch (_) {}
  }
});

// File upload setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userDir = path.join(USER_FILES_DIR, req.cur.username);
    try { fs.mkdirSync(userDir, { recursive: true }); } catch (_) {}
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB limit

function json(res, code, obj) { res.status(code).json(obj); }

// ---------- maintenance mode ----------
const MAINTENANCE_ALLOW = new Set([
  '/api/health', '/api/settings', '/api/login', '/api/logout',
  '/style.css', '/site.js', '/logo.svg', '/favicon.svg', '/maintenance.html', '/'
]);
app.use((req, res, next) => {
  let s;
  try { s = store.getSettings(); } catch (_) { return next(); }
  if (!s.maintenance) return next();
  const u = auth.currentUser(req);
  if (u && u.role === 'admin') return next();
  if (MAINTENANCE_ALLOW.has(req.path)) return next();
  if (req.path.startsWith('/api/')) return json(res, 503, { error: 'Site is under maintenance' });
  res.sendFile(path.join(PUBLIC_DIR, 'maintenance.html'));
});

function requireAuth(req, res, next) {
  const u = auth.currentUser(req);
  if (!u) return json(res, 401, { error: 'Not authenticated' });
  req.cur = u;
  next();
}

function requireAdmin(req, res, next) {
  const u = auth.currentUser(req);
  if (!u) return json(res, 401, { error: 'Not authenticated' });
  if (u.role !== 'admin') return json(res, 403, { error: 'Admin only' });
  req.cur = u;
  next();
}

// ---------- health ----------
const startedAt = Date.now();
app.get('/api/health', (req, res) => {
  json(res, 200, {
    ok: 1,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    users: store.listUsers().length,
    sessions: sessions.list().length,
    mock: sessions.MOCK,
    res: `${RES_W}x${RES_H}`
  });
});

// ---------- auth ----------
app.post('/api/login', ah(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return json(res, 400, { error: 'Username and password required' });
  const u = await auth.login(username, password);
  if (!u) return json(res, 401, { error: 'Invalid credentials' });
  auth.setSession(res, u);
  json(res, 200, { ok: 1, user: u });
}));

app.post('/api/logout', (req, res) => {
  auth.clearSession(req, res);
  json(res, 200, { ok: 1 });
});

app.get('/api/me', requireAuth, (req, res) => {
  const s = sessions.get(req.cur.username);
  json(res, 200, {
    username: req.cur.username,
    role: req.cur.role,
    ttlHours: sessions.ttlHours(),
    session: sessions.publicSession(s)
  });
});

app.post('/api/register', ah(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return json(res, 400, { error: 'Username and password required' });
  if (username.length < 3 || username.length > 32) return json(res, 400, { error: 'Username must be 3-32 characters' });
  if (password.length < 4) return json(res, 400, { error: 'Password must be at least 4 characters' });
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) return json(res, 400, { error: 'Username can only contain letters, numbers, _ and -' });
  const u = await auth.register(username, password);
  if (!u) return json(res, 409, { error: 'Username already taken' });
  auth.setSession(res, u);
  // Create fresh user directory
  const userDir = path.join(USER_FILES_DIR, username);
  try { fs.mkdirSync(userDir, { recursive: true }); } catch (_) {}
  json(res, 200, { ok: 1, user: u });
}));

// ---------- admin ----------
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = store.listUsers().map(u => ({
    username: u.username,
    role: u.role,
    createdAt: u.createdAt,
    hasSession: !!sessions.get(u.username)
  }));
  json(res, 200, { users });
});

app.post('/api/admin/kick', requireAdmin, ah(async (req, res) => {
  const { username } = req.body || {};
  if (!username) return json(res, 400, { error: 'Username required' });
  if (username === req.cur.username) return json(res, 400, { error: 'Cannot kick yourself' });
  await sessions.stop(username);
  json(res, 200, { ok: 1 });
}));

app.delete('/api/admin/users/:username', requireAdmin, ah(async (req, res) => {
  const { username } = req.params;
  if (username === req.cur.username) return json(res, 400, { error: 'Cannot delete yourself' });
  await sessions.stop(username);
  // Delete user files
  const userDir = path.join(USER_FILES_DIR, username);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
  store.deleteUser(username);
  json(res, 200, { ok: 1 });
}));

app.get('/api/settings', (req, res) => {
  try { json(res, 200, store.getSettings()); } catch (_) { json(res, 200, {}); }
});

app.put('/api/settings', requireAdmin, ah(async (req, res) => {
  const s = req.body || {};
  if (s.ttlHours !== undefined) sessions.setTtlHours(s.ttlHours);
  store.updateSettings(s);
  json(res, 200, store.getSettings());
}));

// ---------- file manager ----------
app.get('/api/files', requireAuth, (req, res) => {
  const userDir = path.join(USER_FILES_DIR, req.cur.username);
  try {
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    const files = fs.readdirSync(userDir)
      .filter(f => fs.statSync(path.join(userDir, f)).isFile())
      .map(f => ({ name: f, size: fs.statSync(path.join(userDir, f)).size }));
    json(res, 200, { files });
  } catch (e) {
    json(res, 500, { error: 'Failed to list files' });
  }
});

app.post('/api/files/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return json(res, 400, { error: 'No file uploaded' });
  json(res, 200, { ok: 1, name: req.file.originalname });
});

app.get('/api/files/download', requireAuth, (req, res) => {
  const name = req.query.name;
  if (!name) return json(res, 400, { error: 'Filename required' });
  const filePath = path.join(USER_FILES_DIR, req.cur.username, name);
  // Security: prevent directory traversal
  if (!filePath.startsWith(path.join(USER_FILES_DIR, req.cur.username))) {
    return json(res, 403, { error: 'Access denied' });
  }
  if (!fs.existsSync(filePath)) return json(res, 404, { error: 'File not found' });
  res.download(filePath);
});

app.post('/api/files/delete', requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name) return json(res, 400, { error: 'Filename required' });
  const filePath = path.join(USER_FILES_DIR, req.cur.username, name);
  if (!filePath.startsWith(path.join(USER_FILES_DIR, req.cur.username))) {
    return json(res, 403, { error: 'Access denied' });
  }
  try { fs.unlinkSync(filePath); json(res, 200, { ok: 1 }); }
  catch (e) { json(res, 500, { error: 'Failed to delete' }); }
});

// ---------- sandbox (desktop) ----------
app.post('/api/sandbox/start', requireAuth, ah(async (req, res) => {
  const { name, width, height } = req.body || {};
  const result = await sessions.start(req.cur.username, {
    name: name || (req.cur.username + '-vm'),
    width: width || RES_W,
    height: height || RES_H
  });
  if (!result.ok) return json(res, 500, { error: result.error });
  json(res, 200, { ok: 1, session: result.session });
}));

app.get('/api/sandbox/start-job-logs', requireAuth, (req, res) => {
  const since = parseInt(req.query.since || '0', 10);
  json(res, 200, sessions.jobStatus(req.cur.username, since));
});

app.post('/api/sandbox/stop', requireAuth, ah(async (req, res) => {
  const result = await sessions.stop(req.cur.username);
  json(res, 200, result);
}));

app.get('/api/sandbox/status', requireAuth, (req, res) => {
  const s = sessions.get(req.cur.username);
  json(res, 200, { session: sessions.publicSession(s) });
});

// ---------- VNC proxy ----------
app.get('/vnc/:user', requireAuth, (req, res) => {
  const s = sessions.get(req.params.user);
  if (!s) return json(res, 404, { error: 'No active desktop' });
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers.host || 'localhost';
  const isHttps = /^https/.test(proto);
  const defaultPort = isHttps ? 443 : 80;
  const hasExplicitPort = host.includes(':');
  const port = hasExplicitPort ? host.split(':')[1] : defaultPort;
  const cleanHost = host.split(':')[0];
  const url =
    `${proto}://${host}/vnc/${s.username}/vnc.html` +
    `?autoconnect=true&host=${cleanHost}&port=${port}&path=vnc/${s.username}/websockify&resize=remote&reconnect=1&warning=false`;
  res.redirect(302, url);
});

app.use('/vnc/:user', requireAuth, (req, res) => {
  if (req.cur.role !== 'admin' && req.cur.username !== req.params.user) {
    return json(res, 403, { error: 'Not your desktop' });
  }
  const s = sessions.get(req.params.user);
  if (!s) return json(res, 404, { error: 'No active desktop' });
  proxy.web(req, res, { target: `http://127.0.0.1:${s.port}` });
});

// ---------- desktop page ----------
app.get('/desktop.html', requireAuth, (req, res) => {
  const s = sessions.get(req.cur.username);
  if (!s) return res.redirect('/app.html');
  res.sendFile(path.join(PUBLIC_DIR, 'desktop.html'));
});

// ---------- static portal ----------
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

// JSON error handler
app.use((err, req, res, next) => {
  console.error('[server] route error:', (err && err.stack) || err);
  if (res && !res.headersSent) {
    if (req.path.startsWith('/api/')) json(res, 500, { error: 'Internal server error' });
    else res.status(500).send('Internal server error');
  }
});

// catch-all
app.use((req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ---------- start ----------
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] ${store.getSettings().name} listening on :${PORT}`);
  console.log(`[server] data dir: ${DATA_DIR}`);
  console.log(`[server] user files dir: ${USER_FILES_DIR}`);
  console.log(`[server] mode: ${sessions.MOCK ? 'MOCK' : 'REAL (Ubuntu XFCE)'}`);
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/vnc\/([^/]+)\/websockify/);
  if (match) {
    const s = sessions.get(match[1]);
    if (s) {
      proxy.ws(req, socket, head, { target: `http://127.0.0.1:${s.port}` });
      return;
    }
  }
  socket.destroy();
});

setInterval(() => sessions.sweep(), 30000);

function shutdown() {
  console.log('[server] shutting down');
  sessions.shutdownAll();
  try { server.close(() => process.exit(0)); } catch (_) { process.exit(0); }
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
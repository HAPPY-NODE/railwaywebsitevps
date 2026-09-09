'use strict';
/**
 * server.js � Sandbox Manager main web app (Express).
 *
 * Serves the portal (login / register / dashboard / admin), the JSON API,
 * and reverse-proxies per-user VNC desktops through the public URL so the
 * whole thing works behind a Railway auto-URL or a Cloudflare custom domain.
 */
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const httpProxy = require('http-proxy');

const { Store } = require('./store');
const auth = require('./auth');
const sessions = require('./sessions');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PORT = parseInt(process.env.PORT || '8080', 10);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const RES_W = parseInt(process.env.RES_WIDTH || '1280', 10);
const RES_H = parseInt(process.env.RES_HEIGHT || '720', 10);

const store = new Store(DATA_DIR);
auth.init(store);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Keep the process alive no matter what � a failed desktop start must never
// take the whole site down (that is what showed up as "Failed to fetch").
process.on('unhandledRejection', (e) => console.error('[process] unhandledRejection:', (e && e.stack) || e));
process.on('uncaughtException', (e) => console.error('[process] uncaughtException:', (e && e.stack) || e));

// wrap async route handlers so a throw becomes a 500 instead of a crash
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });
proxy.on('error', (err, req, res) => {
  console.error('[proxy] error:', err.message);
  if (res && !res.headersSent && res.writeHead) {
    try { res.writeHead(502, { 'Content-Type': 'text/plain' }); } catch (_) {}
    try { res.end('Bad gateway'); } catch (_) {}
  }
});

// ---------- helpers ----------
function json(res, code, obj) {
  res.status(code).json(obj);
}

// ---------- maintenance mode (admin can toggle from the panel) ----------
const MAINTENANCE_ALLOW = new Set([
  '/api/health', '/api/settings', '/api/login', '/api/logout',
  '/style.css', '/site.js', '/logo.svg', '/favicon.svg', '/maintenance.html', '/'
]);
app.use((req, res, next) => {
  let s;
  try { s = store.getSettings(); } catch (_) { return next(); }
  if (!s.maintenance) return next();
  const u = auth.currentUser(req);
  if (u && u.role === 'admin') return next(); // admins keep full access
  if (MAINTENANCE_ALLOW.has(req.path)) return next();
  if (req.path.startsWith('/api/')) {
    return json(res, 503, { error: 'Site is under maintenance. Please try again later.' });
  }
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
    activeSessions: sessions.list().length,
    mode: sessions.MOCK ? 'mock' : 'real',
    ttlHours: sessions.ttlHours()
  });
});

// ---------- branding settings (public read, admin write) ----------
app.get('/api/settings', (req, res) => {
  json(res, 200, store.getSettings());
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (name.length < 1 || name.length > 60) {
      return json(res, 400, { error: 'Site name must be 1-60 characters' });
    }
    patch.name = name;
  }
  if (body.tagline !== undefined) {
    const tagline = String(body.tagline).trim();
    if (tagline.length > 120) {
      return json(res, 400, { error: 'Tagline must be 120 characters or fewer' });
    }
    patch.tagline = tagline;
  }
  if (body.banner !== undefined) {
    const banner = String(body.banner).trim();
    if (banner.length > 200) {
      return json(res, 400, { error: 'Banner must be 200 characters or fewer' });
    }
    patch.banner = banner;
  }
  if (body.ttlHours !== undefined) {
    const h = Number(body.ttlHours);
    if (!Number.isFinite(h) || h < 0.25 || h > 168) {
      return json(res, 400, { error: 'Expire time must be between 0.25 and 168 hours' });
    }
    patch.ttlHours = h;
  }
  if (body.maintenance !== undefined) {
    patch.maintenance = !!body.maintenance;
  }
  if (Object.keys(patch).length === 0) {
    return json(res, 400, { error: 'Nothing to update' });
  }
  const settings = store.updateSettings(patch);
  // apply new expire time to the running session sweeper immediately
  if (patch.ttlHours !== undefined) sessions.setTtlHours(patch.ttlHours);
  json(res, 200, { ok: true, settings });
});

// ---------- auth routes ----------
app.post('/api/register', ah(async (req, res) => {
  const { username, password } = req.body || {};
  const reg = await auth.register(username, password);
  if (!reg.ok) return json(res, 400, { error: reg.error });
  auth.openSession(res, username, reg.role);
  json(res, 200, { ok: true, username, role: reg.role });
}));

app.post('/api/login', ah(async (req, res) => {
  const { username, password } = req.body || {};
  const lr = await auth.login(username, password);
  if (!lr.ok) return json(res, 401, { error: lr.error });
  auth.openSession(res, lr.username, lr.role);
  json(res, 200, { ok: true, username: lr.username, role: lr.role });
}));

app.post('/api/logout', (req, res) => {
  auth.closeSession(req, res);
  json(res, 200, { ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  json(res, 200, {
    username: req.cur.username,
    role: req.cur.role,
    session: sessions.publicSession(sessions.get(req.cur.username)),
    mock: sessions.MOCK,
    ttlHours: sessions.ttlHours(),
    res: { w: RES_W, h: RES_H }
  });
});

// ---------- sandbox (own RDP) ----------
app.get('/api/sandbox', requireAuth, (req, res) => {
  json(res, 200, {
    session: sessions.publicSession(sessions.get(req.cur.username)),
    ttlHours: sessions.ttlHours(),
    mock: sessions.MOCK
  });
});

app.post('/api/sandbox/start', requireAuth, ah(async (req, res) => {
  const u = req.cur.username;
  if (sessions.get(u)) return json(res, 200, { ok: true, session: sessions.publicSession(sessions.get(u)) });
  const name = (req.body && req.body.name ? String(req.body.name).slice(0, 40) : '') || (u + '-vm');
  // Start the desktop asynchronously � return immediately so the frontend can poll for live logs
  sessions.start(u, RES_W, RES_H, name).then((r) => {
    if (r && r.ok) {
      const user = store.getUser(u);
      if (user && r.note !== 'already-running') {
        user.sessionsStarted = (user.sessionsStarted || 0) + 1;
        store.upsertUser(user);
      }
    }
  }).catch((e) => {
    console.error('[server] sandbox start failed for', u, e.message);
  });
  json(res, 200, { ok: true, starting: true, name });
}));

// Live boot-log polling � returns new log lines + status (starting | running | failed)
// Returns 202 while starting (client keeps polling), 200 when done, 200 with error on failure
app.get('/api/sandbox/start-job-logs', requireAuth, ah(async (req, res) => {
  const u = req.cur.username;
  const since = parseInt(req.query.since, 10) || 0;
  const status = sessions.jobStatus(u, since);
  // while the job is still starting, return 202 � client keeps polling
  if (status.status === 'starting' && !status.error) return json(res, 202, status);
  json(res, 200, status);
}));

app.post('/api/sandbox/stop', requireAuth, ah(async (req, res) => {
  await sessions.stop(req.cur.username);
  json(res, 200, { ok: true });
}));

// "Delete" the user's own VM � stops the desktop instance
app.delete('/api/sandbox', requireAuth, ah(async (req, res) => {
  await sessions.stop(req.cur.username);
  json(res, 200, { ok: true });
}));

// ---------- admin panel ----------
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = store.listUsers().map((u) => {
    const s = sessions.publicSession(sessions.get(u.username));
    return {
      username: u.username,
      role: u.role,
      createdAt: u.createdAt,
      sessionsStarted: u.sessionsStarted || 0,
      session: s || null
    };
  });
  json(res, 200, {
    users,
    active: sessions.list().length,
    ttlHours: sessions.ttlHours(),
    mock: sessions.MOCK,
    adminUser: auth.adminUsername()
  });
});

// change any user's password
app.put('/api/admin/users/:u/password', requireAdmin, ah(async (req, res) => {
  const u = req.params.u;
  const newPass = req.body && req.body.newPassword;
  const r = auth.changeUserPassword(u, newPass);
  if (!r.ok) return json(res, 400, { error: r.error });
  json(res, 200, { ok: true });
}));

// change the admin (own) password
app.put('/api/admin/password', requireAdmin, ah(async (req, res) => {
  const newPass = req.body && req.body.newPassword;
  const r = auth.changeAdminPassword(newPass);
  if (!r.ok) return json(res, 400, { error: r.error });
  json(res, 200, { ok: true });
}));

app.post('/api/admin/users/:u/start', requireAdmin, ah(async (req, res) => {
  const u = req.params.u;
  if (!store.getUser(u)) return json(res, 404, { error: 'User not found' });
  const r = await sessions.start(u, RES_W, RES_H);
  if (!r.ok) return json(res, 500, { error: r.error });
  json(res, 200, { ok: true, session: r.session });
}));

app.post('/api/admin/users/:u/stop', requireAdmin, ah(async (req, res) => {
  await sessions.stop(req.params.u);
  json(res, 200, { ok: true });
}));

// "Delete RDP" � stops/removes the desktop instance
app.delete('/api/admin/users/:u/rdp', requireAdmin, ah(async (req, res) => {
  await sessions.stop(req.params.u);
  json(res, 200, { ok: true });
}));

app.delete('/api/admin/users/:u', requireAdmin, ah(async (req, res) => {
  const u = req.params.u;
  if (!store.getUser(u)) return json(res, 404, { error: 'User not found' });
  await sessions.stop(u);
  store.deleteUser(u);
  json(res, 200, { ok: true });
}));

// ---------- VNC proxy ----------
// GET /vnc/:user -> redirect to the KasmVNC client with autoconnect pointing
// back through our proxy path (works over http/https + ws/wss).
app.get('/vnc/:user', requireAuth, (req, res) => {
  if (req.cur.role !== 'admin' && req.cur.username !== req.params.user) {
    return json(res, 403, { error: 'Not your desktop' });
  }
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

// Proxy everything else under /vnc/:user/** -> 127.0.0.1:<userPort>/**
// (req.url already holds the remaining path, e.g. /vnc.html or /websockify)
app.use('/vnc/:user', requireAuth, (req, res) => {
  if (req.cur.role !== 'admin' && req.cur.username !== req.params.user) {
    return json(res, 403, { error: 'Not your desktop' });
  }
  const s = sessions.get(req.params.user);
  if (!s) return json(res, 404, { error: 'No active desktop' });
  proxy.web(req, res, { target: `http://127.0.0.1:${s.port}` });
});

// WebSocket upgrade handler for VNC
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/vnc\/([^/]+)\/websockify/);
  if (match) {
    const username = match[1];
    const s = sessions.get(username);
    if (s) {
      proxy.ws(req, socket, head, { target: `http://127.0.0.1:${s.port}` });
      return;
    }
  }
  socket.destroy();
});

// ---------- desktop ready page ----------
app.get('/desktop.html', requireAuth, (req, res) => {
  const s = sessions.get(req.cur.username);
  if (!s) return res.redirect('/app.html'); // no active desktop — send back to dashboard
  res.sendFile(path.join(PUBLIC_DIR, 'desktop.html'));
});

// ---------- static portal ----------
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

// JSON error handler � any route throw becomes a clean 500 (never a hang)
app.use((err, req, res, next) => {
  console.error('[server] route error:', (err && err.stack) || err);
  if (res && !res.headersSent) {
    if (req.path.startsWith('/api/')) json(res, 500, { error: 'Internal server error' });
    else res.status(500).send('Internal server error');
  }
});

// catch-all: serve the login page for unknown paths (keeps deep links sane)
app.use((req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------- start ----------
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] ${store.getSettings().name} Sandbox Manager listening on :${PORT}`);
  console.log(`[server] data dir: ${DATA_DIR}`);
  console.log(`[server] mode: ${sessions.MOCK ? 'MOCK (no real desktops)' : 'REAL (Ubuntu XFCE)'}`);
  console.log(`[server] session TTL: ${sessions.ttlHours()} hours`);
  console.log(`[server] desktop resolution: ${RES_W}x${RES_H}`);
  console.log('[server] Admin: admin (built-in default � set ADMIN_USER/ADMIN_PASSWORD env to override)');
});

// TTL sweeper
setInterval(() => sessions.sweep(), 30000);

function shutdown() {
  console.log('[server] shutting down�');
  sessions.shutdownAll();
  try { server.close(() => process.exit(0)); } catch (_) { process.exit(0); }
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

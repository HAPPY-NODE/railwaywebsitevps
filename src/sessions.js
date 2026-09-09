'use strict';
/**
 * sessions.js — per-user Ubuntu/XFCE desktop lifecycle.
 *
 * Each active user gets exactly ONE private desktop:
 *   Xvfb :N  +  KasmVNC web server on port <basePort + N>
 * The Node app reverse-proxies /vnc/<user>/* to that local port, so from the
 * outside it all looks like one normal web app on $PORT.
 *
 * Every session is auto-killed after SESSION_HOURS hours (default 4).
 *
 * MOCK_VNC=1 makes sessions virtual (no real desktop) — useful for local
 * testing of the portal on Windows where Xvfb/KasmVNC aren't installed.
 */
const { spawn } = require('child_process');
const { connect } = require('net');
const http = require('http');
const path = require('path');

// Displays start at 20 so we never clash with the webtop container's own
// X server (webtop runs its desktop on :1). Ports start at 7001 so we never
// clash with webtop's own KasmVNC (3000 = http, 3001 = https).
const BASE_PORT = parseInt(process.env.VNC_BASE_PORT || '7001', 10);
const BASE_DISPLAY = parseInt(process.env.VNC_BASE_DISPLAY || '20', 10);
let ttlMins = parseInt(process.env.SESSION_HOURS || '4', 10) * 60;
const MOCK = process.env.MOCK_VNC === '1';
const SCRIPTS = path.join(__dirname, '..', 'scripts');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// in-memory active sessions: username -> {username, name, port, display, startedAt, mode, _srv}
const active = new Map();

// VM start jobs (for live boot logs): username -> {status, logs[], error, vmName}
const jobs = new Map();
const JOB_LOG_MAX = 400;

function logJob(username, line) {
  let j = jobs.get(username);
  if (!j) { j = { status: 'starting', logs: [], error: null, vmName: '' }; jobs.set(username, j); }
  j.logs.push(String(line));
  if (j.logs.length > JOB_LOG_MAX) j.logs.splice(0, j.logs.length - JOB_LOG_MAX);
}

function jobStatus(username, since = 0) {
  const j = jobs.get(username);
  const s = active.get(username);
  if (!j) {
    return { status: s ? 'running' : 'idle', logs: [], total: 0, error: null, vmName: s ? s.name : '' };
  }
  const from = Math.max(0, Math.min(Number(since) || 0, j.logs.length));
  return {
    status: s ? 'running' : j.status,
    logs: j.logs.slice(from),
    total: j.logs.length,
    error: j.error,
    vmName: j.vmName
  };
}

// TTL is admin-editable at runtime (settings.ttlHours). Default comes from SESSION_HOURS.
function setTtlHours(h) {
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0.25 && n <= 168) {
    ttlMins = Math.round(n * 60);
    console.log(`[sessions] TTL set to ${ttlMins} minutes`);
  }
}

function ttlHours() {
  return ttlMins / 60;
}

function ttlSeconds() {
  return ttlMins * 60;
}

function get(username) {
  return active.get(username) || null;
}

function list() {
  return Array.from(active.values());
}

// pick a free display + port
function alloc() {
  let display = BASE_DISPLAY;
  let port = BASE_PORT;
  const activeList = Array.from(active.values());
  const usedDisplays = new Set(activeList.map((s) => s.display));
  const usedPorts = new Set(activeList.map((s) => s.port));
  while (usedDisplays.has(display)) display++;
  while (usedPorts.has(port)) {
    port++;
    if (port >= BASE_PORT + 100) {
      display++;
      port = BASE_PORT;
    }
  }
  return { display, port };
}

function isPortOpen(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const conn = connect({ host: '127.0.0.1', port, timeout: timeoutMs });
    conn.on('connect', () => {
      resolve(true);
      try { conn.destroy(); } catch (_) {}
    });
    conn.on('error', () => resolve(false));
  });
}

function runScript(script, args, onLine) {
  return new Promise((resolve) => {
    const child = spawn('bash', [path.join(SCRIPTS, script), ...args], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const out = [];
    const feed = (d) => {
      const text = d.toString();
      out.push(text);
      if (onLine) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) onLine(line.trim());
        }
      }
    };
    child.stdout && child.stdout.on('data', feed);
    child.stderr && child.stderr.on('data', feed);
    child.on('close', (code) => resolve({ code, out: out.join('\n') }));
    child.on('error', (err) => resolve({ code: -1, out: String((err && err.message) || err) }));
  });
}

async function waitUntilOpen(port, tries = 40, everyMs = 2000) {
  for (let i = 0; i < tries; i++) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

// MOCK: create a fake HTTP server so the proxy has a real socket.
// It echoes the request path so path-rewriting can be verified locally.
function mockListen(port) {
  const srv = http.createServer((req, res) => {
    const body = `MOCK VNC DESKTOP\npath=${req.url}\n(set MOCK_VNC=0 to run real Ubuntu/XFCE desktops)`;
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Length': body.length
    });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

async function start(username, width, height, name) {
  const existing = active.get(username);
  if (existing) return { ok: true, session: publicSession(existing), note: 'already-running' };

  // Ensure width/height are valid numbers (defensive — prevent [object Object] in logs)
  width = Number(width);
  height = Number(height);
  if (!Number.isFinite(width) || width < 320) width = 1280;
  if (!Number.isFinite(height) || height < 240) height = 720;

  const vmName = String(name || '').trim().slice(0, 40) || `${username}-vm`;
  const { display, port } = alloc();
  let mode = 'real';

  try {
    if (MOCK) {
      // --- simulate live boot logs (like a Docker pull) so the dashboard
      //     shows real-time progress while the "desktop" comes up ---
      logJob(username, `[session] starting display=:${display} webport=${port} res=${width||1280}x${height||720}`);
      logJob(username, `[session] run-as=${process.env.USER || process.env.LOGNAME || 'root'} VNC_HOME=${process.env.VNC_HOME || '/home/abc'}`);
      logJob(username, '[session] MOCK mode — simulating boot');
      logJob(username, '[session] resolving container image...');
      await sleep(1200);
      logJob(username, 'Pulling image layers...');
      await sleep(900);
      logJob(username, '[1/4] Starting desktop container (image pull may take 2-5 min)...');
      await sleep(800);
      logJob(username, 'ubuntu-xfce: Pulling fs layer');
      await sleep(600);
      logJob(username, 'ubuntu-xfce: Download complete');
      await sleep(500);
      logJob(username, 'ubuntu-xfce: Pull complete');
      await sleep(600);
      logJob(username, '[session] virtual desktop ready (mock)');

      const srv = await mockListen(port);
      mode = 'mock';
      const session = {
        username, name: vmName, port, display, startedAt: Date.now(), mode, width, height,
        _srv: srv
      };
      active.set(username, session);
      return { ok: true, session: publicSession(session) };
    }

        // --- REAL desktop: run start-session.sh with live logging + retry ---
    logJob(username, `[session] starting display=:${display} webport=${port} res=${width||1280}x${height||720}`);
    logJob(username, `[session] run-as=${process.env.USER || process.env.LOGNAME || 'root'} VNC_HOME=${process.env.VNC_HOME || '/home/abc'}`);

    // clean up any stale lock/state from a previous crashed run
    logJob(username, '[session] cleaning previous state...');
    try { await runScript('stop-session.sh', [String(display), String(port)], (l) => logJob(username, '[cleanup] ' + l)); }
    catch (_) {}

    const res = await runScript('start-session.sh', [
      String(display), String(port), String(width || 1280), String(height || 720), vmName
    ], (l) => logJob(username, l));

    if (res.code !== 0) {
      throw new Error(`Desktop start failed (code ${res.code}):\n${res.out.trim().slice(-2000)}`);
    }

    const open = await waitUntilOpen(port);
    if (!open) throw new Error('Desktop did not become reachable in time.');
  } catch (e) {
    // log the error to the job so the frontend can show it
    logJob(username, '[session] ERROR: ' + e.message);
    let j = jobs.get(username);
    if (j) { j.status = 'failed'; j.error = e.message; }
    // attempt to tear down any partially-started desktop before giving up
    if (MOCK) {
      try {
        const s = active.get(username);
        if (s && s._srv) await new Promise((r) => s._srv.close(r));
      } catch (_) {}
    } else {
      try {
        await runScript('stop-session.sh', [String(display), String(port)]);
      } catch (_) {}
    }
    active.delete(username);
    return { ok: false, error: e.message };
  }

  const session = {
    username, name: vmName, port, display, startedAt: Date.now(), mode, width, height, _srv: undefined
  };
  active.set(username, session);
  return { ok: true, session: publicSession(session) };
}

async function stop(username) {
  const s = active.get(username);
  if (!s) return { ok: true, note: 'none' };
  if (s.mode === 'mock') {
    try {
      const srv = s._srv;
      s._srv = null;
      if (srv) await new Promise((r) => srv.close(r));
    } catch (_) {}
  } else {
    try {
      await runScript('stop-session.sh', [String(s.display), String(s.port), s.name || 'desktop']);
    } catch (_) {}
  }
  active.delete(username);
  jobs.delete(username);
  return { ok: true };
}

// kill any desktop that has been up longer than the TTL
function sweep(now = Date.now()) {
  for (const s of active.values()) {
    const upMs = now - s.startedAt;
    if (s.mode !== 'mock' && upMs >= ttlMins * 60 * 1000) {
      console.log(`[sweep] expiring ${s.username} after ${Math.round(upMs / 60000)}m`);
      stop(s.username);
    }
  }
}

function remainingSeconds(s) {
  if (!s) return 0;
  const upMs = Date.now() - s.startedAt;
  return Math.max(0, Math.round((ttlMins * 60 * 1000 - upMs) / 1000));
}

function publicSession(s) {
  if (!s) return null;
  return {
    username: s.username,
    name: s.name || s.username + '-vm',
    port: s.port,
    display: s.display,
    startedAt: s.startedAt,
    mode: s.mode,
    ttlSeconds: ttlMins * 60,
    remainingSeconds: remainingSeconds(s)
  };
}

function shutdownAll() {
  for (const s of active.values()) stop(s.username);
}

module.exports = {
  setTtlHours,
  ttlHours,
  BASE_PORT,
  MOCK,
  get,
  list,
  start,
  stop,
  sweep,
  remainingSeconds,
  publicSession,
  shutdownAll,
  ttlSeconds,
  jobStatus
};

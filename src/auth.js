'use strict';
/**
 * auth.js — register / login helpers.
 * Passwords are hashed with bcryptjs (pure JS, no native compile needed).
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const cookieName = 'happynode_session';

// Built-in admin account (env vars override). The admin password can also be
// changed at runtime from the admin panel — it is then stored hashed in the store.
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin123';

let StoreRef = null;
function init(st) {
  StoreRef = st;
}

const USER_RE = /^[a-zA-Z0-9_]{3,20}$/;

function validateUsername(u) {
  return typeof u === 'string' && USER_RE.test(u);
}
function validatePassword(p) {
  return typeof p === 'string' && p.length >= 6 && p.length <= 72;
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function register(username, password) {
  if (!validateUsername(username)) {
    return { ok: false, error: 'Username must be 3-20 chars (letters, numbers, underscore).' };
  }
  if (!validatePassword(password)) {
    return { ok: false, error: 'Password must be 6-72 characters.' };
  }
  if (StoreRef.getUser(username)) {
    return { ok: false, error: 'Username already taken.' };
  }
  if (username === ADMIN_USER) {
    return { ok: false, error: 'This username is reserved.' };
  }
  const role = 'user';
  const hash = bcrypt.hashSync(password, 10);
  StoreRef.upsertUser({
    username,
    password: hash,
    role,
    createdAt: Date.now(),
    sessionsStarted: 0,
    mock: false
  });
  return { ok: true, role };
}

async function login(username, password) {
  // Admin check (env overrides the stored hash so a lost volume can't lock you out).
  if (username === ADMIN_USER) {
    if (await verifyAdminPassword(password)) {
      return { ok: true, role: 'admin', username };
    }
    return { ok: false, error: 'Invalid credentials.' };
  }

  const user = StoreRef.getUser(username);
  if (!user) return { ok: false, error: 'Invalid credentials.' };
  if (!bcrypt.compareSync(password, user.password)) {
    return { ok: false, error: 'Invalid credentials.' };
  }
  return { ok: true, role: user.role || 'user', username };
}

function openSession(res, username, role) {
  const token = randomToken();
  const ttlMs = 7 * 24 * 3600 * 1000; // 7 days
  StoreRef.addToken(token, username, role, ttlMs);
  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: ttlMs / 1000,
    path: '/'
  });
  return token;
}

function closeSession(req, res) {
  const tok = req.cookies[cookieName];
  if (tok) StoreRef.revokeToken(tok);
  res.clearCookie(cookieName, { path: '/' });
}

function currentUser(req) {
  const tok = req.cookies ? req.cookies[cookieName] : null;
  if (!tok) return null;
  const t = StoreRef.getToken(tok);
  if (!t) return null;
  const user = StoreRef.getUser(t.username);
  if (!user && t.role !== 'admin') return null;
  return { username: t.username, role: t.role, user: user || (t.role === 'admin' ? null : null) };
}

// ---------- password management ----------
// Admin password: a runtime override (set from the admin panel) is stored
// bcrypt-hashed in the store; otherwise the built-in/env default applies.
async function verifyAdminPassword(password) {
  const hash = StoreRef.getAdminPassHash();
  if (hash) return bcrypt.compareSync(String(password || ''), hash);
  return String(password || '') === ADMIN_PASS;
}

function changeAdminPassword(newPass) {
  if (!validatePassword(newPass)) {
    return { ok: false, error: 'Password must be 6-72 characters.' };
  }
  StoreRef.setAdminPassHash(bcrypt.hashSync(newPass, 10));
  return { ok: true };
}

function changeUserPassword(username, newPass) {
  const user = StoreRef.getUser(username);
  if (!user) return { ok: false, error: 'User not found.' };
  if (!validatePassword(newPass)) {
    return { ok: false, error: 'Password must be 6-72 characters.' };
  }
  user.password = bcrypt.hashSync(newPass, 10);
  StoreRef.upsertUser(user);
  return { ok: true };
}

function adminUsername() {
  return ADMIN_USER;
}

module.exports = {
  init, register, login, openSession, closeSession, currentUser, cookieName,
  verifyAdminPassword, changeAdminPassword, changeUserPassword, adminUsername
};
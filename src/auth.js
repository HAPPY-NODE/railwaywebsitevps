'use strict';
/**
 * auth.js register / login helpers.
 * Passwords are hashed with bcryptjs (pure JS, no native compile needed).
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const cookieName = 'happynode_session';

// Built-in admin account (env vars override).
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
  return typeof p === 'string' && p.length >= 4 && p.length <= 72;
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Returns user object on success, null on failure
async function register(username, password) {
  if (!validateUsername(username)) {
    return null;
  }
  if (!validatePassword(password)) {
    return null;
  }
  if (StoreRef.getUser(username)) {
    return null;
  }
  if (username === ADMIN_USER) {
    return null;
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
  return { username, role };
}

// Returns user object on success, null on failure
async function login(username, password) {
  // Admin check
  if (username === ADMIN_USER) {
    if (await verifyAdminPassword(password)) {
      return { username, role: 'admin' };
    }
    return null;
  }

  const user = StoreRef.getUser(username);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password)) {
    return null;
  }
  return { username, role: user.role || 'user' };
}

function setSession(res, user) {
  const token = randomToken();
  const ttlMs = 7 * 24 * 3600 * 1000; // 7 days
  StoreRef.addToken(token, user.username, user.role, ttlMs);
  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: ttlMs / 1000,
    path: '/'
  });
  return token;
}

function clearSession(req, res) {
  const tok = req.cookies ? req.cookies[cookieName] : null;
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
  return { username: t.username, role: t.role };
}

// ---------- password management ----------
async function verifyAdminPassword(password) {
  const hash = StoreRef.getAdminPassHash();
  if (hash) return bcrypt.compareSync(String(password || ''), hash);
  return String(password || '') === ADMIN_PASS;
}

function changeAdminPassword(newPass) {
  if (!validatePassword(newPass)) {
    return false;
  }
  StoreRef.setAdminPassHash(bcrypt.hashSync(newPass, 10));
  return true;
}

function changeUserPassword(username, newPass) {
  const user = StoreRef.getUser(username);
  if (!user) return false;
  if (!validatePassword(newPass)) {
    return false;
  }
  user.password = bcrypt.hashSync(newPass, 10);
  StoreRef.upsertUser(user);
  return true;
}

function adminUsername() {
  return ADMIN_USER;
}

module.exports = {
  init, register, login, setSession, clearSession, currentUser, cookieName,
  verifyAdminPassword, changeAdminPassword, changeUserPassword, adminUsername
};
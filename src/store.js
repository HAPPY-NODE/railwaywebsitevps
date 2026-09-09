'use strict';
/**
 * store.js — Tiny crash-safe JSON store (single process, atomic writes).
 * Persists to $DATA_DIR/db.json so users survive restarts when a Railway
 * Volume is mounted at /data.
 */
const fs = require('fs');
const path = require('path');

// Branding/ops defaults (overridable at deploy time via env, editable from admin panel).
const DEFAULT_SETTINGS = {
  name: 'HAPPY NODE',
  tagline: 'Ubuntu XFCE remote desktops',
  banner: 'Limit: 1 VM running at a time. VMs auto-stop after {ttl} hr, freeing your slot for a new one.',
  ttlHours: 4,
  maintenance: false
};

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'db.json');
    this.defaults = {
      users: {},
      tokens: {},
      counters: { displays: 0 },
      settings: {
        name: process.env.SITE_NAME || DEFAULT_SETTINGS.name,
        tagline: process.env.SITE_TAGLINE || DEFAULT_SETTINGS.tagline,
        ttlHours: parseFloat(process.env.SESSION_HOURS || '') || DEFAULT_SETTINGS.ttlHours
      }
    };
    this.data = Object.assign({}, this.defaults);
    this.load();
  }

  load() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const raw = fs.readFileSync(this.file, 'utf8');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.data = Object.assign(this.data, parsed);
        }
      }
    } catch (e) {
      // First boot or corrupt file: start fresh (keep process alive).
      if (e.code !== 'ENOENT') {
        console.error('[store] load warning:', e.message);
      }
    }
    if (!this.data.users) this.data.users = {};
    if (!this.data.tokens) this.data.tokens = {};
    if (!this.data.counters) this.data.counters = { displays: 0 };
    this.data.settings = Object.assign({}, this.defaults.settings, this.data.settings || {});
    this.save();
  }

  save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store] save error:', e.message);
    }
  }

  // ---- users ----
  getUser(username) {
    return this.data.users[username] || null;
  }

  listUsers() {
    return Object.values(this.data.users).sort((a, b) =>
      (a.createdAt || 0) - (b.createdAt || 0)
    );
  }

  upsertUser(user) {
    this.data.users[user.username] = user;
    this.save();
    return user;
  }

  deleteUser(username) {
    delete this.data.users[username];
    // drop the user's tokens too
    for (const tok of Object.keys(this.data.tokens)) {
      if (this.data.tokens[tok].username === username) delete this.data.tokens[tok];
    }
    this.save();
  }

  // ---- site settings (branding, banner, ttl, maintenance) ----
  getSettings() {
    const s = Object.assign({}, DEFAULT_SETTINGS, this.data.settings || {});
    return {
      name: String(s.name || DEFAULT_SETTINGS.name),
      tagline: String(s.tagline || DEFAULT_SETTINGS.tagline),
      banner: String(s.banner || DEFAULT_SETTINGS.banner),
      ttlHours: Number(s.ttlHours) > 0 ? Number(s.ttlHours) : DEFAULT_SETTINGS.ttlHours,
      maintenance: !!s.maintenance
    };
  }

  updateSettings(patch) {
    if (patch && typeof patch === 'object') {
      this.data.settings = Object.assign({}, this.data.settings, patch);
      this.save();
    }
    return this.getSettings();
  }

  // ---- admin account (runtime password override) ----
  // Kept OUT of getSettings() so the hash never leaks through /api/settings.
  getAdminPassHash() {
    return (this.data.admin && this.data.admin.passHash) || null;
  }

  setAdminPassHash(hash) {
    this.data.admin = Object.assign({}, this.data.admin, { passHash: hash, updatedAt: Date.now() });
    this.save();
  }

  // ---- session tokens ----
  addToken(token, username, role, ttlMs) {
    this.data.tokens[token] = {
      username,
      role,
      expiresAt: Date.now() + ttlMs
    };
    this.save();
  }

  getToken(token) {
    const t = this.data.tokens[token];
    if (!t) return null;
    if (t.expiresAt && t.expiresAt < Date.now()) {
      delete this.data.tokens[token];
      this.save();
      return null;
    }
    return t;
  }

  revokeToken(token) {
    if (this.data.tokens[token]) {
      delete this.data.tokens[token];
      this.save();
    }
  }
}

module.exports = { Store };
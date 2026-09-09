/* admin.js — admin panel (old original layout) */
let timer = null;

async function api(url, opts) {
  const r = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { location.href = '/'; return null; }
  if (!r.ok) throw new Error((d && d.error) || 'Request failed');
  return d;
}

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
}

function timeAgo(ms) {
  if (!ms) return '—';
  const d = Date.now() - ms;
  const min = Math.floor(d / 60000);
  if (min < 60) return min + 'm ago';
  return Math.floor(min / 60) + 'h ago';
}

function btn(label, kind, onclick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = 'btn xs' + (kind ? ' ' + kind : '');
  b.onclick = onclick;
  return b;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function load() {
  let data;
  try {
    data = await api('/api/admin/users');
  } catch (e) {
    document.getElementById('adminMsg').textContent = e.message;
    return;
  }
  if (!data) return;
  document.getElementById('statsLine').innerHTML =
    `<b>${data.users.length}</b> user(s) · <b>${data.active}</b> RDP running · auto-expire after <b>${data.ttlHours} hr</b>` +
    (data.mock ? ' · MOCK MODE' : '');
  if (data.adminUser) {
    document.getElementById('adminUserLabel').textContent = data.adminUser;
  }

  const rows = document.getElementById('rows');
  rows.innerHTML = '';

  if (!data.users.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-row';
    empty.textContent = 'No users registered yet.';
    rows.appendChild(empty);
    return;
  }

  for (const u of data.users) {
    const row = document.createElement('div');
    row.className = 'list-row';

    const main = document.createElement('div');
    main.className = 'row-main';
    const name = document.createElement('p');
    name.className = 'row-name';
    name.textContent = u.session ? (u.session.name || u.username + '-vm') : u.username;
    const sub = document.createElement('p');
    sub.className = 'row-sub';
    sub.textContent = u.username + ((u.session ? ' · display :' + u.session.display + ' ·' : '')) + ' joined ' + timeAgo(u.createdAt);
    main.append(name, sub);

    const roleBadge = document.createElement('span');
    roleBadge.className = 'role-badge' + (u.role === 'admin' ? ' admin' : '');
    roleBadge.textContent = u.role;

    const rdpBadge = document.createElement('span');
    rdpBadge.className = 'badge ' + (u.session ? 'green' : 'mut');
    rdpBadge.textContent = u.session ? 'running' : 'stopped';

    const actions = document.createElement('div');
    actions.className = 'row-actions';

    if (u.session) {
      actions.appendChild(btn('Open', 'outline', () => { location.href = '/vnc/' + encodeURIComponent(u.username); }));
      actions.appendChild(btn('Stop', '', async () => {
        try { await api('/api/admin/users/' + encodeURIComponent(u.username) + '/stop', { method: 'POST' }); }
        catch (e) { alert(e.message); }
        load();
      }));
      actions.appendChild(btn('Delete RDP', 'danger', async () => {
        if (!confirm('Delete this RDP desktop for ' + u.username + '?')) return;
        try { await api('/api/admin/users/' + encodeURIComponent(u.username) + '/rdp', { method: 'DELETE' }); }
        catch (e) { alert(e.message); }
        load();
      }));
    } else {
      actions.appendChild(btn('Start', 'primary', async () => {
        try { await api('/api/admin/users/' + encodeURIComponent(u.username) + '/start', { method: 'POST' }); }
        catch (e) { alert(e.message); }
        load();
      }));
    }
    actions.appendChild(btn('Set Pass', 'outline', async () => {
      const np = prompt('New password for "' + u.username + '" (6-72 chars):');
      if (np === null) return;
      try { await api('/api/admin/users/' + encodeURIComponent(u.username) + '/password', { method: 'PUT', body: JSON.stringify({ newPassword: np }) }); }
      catch (e) { alert(e.message); return; }
      alert('Password updated for ' + u.username + '.');
    }));
    actions.appendChild(btn('Delete User', 'danger', async () => {
      if (!confirm('DELETE user "' + u.username + '" and their RDP? This cannot be undone.')) return;
      try { await api('/api/admin/users/' + encodeURIComponent(u.username), { method: 'DELETE' }); }
      catch (e) { alert(e.message); }
      load();
    }));

    row.append(main, roleBadge, rdpBadge, actions);
    rows.appendChild(row);
  }
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/';
}

// ---------- branding editor ----------
async function loadBranding() {
  try {
    const s = await api('/api/settings');
    if (!s) return;
    document.getElementById('sName').value = s.name || '';
    document.getElementById('sTag').value = s.tagline || '';
    // site settings card
    document.getElementById('sBanner').value = s.banner || '';
    document.getElementById('sTtl').value = s.ttlHours || 4;
    updateMaintUi(!!s.maintenance);
  } catch (_) { /* keep placeholders */ }
}

function updateMaintUi(on) {
  const btn = document.getElementById('maintBtn');
  const note = document.getElementById('maintNote');
  btn.textContent = on ? 'Turn maintenance OFF' : 'Turn maintenance ON';
  btn.className = 'btn xs ' + (on ? 'danger' : 'outline');
  note.textContent = on
    ? 'MAINTENANCE — regular users are blocked; only admin has access.'
    : 'Site is open — users can register & use VMs.';
  note.style.color = on ? 'hsl(0 84% 60%)' : '';
}

async function saveBranding() {
  const msg = document.getElementById('brandMsg');
  msg.className = 'err';
  msg.textContent = '';
  const name = document.getElementById('sName').value.trim();
  const tagline = document.getElementById('sTag').value.trim();
  if (!name) { msg.textContent = 'Site name is required.'; return; }
  try {
    const r = await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ name, tagline })
    });
    msg.className = 'oknote';
    msg.textContent = 'Saved — branding is now live across the site.';
    // re-apply branding on this page immediately
    document.getElementById('brandName').textContent = r.settings.name;
    document.title = 'Admin - ' + r.settings.name;
  } catch (e) {
    msg.textContent = e.message;
  }
}

// ---------- site settings (banner / ttl / maintenance) ----------
async function saveSettings(extra) {
  const msg = document.getElementById('setMsg');
  msg.className = 'err';
  msg.textContent = '';
  const banner = document.getElementById('sBanner').value.trim();
  const ttl = parseInt(document.getElementById('sTtl').value, 10);
  const patch = Object.assign({ banner }, extra || {});
  if (!Number.isNaN(ttl)) {
    if (ttl < 1 || ttl > 24) { msg.textContent = 'Expire time must be 1–24 hours.'; return; }
    patch.ttlHours = ttl;
  }
  try {
    const r = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(patch) });
    msg.className = 'oknote';
    msg.textContent = 'Saved — settings applied instantly.';
    updateMaintUi(!!r.settings.maintenance);
    load(); // refresh stats line with new ttl
  } catch (e) {
    msg.textContent = e.message;
  }
}

async function toggleMaintenance() {
  // read current state from the note text (updateMaintUi keeps it in sync)
  const on = document.getElementById('maintBtn').textContent.indexOf('OFF') !== -1;
  await saveSettings({ maintenance: !on });
}

document.getElementById('refreshBtn').onclick = () => load();
document.getElementById('saveBrandBtn').onclick = saveBranding;

async function saveAdminPass() {
  const msg = document.getElementById('adminPassMsg');
  msg.className = 'err';
  msg.textContent = '';
  const np = document.getElementById('aPass').value;
  if (!np) { msg.textContent = 'Enter a new password.'; return; }
  try {
    await api('/api/admin/password', { method: 'PUT', body: JSON.stringify({ newPassword: np }) });
    msg.className = 'oknote';
    msg.textContent = 'Admin password changed — use it on the next login.';
    document.getElementById('aPass').value = '';
  } catch (e) {
    msg.textContent = e.message;
  }
}
document.getElementById('saveAdminPassBtn').onclick = saveAdminPass;
document.getElementById('saveSetBtn').onclick = () => saveSettings();
document.getElementById('maintBtn').onclick = toggleMaintenance;
loadBranding();
load();
timer = setInterval(load, 15000);
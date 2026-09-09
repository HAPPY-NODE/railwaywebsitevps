/* dashboard.js — My VMs list (old original layout) */
let me = null;
let countdownTimer = null;

async function api(url, opts) {
  const r = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
  const d = await r.json();
  if (r.status === 401) { location.href = '/'; return null; }
  if (!r.ok) throw new Error((d && d.error) || 'Request failed');
  return d;
}

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${h}h ${p(m)}m ${p(s)}s`;
}

function iconBtn(svgPath, title, cls, onclick) {
  const b = document.createElement('button');
  b.className = 'icon-btn' + (cls ? ' ' + cls : '');
  b.title = title;
  b.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + svgPath + '</svg>';
  b.onclick = onclick;
  return b;
}

const ICONS = {
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"></rect><line x1="8" x2="16" y1="21" y2="21"></line><line x1="12" x2="12" y1="17" y2="21"></line>',
  square: '<rect width="18" height="18" x="3" y="3" rx="2"></rect>',
  trash: '<path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>'
};

async function load() {
  me = await api('/api/me');
  if (!me) return;
  document.querySelectorAll('.ttlLabel').forEach((el) => (el.textContent = me.ttlHours));
  if (me.role === 'admin') {
    document.getElementById('roleBadge').textContent = 'Admin';
    document.getElementById('adminBtn').hidden = false;
  }
  // live banner text from admin settings ({ttl} -> hours)
  try {
    const s = await api('/api/settings');
    if (s && s.banner) {
      const txt = String(s.banner).replace(/\{ttl\}/g, me.ttlHours).replace(/\*\*(.+?)\*\*/g, '$1');
      document.getElementById('bannerText').textContent = txt;
    }
  } catch (_) { /* keep static default */ }
  render(me.session);
}

function render(s) {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }

  const list = document.getElementById('vmList');
  list.innerHTML = '';

  if (!s) {
    const empty = document.createElement('div');
    empty.className = 'empty-row';
    empty.textContent = 'No VM yet — press New VM to boot your Ubuntu XFCE desktop.';
    list.appendChild(empty);
    return;
  }

  const row = document.createElement('div');
  row.className = 'list-row';

  const main = document.createElement('div');
  main.className = 'row-main';
  const name = document.createElement('p');
  name.className = 'row-name';
  name.textContent = s.name || (me.username + '-vm');
  const sub = document.createElement('p');
  sub.className = 'row-sub';
  sub.textContent = me.username + ' · display :' + s.display + ' · expires in ' + fmtDur(s.remainingSeconds);
  main.append(name, sub);

  const badge = document.createElement('span');
  badge.className = 'badge green';
  badge.textContent = 'started';

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.appendChild(iconBtn(ICONS.monitor, 'Launch Desktop', '', () => {
    location.href = '/vnc/' + encodeURIComponent(me.username);
  }));
  actions.appendChild(iconBtn(ICONS.square, 'Stop', '', async () => {
    try { await api('/api/sandbox/stop', { method: 'POST' }); load(); }
    catch (e) { alert(e.message); }
  }));
  actions.appendChild(iconBtn(ICONS.trash, 'Delete', 'danger', async () => {
    if (!confirm('Delete this VM? It will be stopped and removed.')) return;
    try { await api('/api/sandbox', { method: 'DELETE' }); load(); }
    catch (e) { alert(e.message); }
  }));

  row.append(main, badge, actions);
  list.appendChild(row);

  countdownTimer = setInterval(() => {
    const rem = (s.remainingSeconds || 0) - 1;
    s.remainingSeconds = Math.max(0, rem);
    sub.textContent = me.username + ' · display :' + s.display + ' · expires in ' + fmtDur(rem);
    if (rem <= 0) load();
  }, 1000);
}

async function newVm() {
  const err = document.getElementById('err');
  err.textContent = '';
  if (me.session) { err.textContent = 'Limit reached (1 VM). Stop or delete the running one first.'; return; }
  openVmModal();
}

/* ---------- New VM modal (small in-page panel, same theme) ---------- */
function openVmModal() {
  document.getElementById('vmModalErr').textContent = '';
  document.getElementById('vmNameInput').value = me.username + '-vm';
  document.getElementById('vmModal').classList.add('active');
  setTimeout(() => document.getElementById('vmNameInput').focus(), 0);
}

function closeVmModal() {
  document.getElementById('vmModal').classList.remove('active');
}

async function createVm() {
  const err = document.getElementById('vmModalErr');
  const logPanel = document.getElementById('vmLogPanel');
  const logLines = document.getElementById('vmLogLines');
  const logStatus = document.getElementById('vmLogStatus');
  err.textContent = '';
  const btnEl = document.getElementById('vmCreateBtn');

  const vmName = document.getElementById('vmNameInput').value.trim() || (me.username + '-vm');
  btnEl.disabled = true;

  try {
    // start the desktop
    await api('/api/sandbox/start', { method: 'POST', body: JSON.stringify({ name: vmName }) });
    closeVmModal();

        // show live-boot log panel
    logPanel.classList.add('active');
    logLines.innerHTML = '';
    logStatus.textContent = 'BOOTING…';

    // poll logs until the job finishes or fails
    let since = 0;
    const poll = async () => {
      try {
        const r = await fetch('/api/sandbox/start-job-logs?since=' + since);
        const d = await r.json();
        since = d.total || 0;
        appendLogLines(d.logs || []);
        if (d.error) {
          logStatus.textContent = 'FAILED';
          logStatus.className = 'log-status fail';
          logStatus.textContent = 'FAILED — ' + d.error;
          return;
        }
        if (d.status === 'running') {
          logStatus.textContent = 'RUNNING';
          logStatus.className = 'log-status ok';
          // redirect to the desktop-ready page
          setTimeout(() => { window.location.href = '/desktop.html'; }, 800);
          return;
        }
        // still starting — continue polling
        setTimeout(poll, 600);
      } catch (_) {
        setTimeout(poll, 600);
      }
    };
    poll();
    await load();
  } catch (e) {
    err.textContent = e.message;
  }
  btnEl.disabled = false;
}

function appendLogLines(lines) {
  const logLines = document.getElementById('vmLogLines');
  for (const line of lines) {
    const t = document.createElement('div');
    t.className = 'log-line';
    t.appendChild(document.createTextNode(line));
    logLines.appendChild(t);
  }
  logLines.scrollTop = logLines.scrollHeight;
}

document.getElementById('vmCancelBtn').onclick = closeVmModal;
document.getElementById('vmCreateBtn').onclick = createVm;
document.getElementById('vmNameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createVm();
  if (e.key === 'Escape') closeVmModal();
});

// Close button on the live log panel
const logPanelEl = document.getElementById('vmLogPanel');
if (logPanelEl) {
  const closeEl = logPanelEl.querySelector('#vmLogClose') || document.getElementById('vmLogClose');
  if (closeEl) closeEl.onclick = () => logPanelEl.classList.remove('active');
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/';
}

document.getElementById('refreshBtn').onclick = () => load();
document.getElementById('newVmBtn').onclick = newVm;
load();
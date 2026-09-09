/* dashboard.js - My VMs list with file manager */
let me = null;
let countdownTimer = null;
let createPollTimer = null;

async function api(url, opts) {
  const r = await fetch(url, Object.assign({ headers: { "Content-Type": "application/json" } }, opts || {}));
  const d = await r.json();
  if (r.status === 401) { location.href = "/"; return null; }
  if (!r.ok) throw new Error((d && d.error) || "Request failed");
  return d;
}

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return `${h}h ${p(m)}m ${p(s)}s`;
}

function iconBtn(svgPath, title, cls, onclick) {
  const b = document.createElement("button");
  b.className = "icon-btn" + (cls ? " " + cls : "");
  b.title = title;
  b.innerHTML = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">" + svgPath + "</svg>";
  b.onclick = onclick;
  return b;
}

const ICONS = {
  monitor: "<rect width=\"20\" height=\"14\" x=\"2\" y=\"3\" rx=\"2\"></rect><line x1=\"8\" x2=\"16\" y1=\"21\" y2=\"21\"></line><line x1=\"12\" x2=\"12\" y1=\"17\" y2=\"21\"></line>",
  square: "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"></rect>",
  trash: "<path d=\"M10 11v6\"></path><path d=\"M14 11v6\"></path><path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\"></path><path d=\"M3 6h18\"></path><path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"></path>",
  folder: "<path d=\"M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z\"></path>",
  upload: "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"></path><polyline points=\"17 8 12 3 7 8\"></polyline><line x1=\"12\" x2=\"12\" y1=\"3\" y2=\"15\"></line>",
  file: "<path d=\"M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z\"></path><polyline points=\"14 2 14 8 20 8\"></polyline>"
};

async function load() {
  me = await api("/api/me");
  if (!me) return;
  document.querySelectorAll(".ttlLabel").forEach((el) => (el.textContent = me.ttlHours));
  if (me.role === "admin") {
    document.getElementById("roleBadge").textContent = "Admin";
    document.getElementById("adminBtn").hidden = false;
  }
  try {
    const s = await api("/api/settings");
    if (s && s.banner) {
      const txt = String(s.banner).replace(/\{ttl\}/g, me.ttlHours).replace(/\*\*(.+?)\*\*/g, "$1");
      document.getElementById("bannerText").textContent = txt;
    }
  } catch (_) {}
  render(me.session);
}

function render(s) {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  const list = document.getElementById("vmList");
  list.innerHTML = "";
  if (!s) {
    const empty = document.createElement("div");
    empty.className = "empty-row";
    empty.textContent = "No VM yet - press New VM to boot your Ubuntu XFCE desktop.";
    list.appendChild(empty);
    return;
  }
  const row = document.createElement("div");
  row.className = "list-row";
  const main = document.createElement("div");
  main.className = "row-main";
  const name = document.createElement("p");
  name.className = "row-name";
  name.textContent = s.name || (me.username + "-vm");
  const sub = document.createElement("p");
  sub.className = "row-sub";
  sub.textContent = me.username + " - display :" + s.display + " - expires in " + fmtDur(s.remainingSeconds);
  main.append(name, sub);
  const badge = document.createElement("span");
  badge.className = "badge green";
  badge.textContent = "started";
  const actions = document.createElement("div");
  actions.className = "row-actions";
  actions.appendChild(iconBtn(ICONS.monitor, "Launch Desktop", "", () => {
    window.open("/vnc/" + encodeURIComponent(me.username), "_blank");
  }));
  actions.appendChild(iconBtn(ICONS.folder, "File Manager", "", () => {
    openFileManager();
  }));
  actions.appendChild(iconBtn(ICONS.square, "Stop", "danger", async () => {
    await api("/api/sandbox/stop", { method: "POST" });
    await load();
  }));
  row.append(main, badge, actions);
  list.appendChild(row);
  countdownTimer = setInterval(() => {
    const subEl = row.querySelector(".row-sub");
    if (subEl && me.session) {
      me.session.remainingSeconds = Math.max(0, me.session.remainingSeconds - 1);
      subEl.textContent = me.username + " - display :" + me.session.display + " - expires in " + fmtDur(me.session.remainingSeconds);
    }
  }, 1000);
}

/* ---------- File Manager ---------- */
function openFileManager() {
  const modal = document.createElement("div");
  modal.className = "modal active";
  modal.id = "fileModal";
  modal.innerHTML = `
    <div class="modal-box" style="width:600px;max-width:95vw;">
      <h3>File Manager - ${me.username}</h3>
      <div id="fileList" style="max-height:300px;overflow-y:auto;border:1px solid #333;border-radius:8px;padding:12px;margin:12px 0;"></div>
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <input type="file" id="fileInput" style="flex:1;">
        <button class="btn primary" id="uploadBtn">Upload</button>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn" id="fileCloseBtn">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById("fileCloseBtn").onclick = () => modal.remove();
  document.getElementById("uploadBtn").onclick = uploadFile;
  loadFiles();
}

async function loadFiles() {
  try {
    const r = await api("/api/files");
    const list = document.getElementById("fileList");
    list.innerHTML = "";
    if (!r.files || r.files.length === 0) {
      list.innerHTML = "<p style=\"color:#888;text-align:center;\">No files yet</p>";
      return;
    }
    for (const f of r.files) {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.justifyContent = "space-between";
      row.style.alignItems = "center";
      row.style.padding = "8px";
      row.style.borderBottom = "1px solid #333";
      row.innerHTML = `<span>${f.name}</span><div><a href="/api/files/download?name=${encodeURIComponent(f.name)}" class="btn" style="padding:4px 8px;margin-right:4px;">Download</a><button class="btn danger" style="padding:4px 8px;" onclick="deleteFile('${f.name}')">Delete</button></div>`;
      list.appendChild(row);
    }
  } catch (e) {
    document.getElementById("fileList").innerHTML = "<p style=\"color:#f55;\">Error loading files</p>";
  }
}

async function uploadFile() {
  const input = document.getElementById("fileInput");
  if (!input.files.length) return alert("Select a file first");
  const fd = new FormData();
  fd.append("file", input.files[0]);
  try {
    await fetch("/api/files/upload", { method: "POST", body: fd });
    input.value = "";
    loadFiles();
  } catch (e) {
    alert("Upload failed");
  }
}

async function deleteFile(name) {
  if (!confirm("Delete " + name + "?")) return;
  try {
    await api("/api/files/delete", { method: "POST", body: JSON.stringify({ name }) });
    loadFiles();
  } catch (e) {
    alert("Delete failed");
  }
}

/* ---------- New VM modal ---------- */
function openVmModal() {
  document.getElementById("vmModalErr").textContent = "";
  document.getElementById("vmNameInput").value = me.username + "-vm";
  document.getElementById("vmModal").classList.add("active");
  setTimeout(() => document.getElementById("vmNameInput").focus(), 0);
}

function closeVmModal() {
  document.getElementById("vmModal").classList.remove("active");
}

async function createVm() {
  const err = document.getElementById("vmModalErr");
  const logPanel = document.getElementById("vmLogPanel");
  const logLines = document.getElementById("vmLogLines");
  const logStatus = document.getElementById("vmLogStatus");
  err.textContent = "";
  const btnEl = document.getElementById("vmCreateBtn");
  const vmName = document.getElementById("vmNameInput").value.trim() || (me.username + "-vm");
  btnEl.disabled = true;
  btnEl.textContent = "Creating...";
  try {
    logPanel.classList.add("active");
    logLines.innerHTML = "";
    logStatus.textContent = "STARTING...";
    logStatus.className = "log-status";
    // Start the desktop (returns immediately, desktop boots in background)
    await api("/api/sandbox/start", { method: "POST", body: JSON.stringify({ name: vmName }) });
    closeVmModal();
    let since = 0;
    let failCount = 0;
    const poll = async () => {
      try {
        const r = await fetch("/api/sandbox/start-job-logs?since=" + since);
        if (!r.ok) throw new Error("poll failed");
        const d = await r.json();
        since = d.total || 0;
        appendLogLines(d.logs || []);
        if (d.error) {
          logStatus.textContent = "FAILED - " + d.error;
          logStatus.className = "log-status fail";
          btnEl.disabled = false;
          btnEl.textContent = "Create VM";
          return;
        }
        if (d.status === "running") {
          logStatus.textContent = "RUNNING!";
          logStatus.className = "log-status ok";
          setTimeout(() => { window.location.href = "/desktop.html"; }, 1000);
          return;
        }
        failCount = 0;
        createPollTimer = setTimeout(poll, 800);
      } catch (e) {
        failCount++;
        if (failCount > 10) {
          logStatus.textContent = "ERROR - " + e.message;
          logStatus.className = "log-status fail";
          btnEl.disabled = false;
          btnEl.textContent = "Create VM";
          return;
        }
        createPollTimer = setTimeout(poll, 800);
      }
    };
    poll();
  } catch (e) {
    err.textContent = e.message;
    btnEl.disabled = false;
    btnEl.textContent = "Create VM";
  }
}

function appendLogLines(lines) {
  const logLines = document.getElementById("vmLogLines");
  for (const line of lines) {
    const t = document.createElement("div");
    t.className = "log-line";
    t.appendChild(document.createTextNode(line));
    logLines.appendChild(t);
  }
  logLines.scrollTop = logLines.scrollHeight;
}

document.getElementById("vmCancelBtn").onclick = closeVmModal;
document.getElementById("vmCreateBtn").onclick = createVm;
document.getElementById("vmNameInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") createVm();
  if (e.key === "Escape") closeVmModal();
});

const logPanelEl = document.getElementById("vmLogPanel");
if (logPanelEl) {
  const closeEl = logPanelEl.querySelector("#vmLogClose") || document.getElementById("vmLogClose");
  if (closeEl) closeEl.onclick = () => logPanelEl.classList.remove("active");
}

async function logout() {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/";
}

document.getElementById("refreshBtn").onclick = () => load();
document.getElementById("newVmBtn").onclick = openVmModal;
load();
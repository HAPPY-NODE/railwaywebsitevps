# HAPPY NODE — Ubuntu XFCE RDP on Railway

A complete, self-hosted web portal that gives **every registered user one
private Ubuntu XFCE remote desktop**, accessible from any browser through a
single public URL (the Railway auto-URL, or your own custom domain).

Each desktop **auto-expires after 4 hours** (configurable) and the user just
presses **Start Desktop** again. An **Admin panel** (`/admin`) lists every user
with their RDP and gives **Start / Stop / Delete RDP / Delete User** buttons.

Everything runs in **one** Railway service / one container, so Railway creates
the public URL and port-forwarding automatically.

---

## What you get

| Feature | Detail |
|---|---|
| Per-user RDP | 1 private XFCE desktop per account (enforced) |
| Access | Browser-based web desktop behind your URL (HTTP + WebSocket) |
| Expiry | Auto-kill after `SESSION_HOURS` (default `4` hours); restart anytime |
| Admin panel | `/admin` — all users, live status, countdown, Start/Stop/Delete RDP, Delete User |
| Auth | Register/Login, bcrypt-hashed passwords, HTTP-only session cookie |
| Persistence | Users/sessions stored in `/data` (Railway Volume) |
| Frontend | Rebuilt "HAPPY NODE" portal — clean black shadcn-style UI, zero animation, no external fonts/frameworks (fast load) |
| Branding | Site name + tagline are editable from the admin panel (Branding card), saved to `/data`, applied on every page live |

---

## How it works (architecture)

```
Browser â”€â”€â–º https://<your-site>  (custom domain CNAME â†’ Railway URL)
                â”‚
          Railway Service  (one container, port $PORT auto-forwarded)
                â”‚  express app
                â”œâ”€ /            login/register/dashboard/admin pages
                â”œâ”€ /api/*       auth + sandbox + admin JSON API
                â””â”€ /vnc/<user>/*  reverse proxy (HTTP + WebSocket)
                          â”‚
          per-user desktop spawned inside the SAME container:
          Xvfb :1  +  KasmVNC web server on a private port
                 â””â”€ Ubuntu XFCE session (linuxserver/webtop base)
```

Because only `$PORT` is exposed to the internet by Railway, every user's private
VNC port stays internal; users reach their desktop only through the
authenticated `/vnc/<user>/…` proxy path — one user cannot open another's RDP.

---

## 1. Deploy to Railway (Git + auto URL)

Railway natively detects the `Dockerfile` in this repo — no port config needed.

1. **Create a GitHub repo** and push these files:
   ```bash
   git init
   git add .
   git commit -m "HAPPY NODE - Ubuntu XFCE RDP on Railway"
   git branch -M main
   git remote add origin https://github.com/<YOU>/<REPO>.git
   git push -u origin main
   ```
2. Go to [railway.app](https://railway.app) â†’ **New Project** â†’ **Deploy from
   GitHub repo** â†’ pick the repo. Railway will:
   - detect `Dockerfile` (builder is already set in `railway.toml`),
   - build the image (pulls `lscr.io/linuxserver/webtop:ubuntu-xfce-kasm` + installs
     Node 20 + the app; first build can take 5–15 min),
   - generate a public `https://<service>.up.railway.app` URL and forward the
     container's `$PORT` to it **automatically**. âœ…

3. **Settings you must set (Deploy â†’ Variables):**
   | Variable | Value | Note |
   |---|---|---|
   | `ADMIN_PASSWORD` | `admin123` built-in | optional — set a stronger one for production |
   | `ADMIN_USER` | `admin` built-in | optional — admin login username |
   | `SESSION_HOURS` | `4` | auto-expire hours (3–4 works great) |
   | `VNC_BASE_PORT` | `7001` | internal per-VM web port base (do NOT use 3000/3001 — webtop's own KasmVNC) |
   | `VNC_BASE_DISPLAY` | `20` | internal X display base (do NOT use 1 — webtop's own desktop is on :1) |
   | `RES_WIDTH` / `RES_HEIGHT` | `1280` / `720` | desktop resolution |
   | `PORT` | `8080` | Railway sets this itself; don't change |
   | `COOKIE_SECURE` | `true` | set it so cookies are HTTPS-only |

4. **Add a Volume (recommended)** so users survive restarts:
   Railway dashboard â†’ your service â†’ **Volumes** â†’ **New Volume** â†’
   mount point **`/data`**. The app stores its JSON database in `/data`.

5. **Disable the default healthcheck** or leave it — the app already serves
   `200 OK` on `/api/health` (set in `railway.toml`).

6. Open the generated **`.up.railway.app`** URL â†’ register a user â†’ Start â†’
   Enter your XFCE desktop. Done. ðŸŽ‰

### Scale
Set the service to **1 replica** (more replicas do not share the in-memory
session map).

---

## 2. Put it behind your own domain (optional)

1. In your **Cloudflare** DNS: add
   ```
   CNAME  <subdomain>   â†’  <your-service>.up.railway.app
   ```
   (disable the Cloudflare proxy / set **DNS only** first, or keep the orange
   cloud on with **SSL â†’ Full (strict)** — both work; Full (strict) is safest).
2. In **Railway**: your domain now points at the service. Use the Railway URL
   directly, or add the custom domain in Railway â†’ **Settings â†’ Domains**.
3. Open `https://<your-site>` — the portal serves there, and the WebSocket
   desktop feed works too (it proxies through the same HTTPS URL).

---

## 3. Environment variables (all optional — sensible built-in defaults)

| Variable | Default | Description |
|---|---|---|
| `ADMIN_USER` | `admin` | Admin login username (built-in) |
| `ADMIN_PASSWORD` | `admin123` | Admin login password (built-in — change for production!) |
| `SESSION_HOURS` | `4` | RDP lifetime in hours |
| `RES_WIDTH` | `1280` | Desktop width |
| `RES_HEIGHT` | `720` | Desktop height |
| `VNC_BASE_PORT` | `3001` | First user desktop port |
| `DATA_DIR` | `/data` | Persistence folder |
| `SITE_NAME` | `HAPPY NODE` | Default site name (can be edited later in the admin panel) |
| `SITE_TAGLINE` | `Ubuntu XFCE remote desktops` | Default tagline (editable in the admin panel) |
| `PORT` | `8080` | Web port (Railway sets this automatically) |
| `MOCK_VNC` | unset | `1` = virtual desktops (local testing only) |

---

## 4. Deploy on a VPS (Docker)

```bash
# build & run (port 8080)
docker build -t happy-node .
docker run -d --name happy-node \
  -p 8080:8080 \
  -v happy-node-data:/data \
  -e SESSION_HOURS=4 \
  --restart unless-stopped \
  happy-node
```

Then put Nginx / Caddy / Cloudflare in front for HTTPS. WebSocket desktop
feeds proxy through the same port, so a plain reverse proxy is enough.

Admin login (built-in): **admin / admin123** — change it in production by
setting `ADMIN_USER` / `ADMIN_PASSWORD` environment variables.

---

## 5. Run from source (no Docker)

```bash
npm install
node src/server.js
```

Open http://localhost:8080 — register a user and start a desktop. (Set
`MOCK_VNC=1` to test without a real XFCE environment.)

---

## 6. Project layout

```
Dockerfile              -> webtop (Ubuntu XFCE) + Node 20 + app
railway.toml            -> Railway build/deploy config (Dockerfile builder)
scripts/startup.sh      -> container entrypoint (starts the Node app)
scripts/start-session.sh-> spawns Xvfb + KasmVNC for one user
scripts/stop-session.sh -> kills one user's desktop
src/server.js           -> Express app + VNC reverse proxy + admin API
src/sessions.js         -> per-user desktop lifecycle + TTL sweep
src/auth.js / store.js  -> auth + JSON persistence (/data)
public/                 -> portal pages (login, register, dashboard, admin)
```

---

## License

This project is released under the **MIT License** — see [LICENSE](LICENSE).
You are free to use, modify, and self-host it (including commercially), as
long as the copyright notice stays intact.

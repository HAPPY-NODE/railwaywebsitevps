#!/usr/bin/env bash
# start-session.sh - boot a single per-user Ubuntu/XFCE desktop
# Uses TigerVNC (tigervnc-standalone-server) on plain Ubuntu
# NO PASSWORD - direct connect
set -uo pipefail

DISPLAY_NUM="${1:-20}"
WEBPORT="${2:-7001}"
WIDTH="${3:-1280}"
HEIGHT="${4:-720}"
VMNAME="${5:-desktop}"

# Validate dimensions
WIDTH=$((WIDTH + 0))
HEIGHT=$((HEIGHT + 0))
[ "$WIDTH" -lt 320 ] && WIDTH=1280
[ "$HEIGHT" -lt 240 ] && HEIGHT=720

VNC_USER="${VNC_USER:-abc}"
VNC_HOME="${VNC_HOME:-/home/abc}"
PID_FILE="/tmp/vnc-${DISPLAY_NUM}.pid"
LOG_FILE="/tmp/happynode-session-${VMNAME:-desktop}.log"

export DISPLAY=":${DISPLAY_NUM}"
export HOME="${VNC_HOME}"
export USER="${VNC_USER}"
export LOGNAME="${VNC_USER}"

echo "=== Desktop Startup ==="
echo "Display: :${DISPLAY_NUM}"
echo "WebSocket Port: ${WEBPORT}"
echo "Resolution: ${WIDTH}x${HEIGHT}"
echo "VM Name: ${VMNAME}"
echo "VNC Home: ${VNC_HOME}"
echo "PID File: ${PID_FILE}"

# Ensure VNC dir exists
mkdir -p "${VNC_HOME}/.vnc"
chown -R "${VNC_USER}:${VNC_USER}" "${VNC_HOME}/.vnc" 2>/dev/null || true

# Ensure xstartup exists
if [ ! -f "${VNC_HOME}/.vnc/xstartup" ]; then
  cat > "${VNC_HOME}/.vnc/xstartup" <<'XEOF'
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
export XKL_XMODMAP_DISABLE=1
exec startxfce4
XEOF
  chmod +x "${VNC_HOME}/.vnc/xstartup"
  chown "${VNC_USER}:${VNC_USER}" "${VNC_HOME}/.vnc/xstartup" 2>/dev/null || true
fi

# --- Check for conflicts ---
echo "--- Checking for conflicts ---"
DISPLAY_SOCKET="/tmp/.X11-unix/X${DISPLAY_NUM}"
LOCK_FILE="/tmp/.X${DISPLAY_NUM}-lock"

[ -e "$DISPLAY_SOCKET" ] && echo "Display Socket: EXISTS" || echo "Display Socket: none"
[ -f "$LOCK_FILE" ] && echo "Lock File: EXISTS" || echo "Lock File: none"

# Check for existing VNC on this display
EXISTING_VNCS=$(pgrep -f "Xvnc.*:${DISPLAY_NUM}" 2>/dev/null | tr '\n' ' ')
[ -n "$EXISTING_VNCS" ] && echo "Existing VNC: $EXISTING_VNCS" || echo "Existing VNC: none"

# Check port - initialize to empty to avoid unbound variable with set -u
PORT_PID=""
if command -v ss >/dev/null 2>&1; then
  PORT_PID=$(ss -tlnp 2>/dev/null | grep ":${WEBPORT}" | grep -oP 'pid=\K[0-9]+' | head -1)
fi
[ -n "$PORT_PID" ] && echo "Port ${WEBPORT}: in use by PID $PORT_PID" || echo "Port ${WEBPORT}: free"

# --- Clean up conflicts ---
echo "--- Cleaning stale state ---"

# Kill existing VNC on this display
if [ -n "$EXISTING_VNCS" ]; then
  echo "Killing existing VNC: $EXISTING_VNCS"
  kill -TERM $EXISTING_VNCS 2>/dev/null || true
  sleep 2
  kill -9 $EXISTING_VNCS 2>/dev/null || true
fi

# Kill process on port if it is VNC
if [ -n "$PORT_PID" ] && kill -0 "$PORT_PID" 2>/dev/null; then
  if grep -q Xvnc /proc/$PORT_PID/cmdline 2>/dev/null; then
    echo "Killing VNC on port ${WEBPORT}"
    kill -9 "$PORT_PID" 2>/dev/null || true
  fi
fi

# Clean stale files
rm -f "$DISPLAY_SOCKET" "$LOCK_FILE" 2>/dev/null || true
rm -rf /tmp/.X${DISPLAY_NUM}-lock 2>/dev/null || true

sleep 1

# --- Verify clean ---
echo "--- Verifying clean state ---"
if [ -e "$DISPLAY_SOCKET" ]; then
  echo "ERROR: Display socket still exists"
  exit 1
fi
PORT_CHECK=$(ss -tln 2>/dev/null | grep ":${WEBPORT} ")
if [ -n "$PORT_CHECK" ]; then
  echo "ERROR: Port ${WEBPORT} still in use"
  exit 1
fi
echo "State clean"

# --- Start VNC server (NO PASSWORD) ---
echo "--- Starting TigerVNC (no auth) ---"

# TigerVNC calculates the port as 5900 + display number
VNC_PORT=$((5900 + DISPLAY_NUM))

echo "VNC Port: ${VNC_PORT}"
echo "Command: /usr/bin/Xvnc :${DISPLAY_NUM} -geometry ${WIDTH}x${HEIGHT} -depth 24 -rfbport ${VNC_PORT} -localhost no -desktop ${VMNAME} -AlwaysShared -AcceptKeyEvents -SecurityTypes None"

# Start Xvnc WITHOUT password
/usr/bin/Xvnc ":${DISPLAY_NUM}" \
  -geometry "${WIDTH}x${HEIGHT}" \
  -depth 24 \
  -rfbport "$VNC_PORT" \
  -localhost no \
  -desktop "${VMNAME}" \
  -AlwaysShared \
  -AcceptKeyEvents \
  -SecurityTypes None \
  >"$LOG_FILE" 2>&1 &

VNC_PID=$!
echo "$VNC_PID" > "$PID_FILE"
echo "Xvnc PID: $VNC_PID"

# Wait for VNC port
PORT_OK=0
for i in $(seq 1 30); do
  if (echo > "/dev/tcp/127.0.0.1/${VNC_PORT}") 2>/dev/null; then
    PORT_OK=1
    echo "VNC ready (port ${VNC_PORT} open after ${i}s)"
    break
  fi
  if ! kill -0 "$VNC_PID" 2>/dev/null; then
    echo "ERROR: Xvnc exited"
    cat "$LOG_FILE" 2>/dev/null || true
    rm -f "$PID_FILE"
    exit 1
  fi
  sleep 1
done

if [ "$PORT_OK" -eq 0 ]; then
  echo "ERROR: VNC port never opened"
  cat "$LOG_FILE" 2>/dev/null || true
  kill -9 "$VNC_PID" 2>/dev/null || true
  rm -f "$PID_FILE"
  exit 1
fi

# --- Start XFCE Desktop ---
echo "--- Starting XFCE Desktop ---"

# Start XFCE in the background
"${VNC_HOME}/.vnc/xstartup" &
XFCE_PID=$!
echo "XFCE PID: $XFCE_PID"

# Wait for XFCE to start (check for xfce4-session)
XFCE_OK=0
for i in $(seq 1 30); do
  if pgrep -x xfce4-session >/dev/null 2>&1; then
    XFCE_OK=1
    echo "XFCE desktop ready (after ${i}s)"
    break
  fi
  if ! kill -0 "$XFCE_PID" 2>/dev/null; then
    echo "WARNING: XFCE process exited, but may have started successfully"
    XFCE_OK=1
    break
  fi
  sleep 1
done

if [ "$XFCE_OK" -eq 0 ]; then
  echo "WARNING: XFCE may not have started properly, but continuing..."
fi

# --- Start noVNC websockify ---
echo "--- Starting noVNC websockify ---"

# websockify translates WebSocket -> VNC TCP
/usr/bin/websockify \
  --web /usr/share/novnc \
  "$WEBPORT" \
  "localhost:${VNC_PORT}" \
  > "/tmp/novnc-${WEBPORT}.log" 2>&1 &

NOVNC_PID=$!
echo "$NOVNC_PID" >> "$PID_FILE"
echo "noVNC PID: $NOVNC_PID"

# Wait for websocket port
WS_OK=0
for i in $(seq 1 10); do
  if (echo > "/dev/tcp/127.0.0.1/${WEBPORT}") 2>/dev/null; then
    WS_OK=1
    echo "WebSocket ready (port ${WEBPORT} open after ${i}s)"
    break
  fi
  sleep 1
done

if [ "$WS_OK" -eq 0 ]; then
  echo "ERROR: WebSocket port never opened"
  cat "/tmp/novnc-${WEBPORT}.log" 2>/dev/null || true
  kill -9 "$VNC_PID" "$NOVNC_PID" 2>/dev/null || true
  rm -f "$PID_FILE"
  exit 1
fi

echo "=== Desktop ready ==="
echo "Display: :${DISPLAY_NUM}"
echo "VNC Port: ${VNC_PORT}"
echo "WebSocket Port: ${WEBPORT}"
echo "Xvnc PID: $VNC_PID"
echo "XFCE PID: $XFCE_PID"
echo "noVNC PID: $NOVNC_PID"
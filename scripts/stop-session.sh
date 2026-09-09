#!/bin/bash
# stop-session.sh - stop a desktop session and clean up
# Usage: stop-session.sh <display> [webport] [vmName]
set -u

DISPNUM="${1:?display number required}"
WEBPORT="${2:-}"
VMNAME="${3:-desktop}"
PID_FILE="/tmp/vnc-${DISPNUM}.pid"
VNC_PORT=$((5900 + DISPNUM))

echo "[stop] stopping display=:${DISPNUM} webport=${WEBPORT} name=${VM_NAME}"

# Kill by PID file
if [ -f "$PID_FILE" ]; then
  while IFS= read -r pid; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "[stop] killing PID $pid"
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

# Kill any remaining Xvnc on this display
if command -v pkill >/dev/null 2>&1; then
  pkill -f "Xvnc.*:${DISPNUM}( |$)" 2>/dev/null || true
fi

# Kill websockify on this port
if [ -n "$WEBPORT" ] && command -v pkill >/dev/null 2>&1; then
  pkill -f "websockify.*${WEBPORT}" 2>/dev/null || true
fi

# Try vncserver kill
if command -v vncserver >/dev/null 2>&1; then
  vncserver -kill ":${DISPNUM}" 2>/dev/null || true
fi

# Clean up stale files
echo "[stop] cleaning stale files"
rm -f "/tmp/.X${DISPNUM}-lock" "/tmp/.X11-unix/X${DISPNUM}" 2>/dev/null || true
rm -f "/tmp/happynode-session-${VMNAME:-desktop}.log" 2>/dev/null || true
rm -f "/tmp/novnc-${WEBPORT}.log" 2>/dev/null || true

# Kill any XFCE processes for this display
if command -v pkill >/dev/null 2>&1; then
  pkill -f "xfce.*:${DISPNUM}" 2>/dev/null || true
  pkill -f "startxfce4" 2>/dev/null || true
fi

sleep 1
echo "[stop] done"
exit 0
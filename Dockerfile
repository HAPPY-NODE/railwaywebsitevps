# syntax=docker/dockerfile:1
# HAPPY NODE - Ubuntu XFCE RDP portal for Railway
# Base = plain Ubuntu (no s6/webtop) for full control over VNC sessions

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PORT=8080 \
    DATA_DIR=/data \
    DISPLAY=:1 \
    VNC_USER=abc \
    VNC_HOME=/home/abc \
    VNC_PW=password

# --- System packages: XFCE, VNC, D-Bus, etc. (NO nodejs here) ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg wget \
    software-properties-common apt-transport-https \
    xfce4 xfce4-terminal xfce4-goodies \
    dbus-x11 dbus-user-session \
    xfonts-base xfonts-75dpi xfonts-100dpi \
    fonts-noto-color-emoji fonts-noto-cjk \
    novnc websockify \
    tigervnc-standalone-server tigervnc-common tigervnc-viewer \
    net-tools lsof psmisc \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# --- Install Node.js 20 from NodeSource ---
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# --- Create VNC user ---
RUN useradd -m -s /bin/bash $VNC_USER \
    && mkdir -p $VNC_HOME/.vnc \
    && echo "$VNC_USER:$VNC_PW" | chpasswd \
    && chown -R $VNC_USER:$VNC_USER $VNC_HOME

# --- Runtime directories ---
RUN mkdir -p /app /data $VNC_HOME/.vnc \
    && chmod 777 /data \
    && chown -R $VNC_USER:$VNC_USER $VNC_HOME

WORKDIR /app

# --- App code ---
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force 2>/dev/null || true

COPY . .

RUN chmod +x /app/scripts/*.sh \
    && ln -sf /app/public/logo.svg /app/public/favicon.svg || true

# --- VNC config for user ---
RUN echo "$VNC_PW" | /usr/bin/vncpasswd -f > $VNC_HOME/.vnc/passwd \
    && chmod 600 $VNC_HOME/.vnc/passwd \
    && chown -R $VNC_USER:$VNC_USER $VNC_HOME/.vnc

# --- XFCE xstartup for VNC ---
RUN cat > $VNC_HOME/.vnc/xstartup <<'EOF'
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
export XKL_XMODMAP_DISABLE=1
exec startxfce4
EOF
RUN chmod +x $VNC_HOME/.vnc/xstartup \
    && chown $VNC_USER:$VNC_USER $VNC_HOME/.vnc/xstartup

EXPOSE 8080

# --- Healthcheck for Railway ---
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/api/health || exit 1

ENTRYPOINT ["/app/scripts/startup.sh"]
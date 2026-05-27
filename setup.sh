#!/usr/bin/env bash
# PulseWatch installer — run as root on Ubuntu/Debian/RHEL/Rocky
set -e

# ── Detect OS ──────────────────────────────────────────────────────────────────
if   command -v apt-get &>/dev/null; then PKG=apt
elif command -v dnf     &>/dev/null; then PKG=dnf
elif command -v yum     &>/dev/null; then PKG=yum
else echo "Unsupported package manager. Install Node.js 18+ manually."; exit 1
fi

# ── Install Node.js if missing ─────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "[1/5] Installing Node.js..."
  if [ "$PKG" = "apt" ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    $PKG install -y nodejs
  fi
else
  echo "[1/5] Node.js $(node -v) already installed — skipping."
fi

# ── Check for port 80 conflict (e.g. Nginx Proxy Manager in Docker) ───────────
PORT80_IN_USE=false
if ss -tlnp 2>/dev/null | grep -q ':80 ' || netstat -tlnp 2>/dev/null | grep -q ':80 '; then
  PORT80_IN_USE=true
fi

# ── Install nginx if missing and port 80 is free ──────────────────────────────
if [ "$PORT80_IN_USE" = "true" ]; then
  echo "[2/5] Port 80 already in use (Nginx Proxy Manager?) — skipping nginx setup."
  echo "      → Point your proxy to http://127.0.0.1:3000 to expose PulseWatch."
elif ! command -v nginx &>/dev/null; then
  echo "[2/5] Installing nginx..."
  $PKG install -y nginx
else
  echo "[2/5] nginx already installed — skipping."
fi

# ── Copy files ─────────────────────────────────────────────────────────────────
echo "[3/5] Deploying files to /opt/pulsewatch..."
mkdir -p /opt/pulsewatch

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$SCRIPT_DIR/server.js"    /opt/pulsewatch/server.js
cp "$SCRIPT_DIR/index.html"   /opt/pulsewatch/index.html

# Only copy config if it doesn't already exist (preserve user edits)
if [ ! -f /opt/pulsewatch/config.json ]; then
  cp "$SCRIPT_DIR/config.json" /opt/pulsewatch/config.json
  echo "      → config.json installed. Edit /opt/pulsewatch/config.json with your services."
else
  echo "      → config.json already exists — keeping your existing config."
fi

chown -R www-data:www-data /opt/pulsewatch 2>/dev/null || \
  chown -R nginx:nginx      /opt/pulsewatch 2>/dev/null || true

# ── systemd service ────────────────────────────────────────────────────────────
echo "[4/5] Installing systemd service..."
cp "$SCRIPT_DIR/pulsewatch.service" /etc/systemd/system/pulsewatch.service

# Fix user in service file based on what's available
if id www-data &>/dev/null; then
  SVC_USER=www-data
else
  SVC_USER=nginx
  sed -i "s/User=www-data/User=nginx/" /etc/systemd/system/pulsewatch.service
fi

systemctl daemon-reload
systemctl enable pulsewatch
systemctl restart pulsewatch

# ── Generate default credentials (first run only) ─────────────────────────────
sleep 1  # give the service a moment to start and write defaults
node -e "
const crypto = require('crypto');
const fs     = require('fs');
const cfg    = JSON.parse(fs.readFileSync('/opt/pulsewatch/config.json'));
if (!cfg.credentials || cfg.credentials.length === 0) {
  const as = crypto.randomBytes(16).toString('hex');
  const vs = crypto.randomBytes(16).toString('hex');
  cfg.credentials = [
    { username:'admin',  role:'admin',  salt:as, hash:crypto.scryptSync('admin123', as, 64).toString('hex') },
    { username:'viewer', role:'viewer', salt:vs, hash:crypto.scryptSync('viewer123',vs, 64).toString('hex') },
  ];
  fs.writeFileSync('/opt/pulsewatch/config.json', JSON.stringify(cfg, null, 2));
  console.log('');
  console.log('  Default credentials created:');
  console.log('    Admin:   admin  / admin123');
  console.log('    Viewer:  viewer / viewer123');
  console.log('  Change these after first login!');
} else {
  console.log('  Credentials already exist — skipping.');
}
" 2>/dev/null || true

# ── nginx reverse proxy ────────────────────────────────────────────────────────
if [ "$PORT80_IN_USE" = "true" ]; then
  echo "[5/5] Skipping nginx config — port 80 is already in use."
  echo "      → Add a Proxy Host in Nginx Proxy Manager:"
  echo "        Domain: your-domain.com"
  echo "        Forward: http://127.0.0.1:3000"
else
  echo "[5/5] Configuring nginx..."

  NGINX_CONF=/etc/nginx/sites-available/pulsewatch
  [ -d /etc/nginx/sites-available ] || NGINX_CONF=/etc/nginx/conf.d/pulsewatch.conf

  cat > "$NGINX_CONF" <<'NGINX'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINX

  if [ -d /etc/nginx/sites-enabled ]; then
    ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/pulsewatch
    rm -f /etc/nginx/sites-enabled/default
  fi

  nginx -t && systemctl restart nginx
fi

# ── Done ──────────────────────────────────────────────────────────────────────
SERVER_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  PulseWatch is running!"
echo ""
echo "  Dashboard  →  http://$SERVER_IP"
echo "  Direct     →  http://$SERVER_IP:3000"
echo ""
echo "  Edit services:  nano /opt/pulsewatch/config.json"
echo "  View logs:      journalctl -u pulsewatch -f"
echo "  Restart:        systemctl restart pulsewatch"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

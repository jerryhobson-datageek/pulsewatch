# PulseWatch — Claude Context

## What this project is
PulseWatch is a self-hosted uptime/status dashboard. It monitors HTTP and TCP services and shows live status, response times, sparklines, and incident history. Single-page app: `index.html` (frontend) + `server.js` (Node.js backend).

## Repository
- GitHub: https://github.com/jerryhobson-datageek/pulsewatch.git
- Local: `C:\claudcode`
- Branch: `main`

## Live server (Hostinger VPS)
- IP: `2.24.107.27`
- Hostname: `srv1681739.hstgr.cloud`
- OS: Ubuntu 24.04 LTS
- SSH: `ssh -i /c/Users/jerry/.ssh/id_rsa root@2.24.107.27`
- SSH key: `C:\Users\jerry\.ssh\id_rsa`

## Second server (claudeapps)
- IP: `20.55.54.41` — this is an Azure VM
- Hostname: `claudeapps`
- OS: Ubuntu 26.04 LTS (Resolute Raccoon)
- User: `jerryhobson`
- SSH: `ssh -i /c/Users/jerry/.ssh/id_ed25519_claudeapps jerryhobson@20.55.54.41`
- SSH key: `C:\Users\jerry\.ssh\id_ed25519_claudeapps` (dedicated key, not shared with the Hostinger VPS)
- Password auth disabled (key-only) since 2026-06-24
- Purpose: hosting test instances of SecureScout and PulseWatch, plus a second WireGuard VPN (wg-easy) and Tailscale exit node
- Each new port used on this VM needs an inbound rule added on the Azure Network Security Group (scoped to the Hostinger VPS IP `2.24.107.27`) before NPM on the Hostinger box can reach it — local `ufw` is inactive, so a timeout from the Hostinger side when the app is confirmed listening locally points to the Azure NSG, not the app or NPM config
- The `/etc/apt/sources.list.d/microsoft-prod.list` repo (unsigned, breaks `apt-get update`) has regenerated itself three times now after being disabled — 2026-06-24, 2026-07-13 02:40 UTC, 2026-07-13 14:40 UTC (exactly 12h apart — likely `ua-timer` or `update-notifier-download`, not confirmed). Currently disabled as `.disabled3`. Just re-disable (`mv` it away, then `apt-get update`) if `apt-get update` starts failing with a `NO_PUBKEY` error again
- Docker installed 2026-07-13 via the `docker.io` apt package (matches how Docker was installed on the Hostinger VPS — not the docker-ce official repo)

### Tailscale (on claudeapps)
- Installed 2026-07-13 via the official apt repo (`pkgs.tailscale.com`)
- Tailscale IP: `100.106.57.48`, hostname `claudeapps` on the tailnet
- Configured and approved as an **exit node** — `net.ipv4.ip_forward` and `net.ipv6.conf.all.forwarding` enabled via `/etc/sysctl.d/99-tailscale.conf`, brought up with `tailscale up --advertise-exit-node --hostname=claudeapps`, approved by Jerry in the admin console (login.tailscale.com/admin/machines)
- Other tailnet devices route through it with `tailscale set --exit-node=claudeapps`
- The Hostinger VPS (`srv1681739`) is also already configured as an exit node on the same tailnet — two exit nodes available

### wg-easy VPN — f2bvpn.newtekk.com (on claudeapps)
- Second WireGuard instance, separate from `vpn.newtekk.com` which runs on the Hostinger VPS itself
- Docker container `wg-easy`, image `ghcr.io/wg-easy/wg-easy:15` (same version as the Hostinger one), `--restart unless-stopped`, data volume `wg-easy-data`
- `WG_HOST=20.55.54.41` (claudeapps' own public IP — VPN clients connect directly to this IP on port 51820, not through the domain, since `*.newtekk.com` DNS points at the Hostinger box)
- Ports: `51820/udp` (WireGuard tunnel — Azure NSG rule scoped to **Any/Internet**, since real clients connect directly) and `51821/tcp` (admin UI — Azure NSG rule scoped to the Hostinger VPS IP `2.24.107.27` only, since it's reverse-proxied)
- Public admin URL: **https://f2bvpn.newtekk.com** — NPM proxy host id 12 on the Hostinger VPS, forward to `20.55.54.41:51821`, Websockets support on, own Let's Encrypt cert
- Hit the same `ip_tables`/`ip6_tables`/`iptable_nat`/`ip6table_nat` kernel-module-not-loaded issue as [[project-wg-easy-netfilter]] on the Hostinger box (container showed `unhealthy`, `wg-quick up wg0` failed with `modprobe: FATAL: Module ip_tables not found`) — same fix applied: `/etc/modules-load.d/wireguard-netfilter.conf` listing all four modules
- Deployed 2026-07-13, first-run admin account completed by Jerry

### SecureScout test instance (on claudeapps)
- Repo clone: `~jerryhobson/securescout` (from https://github.com/jerryhobson-datageek/securescout.git)
- Running copy: `/opt/securescout/` (server.js, index.html, config.json — config.json from config.sample.json, not synced from git)
- Systemd service: `securescout.service`, runs as `www-data`, port 3002
- Node.js 22 + npm installed via apt (the broken `/etc/apt/sources.list.d/microsoft-prod.list` repo was disabled — renamed to `.disabled` — to unblock `apt-get update`)
- Public URL: **https://f2bsecure.newtekk.com** — proxied via NPM on the Hostinger VPS (proxy host id 9, forward_host `20.55.54.41:3002`, Let's Encrypt cert id 9, same security-header `advanced_config` convention as `security.newtekk.com`)
- First-run admin account already completed by Jerry

### PulseWatch test instance (on claudeapps)
- Repo clone: `~jerryhobson/pulsewatch` (from https://github.com/jerryhobson-datageek/pulsewatch.git)
- Running copy: `/opt/pulsewatch/` (server.js, index.html, public.html, config.json — config.json seeded manually with `port: 3005` and 3 sample services, not synced from git)
- Systemd service: `pulsewatch.service`, runs as `www-data`, port 3005
- Public URL: **https://f2bwatch.newtekk.com** — proxied via NPM on the Hostinger VPS. App sends its own security headers (HSTS/CSP/X-Frame-Options) via `server.js`, so no NPM conf hand-patching needed (unlike the bare apps in the security-headers fix)
- First-run admin account still default (`admin/admin123`, `viewer/viewer123`) — change after first login
- Deployed 2026-07-10

## Server layout
| Path | Purpose |
|---|---|
| `/root/plusewatch/` | Git clone — pull updates here |
| `/opt/pulsewatch/` | Running copy — what the service actually executes |
| `/etc/systemd/system/pulsewatch.service` | Systemd unit file |

The running copy at `/opt/pulsewatch/` has NO git repo. Always sync from the git clone after pulling.

## Deployment workflow
```bash
# 1. Pull latest on server
ssh -i /c/Users/jerry/.ssh/id_rsa root@2.24.107.27 "cd /root/plusewatch && git pull"

# 2. Sync to running copy (do NOT overwrite config.json or maintenance.json)
ssh -i /c/Users/jerry/.ssh/id_rsa root@2.24.107.27 "cp /root/plusewatch/server.js /root/plusewatch/index.html /opt/pulsewatch/"

# 3. Restart service
ssh -i /c/Users/jerry/.ssh/id_rsa root@2.24.107.27 "systemctl restart pulsewatch"
```

## Services monitored by PulseWatch
| Name | URL | Notes |
|---|---|---|
| Nginx Proxy Manager | https://proxymanager.newtekk.com | Reverse proxy for all services |
| Portainer | https://docker.newtekk.com | Docker management UI |
| WireGuard Easy | https://vpn.newtekk.com | VPN |
| PulseWatch | https://pulsewatch.newtekk.com | Self-monitoring |
| Cloudflare DNS | 1.1.1.1 | TCP, 60s interval |
| Google DNS | 8.8.8.8 | PING |
| Field2Base Admin Portal | admin.field2base.com | PING, 120s interval |
| F2B Admin Portal | https://admin.field2base.com/Portal/Account/Login | HTTP, 120s interval |
| F2B Dev Portal | https://dev.field2base.com | HTTP, 120s interval |
| SecureScout | https://security.newtekk.com | HTTP |
| NewTekk Auth | https://auth.newtekk.com | HTTP |
| NewTekk Manage | https://manage.newtekk.com | HTTP |

## NewTekk Manage
Customer portal for managing VPS servers, NewTekk apps, and billing.

- GitHub: https://github.com/jerryhobson-datageek/newtekk-manage.git
- Local: `C:\newtekk-manage`
- Branch: `main`
- Public URL: **https://manage.newtekk.com**
- Port: `3004`

### Server layout (VPS)
| Path | Purpose |
|---|---|
| `/root/newtekk-manage/` | Git clone — pull updates here |
| `/opt/newtekk-manage/` | Running copy |
| `/etc/systemd/system/newtekk-manage.service` | Systemd unit file |

### Deployment workflow
```bash
ssh -i /c/Users/jerry/.ssh/id_rsa root@2.24.107.27 "cd /root/newtekk-manage && git pull && cp server.js index.html /opt/newtekk-manage/ && systemctl restart newtekk-manage"
```

### Config files (do not overwrite on deploy)
- `/opt/newtekk-manage/config.json` — port, Hostinger token, auth URL, apps list

---

## NewTekk Auth
Centralised JWT authentication server for all NewTekk apps.

- GitHub: https://github.com/jerryhobson-datageek/newtekk-auth.git
- Local: `C:\newtekk-auth`
- Branch: `master`
- Public URL: **https://auth.newtekk.com** — NPM proxy host id 10, Let's Encrypt cert id 10
- Port: `3003`

### Server layout (VPS)
| Path | Purpose |
|---|---|
| `/root/newtekk-auth/` | Git clone — pull updates here |
| `/opt/newtekk-auth/` | Running copy |
| `/etc/systemd/system/newtekk-auth.service` | Systemd unit file |

### Deployment workflow
```bash
ssh -i /c/Users/jerry/.ssh/id_rsa root@2.24.107.27 "cd /root/newtekk-auth && git pull && cp server.js index.html /opt/newtekk-auth/ && systemctl restart newtekk-auth"
```

### Config files (do not overwrite on deploy)
- `/opt/newtekk-auth/config.json` — port, JWT secret, expiry
- `/opt/newtekk-auth/auth.db` — SQLite user database

### API endpoints
| Endpoint | Method | Description |
|---|---|---|
| `/register` | POST | Create account — returns JWT |
| `/login` | POST | Sign in — returns JWT |
| `/verify` | GET/POST | Validate a token (used by other apps) |
| `/me` | GET | Return profile from Bearer token |

### Tech stack
- Node.js, stdlib only (no npm packages)
- JWT HS256 signed with `node:crypto`
- SQLite via `node:sqlite`
- Passwords hashed with `scrypt`

## Docker containers on server
Reinstalled 2026-07-06 after VPS rebuild — fresh installs, no config carried over except `portainer_data` volume (survived the rebuild).

| Container | Image | Ports |
|---|---|---|
| proxy-app-1 | jc21/nginx-proxy-manager:latest | 80, 443 (admin: 81) |
| portainer | portainer/portainer-ce:lts | 8000, 9443 |
| uptime-kuma | louislam/uptime-kuma:2 | 3001 |
| wg-easy | ghcr.io/wg-easy/wg-easy:15 | 51820/udp, 51821/tcp — `WG_HOST=2.24.107.27` |

## Domain
`newtekk.com` — subdomains routed through Nginx Proxy Manager on the VPS.

## Config files (do not overwrite on deploy)
- `/opt/pulsewatch/config.json` — services list, port, intervals, hashed passwords
- `/opt/pulsewatch/maintenance.json` — maintenance window state

## Hostinger API
Token is stored in `$env:HOSTINGER_TOKEN` (session only, not on disk).
API base: `https://developers.hostinger.com/api/`
VPS ID: `1681739`, Subscription: `16BcTNVJz9OQn2BXO`

## Tech stack
- Node.js 20, no npm packages (stdlib only)
- Vanilla JS frontend, no frameworks
- systemd service, runs as `www-data`
- Passwords hashed with `scrypt`, stored in `config.json`
- Sessions in browser `sessionStorage` (24hr expiry)

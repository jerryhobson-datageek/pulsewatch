# PulseWatch — Claude Context

## What this project is
PulseWatch is a self-hosted uptime/status dashboard. It monitors HTTP and TCP services and shows live status, response times, sparklines, and incident history. Single-page app: `index.html` (frontend) + `server.js` (Node.js backend).

## Repository
- GitHub: https://github.com/jerryhobson-datageek/plusewatch.git
- Local: `C:\claudcode`
- Branch: `main`

## Live server (Hostinger VPS)
- IP: `2.24.107.27`
- Hostname: `srv1681739.hstgr.cloud`
- OS: Ubuntu 24.04 LTS
- SSH: `ssh -i /c/Users/jerry/.ssh/id_rsa root@2.24.107.27`
- SSH key: `C:\Users\jerry\.ssh\id_rsa`

## Second server (claudeapps)
- IP: `20.55.54.41`
- Hostname: `claudeapps`
- OS: Ubuntu 26.04 LTS (Resolute Raccoon)
- User: `jerryhobson`
- SSH: `ssh -i /c/Users/jerry/.ssh/id_ed25519_claudeapps jerryhobson@20.55.54.41`
- SSH key: `C:\Users\jerry\.ssh\id_ed25519_claudeapps` (dedicated key, not shared with the Hostinger VPS)
- Password auth disabled (key-only) since 2026-06-24
- Purpose: hosting a test instance of SecureScout

### SecureScout test instance (on claudeapps)
- Repo clone: `~jerryhobson/securescout` (from https://github.com/jerryhobson-datageek/securescout.git)
- Running copy: `/opt/securescout/` (server.js, index.html, config.json — config.json from config.sample.json, not synced from git)
- Systemd service: `securescout.service`, runs as `www-data`, port 3002
- Node.js 22 + npm installed via apt (the broken `/etc/apt/sources.list.d/microsoft-prod.list` repo was disabled — renamed to `.disabled` — to unblock `apt-get update`)
- Public URL: **https://f2bsecure.newtekk.com** — proxied via NPM on the Hostinger VPS (proxy host id 9, forward_host `20.55.54.41:3002`, Let's Encrypt cert id 9, same security-header `advanced_config` convention as `security.newtekk.com`)
- First-run admin account already completed by Jerry

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
| PulseWatch | https://plusewatch.newtekk.com | Self-monitoring |
| Cloudflare DNS | 1.1.1.1 | TCP, 60s interval |
| Google DNS | 8.8.8.8 | PING |
| Field2Base Admin Portal | admin.field2base.com | PING, 120s interval |
| F2B Admin Portal | https://admin.field2base.com/Portal/Account/Login | HTTP, 120s interval |
| F2B Dev Portal | https://dev.field2base.com | HTTP, 120s interval |
| SecureScout | https://security.newtekk.com | HTTP |
| NewTekk Auth | https://auth.newtekk.com | HTTP |

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
| Container | Image | Ports |
|---|---|---|
| proxy-app-1 | nginx-proxy-manager | 80/443 (admin: 81) |
| portainer | portainer-ce | 9443 |
| uptime-kuma | louislam/uptime-kuma:2 | 3001 |
| wg-easy | wg-easy:15 | 51820/51821 |

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

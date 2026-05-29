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
| Nginx Proxy Manager | https://proxy.newtekk.com | Reverse proxy for all services |
| Portainer | https://docker.newtekk.com | Docker management UI |
| WireGuard Easy | https://vpn.newtekk.com | VPN |
| PulseWatch | http://localhost:3000 | Self-monitoring |

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

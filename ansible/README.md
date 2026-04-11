# SiskelBot Ansible Playbooks

Ansible-based configuration management for provisioning SiskelBot on a VPS.

Targets **Ubuntu 22.04** and **Debian 12**.

## What this provisions

A single playbook (`site.yml`) installs and configures:

- Base system packages, firewall (ufw), and SSH hardening
- Node.js 20 (from NodeSource)
- PostgreSQL 16 (optional, `enable_postgres`)
- Redis (optional, `enable_redis`)
- SiskelBot (clone, `npm ci`, env file, systemd service)
- Nginx reverse proxy with WebSocket support and optional Let's Encrypt SSL

## Requirements

On the control node:

- Ansible >= 2.14
- SSH access to target host(s) with sudo privileges
- Python 3 on target host(s) (pre-installed on Ubuntu 22.04 / Debian 12)

Install Ansible:

```bash
pipx install ansible
# or
sudo apt install ansible
```

## Quick start

```bash
cd ansible
cp inventory.example.yml inventory.yml
$EDITOR inventory.yml          # set ansible_host, domain, secrets
ansible-playbook site.yml      # full provision
```

## Playbooks

| Playbook | Purpose |
|----------|---------|
| `site.yml` | Full-stack provision (runs all roles) |
| `playbooks/install.yml` | Same as `site.yml` (alias) |
| `playbooks/update.yml` | Pull latest code, `npm ci`, restart service |
| `playbooks/backup.yml` | Snapshot Postgres + data directory to tarball |
| `playbooks/restore.yml` | Restore from a backup tarball |
| `playbooks/uninstall.yml` | Stop service, remove files, drop database |

### Examples

```bash
# Fresh install
ansible-playbook site.yml

# Update to the latest commit on the configured branch
ansible-playbook playbooks/update.yml

# Create a backup (written to /var/backups/siskelbot/ on the target)
ansible-playbook playbooks/backup.yml

# Restore from a specific backup
ansible-playbook playbooks/restore.yml -e backup_file=/var/backups/siskelbot/siskelbot-20260410-1200.tar.gz

# Uninstall (prompts for confirmation)
ansible-playbook playbooks/uninstall.yml
```

## Inventory variables

All tunables live in `inventory.example.yml`. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `siskelbot_version` | `1.0.0` | Release tag or version label |
| `siskelbot_repo` | (set in inventory) | Git repo URL |
| `siskelbot_branch` | `main` | Branch or tag to check out |
| `siskelbot_install_dir` | `/opt/siskelbot` | App install directory |
| `siskelbot_user` | `siskelbot` | System user that runs the service |
| `siskelbot_domain` | `siskelbot.example.com` | Public FQDN for Nginx vhost |
| `siskelbot_admin_email` | `admin@example.com` | Let's Encrypt contact email |
| `siskelbot_backend` | `ollama` | Backend provider (`ollama`\|`vllm`\|`openai`) |
| `enable_postgres` | `true` | Install and configure PostgreSQL |
| `enable_redis` | `true` | Install and configure Redis |
| `enable_ssl` | `true` | Request a Let's Encrypt certificate |
| `enable_firewall` | `true` | Configure ufw with ports 22/80/443 |
| `enable_ssh_hardening` | `true` | Disable root login and password auth |

## Secrets

Do **not** commit real secrets in `inventory.yml`. Use one of:

- Ansible Vault: `ansible-vault encrypt inventory.yml`
- `--extra-vars` on the command line (or `-e @secrets.yml`)
- Environment-sourced values injected by CI

## Tags

Selectively run parts of the playbook:

```bash
ansible-playbook site.yml --tags siskelbot       # only the app role
ansible-playbook site.yml --tags nginx,proxy     # only the nginx role
ansible-playbook site.yml --skip-tags postgresql # skip database install
```

## Directory layout

```
ansible/
├── README.md
├── ansible.cfg
├── inventory.example.yml
├── site.yml
├── playbooks/
│   ├── install.yml
│   ├── update.yml
│   ├── backup.yml
│   ├── restore.yml
│   └── uninstall.yml
└── roles/
    ├── common/
    ├── nodejs/
    ├── postgresql/
    ├── redis/
    ├── siskelbot/
    └── nginx/
```

## Troubleshooting

- **SSH connection fails:** verify `ansible_host`, `ansible_user`, and that your key is loaded (`ssh-add -l`).
- **Sudo prompts:** add `--ask-become-pass` or configure passwordless sudo.
- **Let's Encrypt fails:** ensure DNS for `siskelbot_domain` resolves to the server and ports 80/443 are open.
- **Service won't start:** `sudo journalctl -u siskelbot -f` on the target host.

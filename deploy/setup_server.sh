#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VPS for the JB Capital floor. Run as root:
#   bash setup_server.sh "<your ssh public key line>"
# What it does:
#   - creates user "jb" (runs the floor; you log in as jb with your SSH key)
#   - SSH: key login only (no passwords, no root login)
#   - firewall: only SSH is open to the internet; the dashboard (port 8000) is reachable ONLY over Tailscale
#   - automatic security updates, fail2ban, New York time zone
#   - Python venv + requirements, Claude Code (for the agents' brain), systemd service "jbfloor" (24/7, auto-restart)
set -euo pipefail
PUBKEY="${1:-}"
APP=/home/jb/ai-trading-floor

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y python3 python3-venv python3-pip git curl ufw fail2ban unattended-upgrades tar software-properties-common
# the floor is developed on Python 3.11: use it everywhere (Ubuntu 22.04 ships 3.10, 24.04 ships 3.12)
if ! command -v python3.11 >/dev/null; then
  add-apt-repository -y ppa:deadsnakes/ppa
  apt-get update -y
fi
apt-get install -y python3.11 python3.11-venv
timedatectl set-timezone America/New_York
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== user jb"
id jb >/dev/null 2>&1 || adduser --disabled-password --gecos "" jb
mkdir -p /home/jb/.ssh "$APP" /home/jb/jbterminal
if [ -n "$PUBKEY" ]; then
  grep -qF "$PUBKEY" /home/jb/.ssh/authorized_keys 2>/dev/null || echo "$PUBKEY" >> /home/jb/.ssh/authorized_keys
fi
chmod 700 /home/jb/.ssh; chmod 600 /home/jb/.ssh/authorized_keys 2>/dev/null || true
chown -R jb:jb /home/jb
# jb may restart its own service without a password (used by the deploy script)
cat > /etc/sudoers.d/jbfloor <<'EOF'
jb ALL=(root) NOPASSWD: /usr/bin/systemctl restart jbfloor, /usr/bin/systemctl stop jbfloor, /usr/bin/systemctl start jbfloor, /usr/bin/systemctl status jbfloor *, /usr/bin/journalctl -u jbfloor *
EOF
chmod 440 /etc/sudoers.d/jbfloor

echo "== ssh hardening (key-only)"
if [ -s /home/jb/.ssh/authorized_keys ]; then
  cat > /etc/ssh/sshd_config.d/99-jb.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  systemctl reload ssh || systemctl reload sshd || true
else
  echo "!! no SSH key given: password login left ON. Re-run with your public key."
fi

echo "== firewall"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow in on tailscale0
ufw --force enable
systemctl enable --now fail2ban

echo "== tailscale (private network for the dashboard)"
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh

echo "== python venv"
sudo -u jb python3.11 -m venv /home/jb/venv

echo "== claude code (for jb)"
sudo -u jb bash -lc 'command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash'

echo "== systemd service"
cat > /etc/systemd/system/jbfloor.service <<EOF
[Unit]
Description=JB Capital AI trading floor (paper)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
User=jb
WorkingDirectory=$APP
Environment=FLOOR_NO_BROWSER=1
Environment=FLOOR_HOST=0.0.0.0
Environment=FLOOR_TERMINAL=/home/jb/jbterminal/data.json
Environment=PYTHONIOENCODING=utf-8
Environment=PATH=/home/jb/.local/bin:/home/jb/venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/jb/venv/bin/python -u server.py
Restart=always
RestartSec=10
# watchdog-style: if it hangs, systemd kills and restarts it via the health timer below
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF
# health check every 2 min: restart if the floor stops answering
cat > /usr/local/bin/jbfloor-health <<'EOF'
#!/usr/bin/env bash
systemctl is-active --quiet jbfloor || exit 0
for i in 1 2 3; do curl -fsS -m 20 http://127.0.0.1:8000/api/status >/dev/null && exit 0; sleep 20; done
logger -t jbfloor-health "floor not answering; restarting"; systemctl restart jbfloor
EOF
chmod +x /usr/local/bin/jbfloor-health
cat > /etc/systemd/system/jbfloor-health.service <<'EOF'
[Unit]
Description=JB floor health check
[Service]
Type=oneshot
ExecStart=/usr/local/bin/jbfloor-health
EOF
cat > /etc/systemd/system/jbfloor-health.timer <<'EOF'
[Unit]
Description=JB floor health check every 2 minutes
[Timer]
OnBootSec=3min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable jbfloor jbfloor-health.timer
echo
echo "== done. Next steps:"
echo "  1) tailscale up            (log in with the link it prints)"
echo "  2) from your PC: deploy\\push.ps1   (copies the app, keys and state, then starts it)"
echo "  3) su - jb -c claude       (log Claude Code into your Max plan once)"

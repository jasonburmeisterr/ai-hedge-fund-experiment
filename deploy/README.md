# Moving the floor to a VPS (Ubuntu 24.04)

1. **Buy the server** (Ubuntu 24.04, 4 vCPU / 8 GB). Note its IP and root password.
2. **First login + setup** (from PowerShell on your PC):
   ```
   scp deploy\setup_server.sh root@<IP>:/root/
   ssh root@<IP> "bash /root/setup_server.sh '<contents of ~\.ssh\jb_vps.pub>'"
   ssh root@<IP> tailscale up        # open the printed link, log in (same Tailscale account as your PC/phone)
   ```
   Install Tailscale on your PC and phone too (free): https://tailscale.com/download
3. **Stop the floor on this PC** (so only one copy trades the Alpaca account):
   `Disable-ScheduledTask -TaskName "JB Capital Floor"` then stop the watchdog/server.
4. **Copy everything over, once with the state:**
   `powershell -ExecutionPolicy Bypass -File deploy\push.ps1 -Server <IP> -WithState`
5. **Log Claude Code into your Max plan on the server (once):** `ssh -i ~\.ssh\jb_vps jb@<IP>` then run `claude` and follow the link.
   Then `sudo systemctl restart jbfloor`.
6. Open the dashboard from any of your Tailscale devices: `http://<server's tailscale name>:8000`.

Updates later: `deploy\push.ps1 -Server <name>` (without `-WithState`). Logs: `ssh jb@<name> "sudo journalctl -u jbfloor -n 100"`.
Security: only SSH (key-only) is open to the internet; port 8000 is reachable only inside your Tailscale network.

# Upload from this Mac's own Terminal

SSH works through the configured SOCKS5 proxy. In this environment use `-o ProxyCommand='nc -X 5 -x 127.0.0.1:57576 %h %p'` with both ssh and scp. The proxy port is session-specific; check ALL_PROXY before reusing it. The deployment session uses `/tmp/codex-portal-known-hosts` with `UserKnownHostsFile` to retain the accepted host key without changing the Mac's SSH configuration. See README.md for deployment status.

Set Namecheap DNS first: `A`, host `app`, value `2.29.156.57`, automatic TTL. Remove conflicting `app` CNAME/A records. Do not add AAAA without a working server IPv6 address. Use the authoritative DNS provider if Namecheap's nameservers point elsewhere.

```sh
cd /Users/mac/Documents/workplace/codex-portal
tar --exclude='./data' --exclude='./node_modules' --exclude='./.git' --exclude='./.env' -czf /tmp/codex-portal.tar.gz .
scp -i ~/.ssh/id_rsa /tmp/codex-portal.tar.gz root@2.29.156.57:/tmp/codex-portal.tar.gz
ssh -i ~/.ssh/id_rsa root@2.29.156.57
```

Verify the SSH host fingerprint against the Hetzner console when connecting for the first time.

On the server, install Node.js 24 LTS and Caddy using their official Debian/Ubuntu instructions, then:

```sh
mkdir -p /root/codex-portal-source
tar -xzf /tmp/codex-portal.tar.gz -C /root/codex-portal-source
cd /root/codex-portal-source
bash deploy/install.sh
sudo -u codexportal -H codex login --device-auth
```

Complete the device-code login on your own device. Then create your account and issue an enrollment code using the commands in README.md. If Node/Caddy are already installed, no additional installation is needed.

Required inbound ports: TCP 80, 443, and your SSH port (normally 22). Do not publish port 3000.

Deployment is not verified until HTTPS, real passkey registration, live Codex prompts/uploads, answer retrieval, close, and restart/resume have been checked. Dependency resolution and browser bundle path must be verified on the network-enabled server.

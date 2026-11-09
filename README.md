# Schumann Codex portal

Target: https://app.schumann.com.de. Manually provisioned account web application wrapping local Codex app-server over stdio. The app-server has no public listening port. Passkey authentication requires WebAuthn user verification, supports Apple synced passkeys, and permits device passcode fallback according to the authenticator. It cannot enforce biometrics exclusively.

## Current status

Installed on `2.29.156.57` as of 2026-11-08 using `root`, `~/.ssh/id_rsa`, and the configured SOCKS5 proxy. SSH host key accepted on first use with the owner's authorization. Ubuntu 26.04.1, Node.js 24.22.2, Caddy 2.11.9, and Codex CLI 0.167.0 are installed. Both services are active; the app listens only on loopback port 3000. Installed Ubuntu's bubblewrap package and verified user namespaces under service security restrictions.

`npm run check` and all six tests pass on the server. HTTP checks verified health, the browser bundle, unauthorized session rejection, invalid-origin rejection, and passkey login challenge generation. A real Codex app-server thread starts successfully. The browser dependency is pinned to published version 14.0.0; the server dependency remains 14.1.0. The generated dependency lockfile is retained in this repository; npm reported zero dependency vulnerabilities at installation.

IPv6-only DNS is configured: `app.schumann.com.de` has AAAA `2a01:4f9:c015:4131::1` and no A record. Let’s Encrypt validated the server over IPv6 and issued the certificate; HTTPS health checks pass. The authoring SOCKS5 proxy could not connect to the IPv6-only site, so external reachability evidence comes from successful ACME validation. SSH administration continues over IPv4.

Deployment remains incomplete: Codex is authenticated using ChatGPT and the owner has enrolled a passkey. Live prompts, shell-based file reading, and app-server process restart/thread resume passed. Full authenticated browser upload/close flows and portal service restart/resume still require validation. The chat now fills the viewport, with session management in a hamburger menu. Browser layout automation was unavailable in the authoring environment; syntax checks pass.

## Deployment

1. Use a fresh Ubuntu/Debian server. Install Node.js 24 LTS and Caddy from their official repositories. Ensure unprivileged user namespaces work for the Codex Linux sandbox. Do not disable the Codex sandbox to work around setup failures.
2. Point DNS A record `app.schumann.com.de` to the server IPv4 address. Set AAAA only if IPv6 is configured and reachable. Open inbound TCP 80/443 for Caddy; keep SSH available to your admin address. Do not expose port 3000 or Codex directly.
3. Copy this directory to a temporary directory on the server, excluding `data/`, `node_modules/`, `.env`, and `.git`. Run `sudo bash deploy/install.sh` from that directory. The installer preserves existing Caddy configuration but requires Caddy and Node to be installed. Set CODEX_BIN in `/etc/codex-portal.env` if npm's global binary is outside the service PATH.
4. Authenticate Codex as the service user, for example `sudo -u codexportal -H codex login --device-auth`, and complete sign-in on your own device. Alternatively configure an API key securely for that service user. Never reuse/copy the Mac's Codex credential file automatically.
5. Create each approved account manually on the server:
   ```sh
   cd /opt/codex-portal
   sudo -u codexportal -H env DATA_DIR=/var/lib/codex-portal/data node src/admin.mjs create-account owner
   sudo -u codexportal -H env DATA_DIR=/var/lib/codex-portal/data node src/admin.mjs issue-code owner
   ```
   Share the printed 24-character code privately with that account owner. It expires after ten minutes, can enroll exactly one passkey, and is stored only as a SHA-256 hash. Issuing a new code revokes the previous unused code. There is no public account creation endpoint. Every additional device/passkey requires a new administrator-issued code, even when the user is already signed in. Apple may synchronize an existing passkey to another device using iCloud Keychain; this does not require a separate enrollment.
6. Visit the HTTPS URL on your iPhone or Mac, choose **Link a new device**, enter the code, and register a passkey. Future sign-ins use the passkey. Keep an encrypted, consistent backup of `/var/lib/codex-portal`, which contains conversations, uploads, the account database and Codex credentials.
7. Retain and review generated `package-lock.json` on the first successful install; use `npm ci --omit=dev` for later deployments. Review/pin the installed Codex CLI version after testing.

Check `systemctl status codex-portal caddy` and `journalctl -u codex-portal`. Source is root-owned; Codex runs as an unprivileged service user with writes restricted by systemd to its own data directory. Workspace-write is used for Codex threads; approvals not supported by this UI fail closed. API routes filter sessions and files by account ownership. However, all Codex processes share the service OS user and underlying read access; this deployment is for trusted manually approved users, not mutually untrusted tenants. Separate OS users or containers are required before offering hostile-tenant isolation.

## API

All `/api/sessions` routes require the HTTP-only passkey-authenticated cookie. Session lifetime: 12 hours. Cookies are Secure and SameSite=Strict in production. Mutating requests require the configured exact Origin. Auth challenges expire after five minutes and are single use. Rate limits are applied per client IP through a loopback Caddy proxy. No password fallback, open signup, or API bearer-token bypass is provided.

- `GET /api/auth/status`: authentication/enrollment state.
- `POST /api/auth/register/options`: `{code}` from the administrator for each new passkey.
- `POST /api/auth/register/verify`: `{credential}`; consumes the enrollment code atomically after successful WebAuthn verification.
- `POST /api/auth/login/options`, then `/api/auth/login/verify` with signed assertion.
- `POST /api/auth/logout`: revoke current session cookie.
- `GET /api/sessions`: list persisted sessions, including closed history.
- `POST /api/sessions`: `{title}` creates a Codex session and workspace.
- `POST /api/sessions/:id/files`: `{name,base64}` uploads a file (10 MB, 100 per session).
- `POST /api/sessions/:id/prompts`: `{text,files:[uploadId]}` starts a turn; concurrent turns return 409. Uploaded file paths are provided to Codex for reading.
- `GET /api/sessions/:id/events?after=0`: up to 200 persisted events and monotonic IDs. Poll using the last received ID. Includes agent deltas, tool events, and completion/failure notifications.
- `DELETE /api/sessions/:id`: stop local process and permanently close access to that session. Keeps history and files.

Open sessions resume their saved Codex thread lazily after service restart. SQLite retains prompt/answer events so browser refresh/disconnection does not discard answers. Reconnect across a service restart cannot continue a turn interrupted by that restart.

## Validation

`npm run check` and `npm test` cover syntax and app-server initialization, thread creation/resume, prompt submission, streamed notifications, and process startup failure using a fake Codex executable. Enrollment tests cover manual-account requirements, hashed codes, expiry, replacement, account binding, single use and rollback. These tests do not call OpenAI.

Before considering deployment complete, install dependencies and verify the browser bundle path, run HTTP tests for unauthorized API access, enrollment races/replay, invalid origins, expired/revoked cookies, passkey registration/assertion verification, file limits, traversal prevention and concurrent prompts. Verify on actual iPhone/Mac hardware, then run a live Codex prompt, a file-reading prompt, answer reload, close, and restart/resume. Confirm TLS and firewall externally. Authentication and browser integration are not yet runtime-tested.

Documentation: https://learn.chatgpt.com/docs/app-server and https://simplewebauthn.dev/docs/packages/server.


## PyDavid Telegram bot

The existing PyDavid identity (`@lunacy_berlin_bot`) runs as the persistent `codex-telegram` systemd service using long polling. The obsolete PythonAnywhere webhook was removed without dropping queued messages. Only the two configured users in private chats are accepted. The bot sends replies through the server's existing Codex authentication. Text messages are supported; voice/photos/files are not yet processed.

Credentials and approved user IDs live only in root-readable `/etc/codex-telegram.env`, outside this repository. Configuration keys: `TELEGRAM_TOKEN`, `TELEGRAM_DAVID_ID`, `TELEGRAM_SAF_ID`, `TELEGRAM_IDLE_MINUTES`, and `TELEGRAM_MIN_MESSAGES`. Automatic rotation requires BOTH a positive idle threshold and a positive minimum incoming message count; both are currently zero pending the owner's requested trigger conditions. `/new` manually summarizes and rotates; `/status` reports state.

David's `tg-david` sessions belong to the portal `owner` account; Saf's `tg-saf` sessions belong to a separate `telegram-saf` account. Each has separate accumulated memory at `/var/lib/codex-portal/data/telegram/tg-david/memory.txt` or `tg-saf/memory.txt`. Important facts are summarized and appended when rotating. More than 2,000 lines triggers compression to at most 100 lines. Earlier memory is backed up before replacement; full session event history is retained. The next conversation receives its own memory as context. Memory is stored in SQLite as the recovery source and atomically exported to text files. These are trusted users sharing one OS service account, not hostile-tenant isolation.

Incoming updates are committed to SQLite before Telegram acknowledges them. Duplicate update IDs are ignored. A separate worker for each person serializes their prompts and preserves reply chunks across restarts. Delivery is at least once: a crash after Telegram accepts a reply but before the local delivery checkpoint may duplicate a reply. Interrupted generation can also be retried. Review `journalctl -u codex-telegram`; message bodies and credentials are not logged there. Back up `/var/lib/codex-portal` consistently. Restart the Telegram service to apply code or configuration changes.

Validation covers sender/chat authorization, update deduplication, restart recovery, distinct accounts/sessions/memory, both rotation conditions, compression boundaries, and Unicode reply chunking. Live end-to-end Telegram conversation validation requires an approved user to send a message.

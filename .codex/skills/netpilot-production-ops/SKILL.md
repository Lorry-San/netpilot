---
name: netpilot-production-ops
description: Diagnose, update, verify, back up, or recover the NetPilot production server and connected Linux Agents. Use for SSH and Docker Compose operations, WSS/DNS/TLS checks, SQLite backup or restore planning, Telegram polling incidents, Agent connectivity and updater failures, deployment verification, or production log analysis.
---

# NetPilot Production Operations

## Load the runbook

Read `../../../HANDOFF.md` before production work. Reconfirm host, SSH fingerprint, directory, Compose service, volume, domain, version, and DNS because documented values can change.

Never print or commit passwords, private keys, Bot Tokens, Agent Tokens, cookies, `.env` secrets, or database contents. Use secure credential injection without echoing it.

## Diagnose read-only first

Prefer evidence before mutation:

```text
cd /opt/netpilot
git status --short
git rev-parse --short HEAD
docker compose ps
docker compose logs --since=30m --timestamps --no-color
```

Check public HTTPS, the asset version marker, DNS/CNAME, WSS upgrade, Agent logs, and GitHub release status as relevant. Fix the failing layer; do not restart everything reflexively.

## Deploy safely

Require explicit deployment authorization. Before updating:

1. Confirm the target GitHub tag workflow and artifacts succeeded.
2. Confirm `/opt/netpilot` has no local changes needing preservation.
3. Confirm the SQLite volume and backup policy.
4. Run `cd /opt/netpilot && sh scripts/update.sh`.
5. Verify Compose, source version, public asset marker, web listener, and Bot startup.
6. Smoke-test login/session restoration, `/ws/ui`, Agent presence, and only authorized test targets.

Do not update Agent hosts merely because the web server changed. Update when Agent code, bundled NextTrace, protocol compatibility, or security requires it.

## Handle data carefully

Treat the Docker volume and every SQLite copy as sensitive. Resolve the exact volume before backup or restore. For a consistent filesystem copy, stop only `server`, copy the complete data directory to protected storage, then restart and verify. Preserve pre-restore state for forensics.

Never recursively delete or move an unresolved path. Never use a workspace root, `/`, `$HOME`, or an unresolved variable as a destructive target.

## Incident-specific checks

- Repeated Telegram replies: ensure one poller, inspect offset, verify group chatter is filtered before authorization.
- Agent auth: distinguish invalid Token (`4003`) from duplicate connection (`4004`).
- Batched output: inspect force flushing, Agent line emission, proxy buffering, `/ws/ui`, and rendering.
- Update failure: inspect minimum version, busy state, script URL, checksum, transient unit, service logs, and reconnect version.
- Authentication 401 noise: identify stale clients; expected 401 stacks are not necessarily service failures.
- Database locked: reduce manual concurrency and inspect WAL; do not disable foreign keys/WAL as a quick fix.

## Report the outcome

State exact deployed version/commit, checks run, Agent updates performed, and unresolved risk. If credentials fail, request a new secure credential without repeating the old one. For rollback, preserve the database and use a known-good code/image rather than resetting data.

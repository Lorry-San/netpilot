# NetPilot

English | [简体中文](README.zh-CN.md)

[![Build and publish](https://github.com/Lorry-San/netpilot/actions/workflows/build.yml/badge.svg)](https://github.com/Lorry-San/netpilot/actions/workflows/build.yml)
[![GitHub release](https://img.shields.io/github/v/release/Lorry-San/netpilot)](https://github.com/Lorry-San/netpilot/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

NetPilot is a self-hosted web control plane for distributed `iperf3` and NextTrace tests. Its Node.js server stores state in SQLite and dispatches jobs to outbound-only Go agents over authenticated WebSocket connections. The browser provides live output, speed charts, route details, multi-user access control and Agent management; the same Agents are also available through an optional Telegram Bot.

## Features

- TCP and UDP `iperf3` tests with target, port, duration, parallel streams, bandwidth and reverse (`-R`) options
- Streaming ICMP/TCP/UDP NextTrace v1.7.1 route tracing with IPv4/IPv6, packet size, hop/query/timeout controls, PTR and MPLS output
- Streaming raw output and speed/time metrics pushed live to the browser over `/ws/ui`
- Linux agents for `x86-64` and `arm64`
- CPU, memory and network-interface utilization probes
- Agent naming, public connection IP and location fields
- Multi-user login with administrator and regular-user roles
- Per-user Agent permissions
- Immutable system administrator at `uid=1`
- SQLite storage with WAL mode
- Docker installation command for the Alpine `linux/amd64` Agent image
- One-line Linux installer that detects `x86-64` or `arm64`
- Agent auto-update requests for online native Agents plus manual in-place updater commands, with checksum verification and rollback
- System settings for Agent WS address, installer address and optional GitHub download acceleration
- Web version detection against the latest GitHub Release
- Telegram Bot iperf and `/nexttrace` tests with account binding, authenticated Agent selection, progress updates and raw output
- Administrator-managed Telegram group access modes
- In-place server update script for Docker Compose deployments
- GitHub Actions builds both Agent binaries, creates release assets and publishes the amd64 Agent image to GHCR

## Architecture

```text
Browser
   |
   | HTTPS / JSON
   v
Node.js control plane ---- SQLite
   |
   | WSS + Agent token
   v
Go Agent ---- iperf3 / NextTrace

Telegram Bot ---- long polling ---- Node.js control plane
```

Agents only create outbound WSS connections. They do not expose an inbound management port.

## Requirements

- Node.js 22.5 or newer; Node.js 24 is recommended
- Linux Agent host; the installer supplies `iperf3` and pinned NextTrace v1.7.1
- TLS termination such as Caddy or Nginx for production

The server uses the built-in `node:sqlite` module and has no native SQLite npm dependency.

## Quick start

```bash
git clone https://github.com/Lorry-San/netpilot.git
cd netpilot
cp .env.example .env
npm ci

ADMIN_PASSWORD='replace-with-a-long-random-password' \
PUBLIC_BASE_URL='http://localhost:8080' \
npm start
```

Open `http://localhost:8080` and sign in as `admin`.

On a brand-new database, the system administrator is inserted explicitly as `uid=1`. If `ADMIN_PASSWORD` is missing or shorter than 12 characters, NetPilot generates a random initial password and prints it once to the server console.

## Server with Docker Compose

Create `.env`:

```dotenv
PUBLIC_BASE_URL=https://netpilot.example.com
GITHUB_REPO=Lorry-San/netpilot
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-at-least-12-characters
```

Then start the server:

```bash
docker compose up -d --build
```

SQLite data is stored in the `netpilot-data` volume.

## Adding an Agent

1. Sign in as an administrator.
2. Open **Agent**.
3. Select **Add Agent** and give it a name.
4. Run either the generated Docker command or the generated one-line installer.

The generated token is shown once. Only its SHA-256 digest is stored by the server.

By default, install commands use the scheme and host of the admin's own HTTP request (including `X-Forwarded-Proto` behind a reverse proxy). `PUBLIC_BASE_URL` is only a fallback when the request host is missing or invalid. The `uid=1` system administrator can override the Agent WebSocket address and installer script address under **System Settings**. This is useful when the Web UI and WebSocket endpoint use different domains or IP addresses.

### Docker Agent

The GitHub Actions workflow publishes:

```text
ghcr.io/lorry-san/netpilot/netpilot-agent:latest
```

The generated command supplies the WSS address, Agent ID, Agent name and token as environment variables and adds only `NET_RAW` for route probes. The image is Alpine-based, includes `iperf3` and checksum-verified NextTrace v1.7.1, runs as an unprivileged user and is built for `linux/amd64`.

### One-line installer

The installer supports:

- `x86_64` / `amd64`
- `aarch64` / `arm64`
- systemd
- OpenRC
- Alpine, Debian/Ubuntu, Fedora and RHEL-family package managers

It installs the matching release binary, `iperf3`, checksum-verified NextTrace v1.7.1 and its GPL-3.0 license, stores the Agent token in `/etc/netpilot-agent/env` with mode `0600`, and starts the service. The systemd unit restricts its capability set to `CAP_NET_RAW`.

An online or busy Agent cannot generate a new installation token, cannot be reinstalled from the Web UI and cannot be deleted. Disconnect the Agent first. This rule is enforced by the Node.js API, not only by the interface.

## Updating an Agent

Administrators can open **Agent** and use either update path:

- **Auto update** sends an authenticated WebSocket request to an online idle Agent. The page banner reports success or failure and includes the original and reported new version. Native `systemd` Agents are updated through a transient `systemd-run` unit when available, so the updater can survive the Agent service restart.
- **Manual update** shows the root command to run on the Agent host. Use this for offline Agents, Docker Agents without host Docker access, or when automatic update fails.

Agents older than `v0.1.19` either do not understand the automatic update WebSocket request or may place the downloaded updater inside systemd's private `/tmp` namespace. The server refuses auto-update for those Agents and asks you to run the manual update command once. The manual upgrade installs a shared runtime directory; future web-triggered auto-updates are handed off without waiting for the Agent service restart.

Updating is blocked while the Agent is running an iperf or route-tracing task. The update does not rotate or expose the Agent token. Updating to v0.1.18 or newer also installs the pinned NextTrace executable; older Agents remain usable for iperf but are shown as not supporting route tracing.

The updater supports:

- Native `systemd` and OpenRC installations on `x86-64` and `arm64`
- The standard `netpilot-agent` Docker container created by NetPilot
- Optional GitHub acceleration configured under **System Settings**
- SHA-256 verification against the release `SHA256SUMS` file for native binaries
- Atomic binary replacement and automatic native-service rollback
- Docker image comparison, environment/restart-policy preservation and container rollback

For a native installation, the existing `/etc/netpilot-agent/env` file is not modified. For Docker, the manual updater preserves the `NETPILOT_*` environment variables and restart policy and adds `NET_RAW` to the replacement standard container. Custom Docker networks, mounts or other manually added `docker run` options are outside the updater's scope. Automatic update usually cannot replace a standard Docker Agent container from inside the container unless you deliberately provide host Docker access, so keep the manual command available for Docker deployments.

The standalone endpoint is `/update-agent.sh`. Normally use the command generated by the Web UI because it includes the configured repository and GitHub acceleration prefix.

## User roles

| Capability | Administrator | Regular user |
| --- | --- | --- |
| Run tests | Any Agent | Assigned Agents only |
| View tests | All tests | Own tests only |
| Add, reinstall or remove Agents | Yes | No |
| Manage users | Yes | No |
| Change roles | Yes | No |
| Configure Telegram groups | Yes | No |
| Change system connection/download settings | `uid=1` only | No |

The system administrator is always `uid=1`. API requests that attempt to delete, disable or demote `uid=1` are rejected.

## Telegram Bot

The `uid=1` system administrator can paste a BotFather token under **System Settings**. NetPilot validates it with `getMe` and shows the connected Bot username before starting Telegram Bot API long polling from the Node.js process, so no public webhook endpoint is required. Clearing the token stops the Bot.

Each user binds one Telegram account from the dedicated **Telegram Bot** page:

1. Select **Generate binding code** in the Web UI.
2. Send `/bind <code>` to the Bot within 10 minutes.
3. Use `/help`, `/status`, `/agents`, `/iperf`, `/iperf <ip> [port] [threads] [duration] [-R]`, or `/nexttrace [options] <target>` in a private chat or an allowed group.

The Bot registers its command menu automatically when it starts. Unbound users receive an unauthorized response in private chat, except that `/bind` remains available. `/iperf` without arguments starts the interactive flow: select Agents, choose upload or download, then enter `IP:port` in the Bot private chat (port defaults to `5201`). When invoked in a group, the direction buttons open the authenticated private-chat continuation directly. `/iperf IP` is the quick upload mode; its defaults are port `5201`, one stream and 10 seconds. Explicit reverse mode accepts both `/iperf IP -R` and `/iperf -R IP` for a quick download test. The Bot presents the online Agents available to the effective NetPilot user as an authenticated, paginated multi-select keyboard. Callback buttons and private continuations are tied to the requesting Telegram ID and authorization is checked again on every action. Test progress, results and chart documents return to and reply to the command message that started the interaction. Selected Agents run strictly one at a time because a standard iperf3 server accepts only one client; the next Agent is dispatched only after the current task completes. Web Agent permissions and busy/offline checks still apply.

The running message shows the current Agent, per-test progress, output-line count and elapsed batch time, with authenticated refresh and stop controls. The final response includes per-test and overall elapsed time, Telegram's expandable raw-output block and a PNG chart uploaded as a document. Charts include labelled X/Y axes, units, markers and the measured value at every point. Long raw output is tail-truncated to stay within Telegram message limits.

`/nexttrace` accepts a NextTrace-like safe subset: `-4`, `-6`, `-T`, `-U`, `-p`, `-q`, `-m`, `--timeout`, `--parallel-requests`, `--psize`, `-n` and `-e`. For example: `/nexttrace -T -p 443 -q 3 --psize 64 example.com`. After parsing, the Bot shows only online Agents that advertise the `nexttrace` capability; selecting one starts immediately. The final reply contains Agent, target, protocol, address family, packet size, hop summary, elapsed time and expandable native output. Output beyond the Telegram message limit is also attached as a text document. No chart is generated.

Adding the Bot to a group registers that group on the **Telegram Bot** page when the adding Telegram account is already bound. Sending a command also registers it as a fallback. Administrators can select several groups in one continuous list and set them to:

- **Private**: only Telegram accounts bound to NetPilot can use the Bot, with their own Agent permissions. Every `/iperf` Bot response in the group replaces the real target with `x.x.x.x`, including selection and progress messages, expandable raw output, errors and chart titles. The real target is still retained internally and sent to the Agent.
- **Public**: every group member can use the Bot. Unbound members use the Agent permissions of the account that registered the group.

Administrators can register any number of groups. A regular user can register one group and can keep it private or remove it. Only NetPilot administrators can enable public mode; all group changes are enforced again by the API.

## System settings and version detection

Only the immutable `uid=1` system administrator can open **System Settings** or use `/api/settings`. The page controls:

- Agent WebSocket base URL, such as `wss://iperf.example.com` or `ws://192.0.2.10:8080`
- Agent script base URL for installation and updates, such as `https://iperf.example.com`
- Optional GitHub acceleration prefix used by Agent installation, Agent updates and version checks
- Telegram Bot token; only `uid=1` can view or change it
- NextTrace GeoIP provider and whether external MapTrace generation is allowed

Values are stored in SQLite. Leave the WS and installer fields empty to derive them from the domain used to access the Web UI. New values apply to installation commands generated after saving; existing Agent services are not rewritten automatically.

The top bar displays the running version and reports when a newer GitHub Release exists. Release checks are cached for 30 minutes and failures do not interrupt normal Web UI operation.

## Updating a deployment

For a Git-based Docker Compose installation at `/opt/netpilot`, run:

```bash
cd /opt/netpilot
sh scripts/update.sh
```

The script fetches the configured branch (default `main`), resets the checkout to that upstream branch, rebuilds the server image, restarts the Compose services and removes unused images. Set `NETPILOT_DIR` or `NETPILOT_BRANCH` when your checkout or branch differs:

```bash
NETPILOT_DIR=/srv/netpilot NETPILOT_BRANCH=main sh /srv/netpilot/scripts/update.sh
```

The SQLite Docker volume and local `.env` file are preserved. Commit or back up local source changes before updating because the working tree is replaced with the selected upstream branch.

## Password and session security

- Passwords are never stored or logged in plaintext.
- Passwords are hashed with Node.js `scrypt`, a random 128-bit salt and a 64-byte derived key.
- Password comparisons use constant-time equality.
- Session identifiers are generated from 256 bits of randomness.
- Only SHA-256 session-token digests are stored in SQLite.
- Session cookies use `HttpOnly` and `SameSite=Lax`; `Secure` is enabled when `PUBLIC_BASE_URL` uses HTTPS.
- Agent registration tokens contain 256 bits of randomness and are also stored only as SHA-256 digests.
- Administrative actions are written to `audit_logs`.

Run NetPilot behind HTTPS in production and protect the SQLite file and database backups as secrets.

## Agent protocol

The Agent authenticates with the first WSS frame:

```json
{
  "type": "agent.auth",
  "token": "one-time-generated-agent-token",
  "payload": {
    "agentId": "agent_example",
    "os": "linux",
    "arch": "amd64",
    "version": "v0.1.21",
    "capabilities": ["iperf3", "nexttrace"],
    "nexttraceVersion": "v1.7.1"
  }
}
```

Important message types are `agent.heartbeat`, `agent.info`, `task.start`, `trace.start`, `task.cancel`, `task.stdout`, `task.stderr`, `task.metric`, `task.done`, `trace.stdout`, `trace.stderr`, `trace.done` and their error variants.

The Agent never constructs a shell command. It validates task fields and passes fixed argument arrays to `exec.CommandContext`. For route tracing, it resolves the target itself, enforces the requested address family, rejects private/reserved destinations for regular users and passes the selected IP to NextTrace to prevent DNS rebinding.

## Development

```bash
npm install
npm run dev
```

Server checks:

```bash
npm test
npm run check
```

Agent checks on a machine with Go 1.23:

```bash
cd agent
go test ./...
go build ./...
```

## Releases and container builds

`.github/workflows/build.yml` runs on pull requests, pushes to `main`, version tags and manual dispatches.

- Node.js 24 runs the server tests and syntax checks.
- Go 1.23 builds `netpilot-agent-linux-amd64` and `netpilot-agent-linux-arm64` with `CGO_ENABLED=0`.
- Version tags such as `v0.1.0` create GitHub Release assets.
- Buildx builds only the requested Alpine `linux/amd64` Agent image.
- The image is pushed to GitHub Container Registry on non-PR builds.

## Current scope

NetPilot is an early implementation. Before exposing it to untrusted users or the public Internet, add deployment-specific target CIDR allow/deny policies, login rate limiting, CSRF origin enforcement, retention controls, backup procedures and full end-to-end tests. Regular-user NextTrace requests already reject private and reserved targets at the server and Agent layers; administrators are intentionally allowed to trace private networks.

The server records the public IP observed on the Agent WSS connection. `ip_location` is included in the schema and protocol so a local GeoIP resolver can populate it without changing the Web API.

## License

Copyright (C) 2026 NetPilot contributors.

NetPilot is licensed under the GNU Affero General Public License, version 3 only. See [LICENSE](LICENSE).

Agent installations and images also contain the separate NextTrace v1.7.1 executable under GPL-3.0. Its exact source, attribution and installed license location are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). GeoIP and MapTrace are disabled by default because external provider terms may restrict third-party use.

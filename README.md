# NetPilot

NetPilot is a self-hosted web control plane for distributed `iperf3` tests. A Node.js server stores state in SQLite and sends test jobs to outbound-only Go agents over authenticated WebSocket connections.

## Features

- TCP and UDP `iperf3` tests with target, port, duration, parallel streams, bandwidth and reverse (`-R`) options
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
Go Agent ---- iperf3
```

Agents only create outbound WSS connections. They do not expose an inbound management port.

## Requirements

- Node.js 22.5 or newer; Node.js 24 is recommended
- Linux Agent host with `iperf3`
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

The generated command supplies the WSS address, Agent ID, Agent name and token as environment variables. The image is Alpine-based, includes `iperf3`, runs as an unprivileged user and is built for `linux/amd64`.

### One-line installer

The installer supports:

- `x86_64` / `amd64`
- `aarch64` / `arm64`
- systemd
- OpenRC
- Alpine, Debian/Ubuntu, Fedora and RHEL-family package managers

It installs the matching release binary, installs `iperf3`, stores the Agent token in `/etc/netpilot-agent/env` with mode `0600`, and starts the service.

An online or busy Agent cannot generate a new installation token, cannot be reinstalled from the Web UI and cannot be deleted. Disconnect the Agent first. This rule is enforced by the Node.js API, not only by the interface.

## Updating an Agent

Administrators can open **Agent** and use either update path:

- **Auto update** sends an authenticated WebSocket request to an online idle Agent. The page banner reports success or failure and includes the original and reported new version. Native `systemd` Agents are updated through a transient `systemd-run` unit when available, so the updater can survive the Agent service restart.
- **Manual update** shows the root command to run on the Agent host. Use this for offline Agents, Docker Agents without host Docker access, or when automatic update fails.

Agents older than `v0.1.5` do not understand the automatic update WebSocket request, so the server refuses auto-update for those Agents and asks you to run the manual update command once. After that first manual upgrade, future web-triggered auto-updates are available.

Updating is blocked while the Agent is running an iperf test. The update does not rotate or expose the Agent token.

The updater supports:

- Native `systemd` and OpenRC installations on `x86-64` and `arm64`
- The standard `netpilot-agent` Docker container created by NetPilot
- Optional GitHub acceleration configured under **System Settings**
- SHA-256 verification against the release `SHA256SUMS` file for native binaries
- Atomic binary replacement and automatic native-service rollback
- Docker image comparison, environment/restart-policy preservation and container rollback

For a native installation, the existing `/etc/netpilot-agent/env` file is not modified. For Docker, the manual updater preserves the `NETPILOT_*` environment variables and restart policy from the standard container. Custom Docker networks, mounts, capabilities or other manually added `docker run` options are outside the updater's scope. Automatic update usually cannot replace a standard Docker Agent container from inside the container unless you deliberately provide host Docker access, so keep the manual command available for Docker deployments.

The standalone endpoint is `/update-agent.sh`. Normally use the command generated by the Web UI because it includes the configured repository and GitHub acceleration prefix.

## User roles

| Capability | Administrator | Regular user |
| --- | --- | --- |
| Run tests | Any Agent | Assigned Agents only |
| View tests | All tests | Own tests only |
| Add, reinstall or remove Agents | Yes | No |
| Manage users | Yes | No |
| Change roles | Yes | No |
| Change system connection/download settings | `uid=1` only | No |

The system administrator is always `uid=1`. API requests that attempt to delete, disable or demote `uid=1` are rejected.

## System settings and version detection

Only the immutable `uid=1` system administrator can open **System Settings** or use `/api/settings`. The page controls:

- Agent WebSocket base URL, such as `wss://iperf.example.com` or `ws://192.0.2.10:8080`
- Agent script base URL for installation and updates, such as `https://iperf.example.com`
- Optional GitHub acceleration prefix used by Agent installation, Agent updates and version checks

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
    "version": "v0.1.0"
  }
}
```

Important message types are `agent.heartbeat`, `agent.info`, `task.start`, `task.cancel`, `task.stdout`, `task.stderr`, `task.metric`, `task.done` and `task.error`.

The Agent never constructs a shell command. It validates task fields and passes a fixed argument array to `exec.CommandContext("iperf3", args...)`.

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

NetPilot is an early implementation. Before exposing it to untrusted users or the public Internet, add target CIDR allow/deny policies, login rate limiting, CSRF origin enforcement, retention controls, backup procedures, full end-to-end tests and a maintained GeoIP database such as GeoLite2.

The server records the public IP observed on the Agent WSS connection. `ip_location` is included in the schema and protocol so a local GeoIP resolver can populate it without changing the Web API.

## License

Copyright (C) 2026 NetPilot contributors.

NetPilot is licensed under the GNU Affero General Public License, version 3 only. See [LICENSE](LICENSE).

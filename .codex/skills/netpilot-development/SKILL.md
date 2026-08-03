---
name: netpilot-development
description: Implement, review, or debug NetPilot server, browser UI, SQLite schema, Telegram Bot, WebSocket protocol, Go Agent, iperf3, or NextTrace behavior. Use for feature work and bug fixes in this repository, especially changes involving permissions, streaming output, Agent compatibility, Telegram callbacks, database migrations, or security invariants.
---

# NetPilot Development

## Establish context

Read `../../../HANDOFF.md` before changing behavior. Then read the relevant source and tests:

- Server/API/WS/data: `src/server.js`, `src/db.js`, `src/crypto.js`.
- Telegram: `src/telegram.js`, `test/telegram.test.js`.
- Browser: `public/index.html`, `public/app.js`, `public/styles.css`.
- Agent: `agent/main.go`, installer/updater scripts.

Check `git status --short` first and preserve unrelated changes.

## Protect invariants

- Keep uid=1 immutable, admin, enabled, and undeletable.
- Store passwords with scrypt and store session/Agent Token hashes only.
- Enforce Agent permissions in server code, not only the UI.
- Keep one active task per Agent in both server and Go Agent state.
- Reject private/reserved NextTrace targets for ordinary users at server and Agent layers.
- Bind Telegram callbacks and continuation steps to the requesting Telegram ID.
- Redact every Bot-owned iperf target surface in private groups.
- Ignore ordinary group chatter before group authorization responses.
- Preserve historical tasks when soft-deleting Agents.

## Implement changes

1. Trace the full path from input to persistence to output before editing.
2. Fix the root layer; do not compensate in the UI for a server invariant failure.
3. Keep protocol changes backward compatible when possible. Otherwise define a minimum Agent version and manual upgrade path.
4. Add migrations for existing SQLite databases as well as new-table definitions.
5. Use argument arrays for external commands. Never interpolate user input into a shell command.
6. Keep Web and Telegram behavior consistent when both consume the feature.
7. Update `HANDOFF.md` and README files when contracts, operations, defaults, or architecture change.

## Validate proportionally

Run the narrow test first, then the full suite:

```text
node --test test/telegram.test.js
npm test
npm run check
```

On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`. For Agent changes, run `go test ./...` and `go build ./...` from `agent/` when Go is available. For shell changes, run:

```text
sh -n public/install-agent.sh public/update-agent.sh scripts/update.sh
```

Add regression coverage for the exact failure mode. For streaming, verify Agent emission, server persistence/broadcast, UI WS handling, and rendered output separately.

## Finish safely

- Inspect `git diff --check` and the focused diff.
- Do not bump, tag, push, release, or deploy unless the user includes it in scope.
- Never put SSH passwords, Bot Tokens, Agent Tokens, cookies, `.env` secrets, or production databases in Git.

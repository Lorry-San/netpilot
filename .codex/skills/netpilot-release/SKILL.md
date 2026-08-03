---
name: netpilot-release
description: Prepare, publish, or verify a NetPilot version release through GitHub Actions. Use when bumping versions, tagging a release, building amd64 and arm64 Agent artifacts, publishing the Alpine amd64 Agent image, checking SHA256SUMS, or deciding whether a release is safe to deploy.
---

# NetPilot Release

## Confirm authorization and state

Read `../../../HANDOFF.md`, especially release and production sections. A request to code or test does not authorize pushing, tagging, releasing, or deploying. Proceed with external mutations only when requested.

Check:

```text
git status --short
git branch --show-current
git log -3 --oneline
```

Do not include unrelated or secret files.

## Prepare the version

Use semantic `X.Y.Z` in npm files and `vX.Y.Z` for the tag. Update together:

- `package.json`.
- `package-lock.json` top-level and root package versions.
- `public/index.html` CSS/JS cache query versions.
- Tests with intentional current-version assertions.
- README and `HANDOFF.md` when behavior or operations change.

Do not use local binaries as substitutes for CI release artifacts.

## Validate

Run:

```text
npm test
npm run check
sh -n public/install-agent.sh public/update-agent.sh scripts/update.sh
```

Run Agent Go checks when available. Inspect `git diff --check` and the complete release diff.

## Publish

1. Commit the focused release change.
2. Push `main`.
3. Create an annotated `vX.Y.Z` tag on the same commit.
4. Push the tag.
5. Wait for the tag workflow, not only the main workflow.

The tag workflow must succeed for `server`, `agent (amd64)`, `agent (arm64)`, `release`, and `agent-image`.

## Verify artifacts

Confirm the non-draft GitHub Release contains:

- `netpilot-agent-linux-amd64`.
- `netpilot-agent-linux-arm64`.
- `SHA256SUMS` matching both assets.

Confirm GHCR publishes the expected Alpine `linux/amd64` image tag. Treat action deprecation warnings separately from failures, but record them as debt.

## Hand off to deployment

Only after CI and artifacts succeed, use the production operations workflow. Verify deployed `package.json` and public `app.js?v=`. Agent hosts need updates only when Agent code, dependencies, protocol, or security changed.

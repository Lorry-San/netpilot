#!/bin/sh
set -eu

REPO="${NETPILOT_REPO:-Lorry-San/netpilot}"
ACCEL="${NETPILOT_GITHUB_ACCEL:-}"
MODE="${NETPILOT_UPDATE_MODE:-auto}"
BINARY="${NETPILOT_AGENT_BINARY:-/usr/local/bin/netpilot-agent}"
CONTAINER="${NETPILOT_AGENT_CONTAINER:-netpilot-agent}"
NEXTTRACE_VERSION="v1.7.1"
NEXTTRACE_BINARY="${NETPILOT_NEXTTRACE_BINARY:-/usr/local/bin/nexttrace}"
NEXTTRACE_LICENSE="${NETPILOT_NEXTTRACE_LICENSE:-/usr/share/licenses/nexttrace/LICENSE}"
SYSTEMD_OVERRIDE_DIR="${NETPILOT_SYSTEMD_OVERRIDE_DIR:-/etc/systemd/system/netpilot-agent.service.d}"
umask 077

if [ -n "$ACCEL" ] && [ "${ACCEL%/}" = "$ACCEL" ]; then ACCEL="${ACCEL}/"; fi

case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

ASSET="netpilot-agent-linux-${ARCH}"
DOWNLOAD_BASE="${ACCEL}https://github.com/${REPO}/releases/latest/download"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/netpilot-agent-update.XXXXXX")"
NEW_BINARY="${BINARY}.new.$$"
BACKUP_BINARY="${BINARY}.backup.$$"
BACKUP_CONTAINER="${CONTAINER}-backup-$$"
ROLLBACK=""

service_stop() {
  if [ "$SERVICE" = "systemd" ]; then systemctl stop netpilot-agent
  else rc-service netpilot-agent stop
  fi
}

service_start() {
  if [ "$SERVICE" = "systemd" ]; then systemctl start netpilot-agent
  else rc-service netpilot-agent start
  fi
}

service_healthy() {
  if [ "$SERVICE" = "systemd" ]; then systemctl is-active --quiet netpilot-agent
  else rc-service netpilot-agent status >/dev/null 2>&1
  fi
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$ROLLBACK" = "native" ]; then
    echo ">>> update failed; restoring previous Agent binary" >&2
    service_stop >/dev/null 2>&1 || true
    if [ -f "$BACKUP_BINARY" ]; then mv -f "$BACKUP_BINARY" "$BINARY"; fi
    service_start >/dev/null 2>&1 || true
  elif [ "$ROLLBACK" = "docker" ]; then
    echo ">>> update failed; restoring previous Agent container" >&2
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    if docker inspect "$BACKUP_CONTAINER" >/dev/null 2>&1; then
      docker rename "$BACKUP_CONTAINER" "$CONTAINER" >/dev/null 2>&1 || true
      docker start "$CONTAINER" >/dev/null 2>&1 || true
    fi
  fi
  rm -rf "$TEMP_DIR"
  rm -f "$NEW_BINARY"
  if [ "$status" -ne 0 ]; then exit "$status"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

download() {
  url="$1"
  destination="$2"
  if command -v curl >/dev/null 2>&1; then curl -fL --retry 3 "$url" -o "$destination"
  elif command -v wget >/dev/null 2>&1; then wget -O "$destination" "$url"
  else echo "curl or wget is required." >&2; exit 1
  fi
}

detect_service() {
  if command -v systemctl >/dev/null 2>&1 && systemctl cat netpilot-agent.service >/dev/null 2>&1; then
    SERVICE="systemd"
    return 0
  fi
  if command -v rc-service >/dev/null 2>&1 && [ -x /etc/init.d/netpilot-agent ]; then
    SERVICE="openrc"
    return 0
  fi
  return 1
}

install_systemd_runtime_override() {
  if [ "$SERVICE" != "systemd" ]; then return; fi
  mkdir -p "$SYSTEMD_OVERRIDE_DIR"
  cat > "$SYSTEMD_OVERRIDE_DIR/runtime-directory.conf" <<'UNIT'
[Service]
RuntimeDirectory=netpilot-agent
RuntimeDirectoryMode=0700
UNIT
  systemctl daemon-reload
}

update_native() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Native Agent updates must run as root." >&2
    exit 1
  fi
  if [ ! -x "$BINARY" ] || ! detect_service; then
    echo "A managed NetPilot Agent installation was not found." >&2
    exit 1
  fi
  if ! command -v sha256sum >/dev/null 2>&1; then
    echo "sha256sum is required to verify the Agent release." >&2
    exit 1
  fi
  install_systemd_runtime_override

  case "$ARCH" in
    amd64) nexttrace_checksum="1f4c559cbdf6f667a1a9e050567c9cf1fc11741e8cc1e50f5fdcaf2dbb247232" ;;
    arm64) nexttrace_checksum="9c2f1b79e7d0e37f59ebe685aec1d5c41fb8f3407f54e17b34656712eaa66fd9" ;;
  esac
  echo ">>> downloading NextTrace ${NEXTTRACE_VERSION}"
  download "${ACCEL}https://github.com/nxtrace/NTrace-core/releases/download/${NEXTTRACE_VERSION}/nexttrace_linux_${ARCH}" "$TEMP_DIR/nexttrace"
  download "${ACCEL}https://github.com/nxtrace/NTrace-core/raw/${NEXTTRACE_VERSION}/LICENSE" "$TEMP_DIR/NEXTTRACE-LICENSE"
  nexttrace_actual="$(sha256sum "$TEMP_DIR/nexttrace" | awk '{ print $1 }')"
  if [ "$nexttrace_actual" != "$nexttrace_checksum" ]; then
    echo "NextTrace checksum verification failed." >&2
    exit 1
  fi
  nexttrace_license_actual="$(sha256sum "$TEMP_DIR/NEXTTRACE-LICENSE" | awk '{ print $1 }')"
  if [ "$nexttrace_license_actual" != "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986" ]; then
    echo "NextTrace license checksum verification failed." >&2
    exit 1
  fi
  chmod 0755 "$TEMP_DIR/nexttrace"

  echo ">>> downloading latest ${ASSET}"
  download "${DOWNLOAD_BASE}/${ASSET}" "$NEW_BINARY"
  download "${DOWNLOAD_BASE}/SHA256SUMS" "$TEMP_DIR/SHA256SUMS"
  expected="$(awk -v asset="$ASSET" '$2 == asset || $2 == "*" asset { print $1; exit }' "$TEMP_DIR/SHA256SUMS")"
  actual="$(sha256sum "$NEW_BINARY" | awk '{ print $1 }')"
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "Agent checksum verification failed." >&2
    exit 1
  fi
  chmod 0755 "$NEW_BINARY"
  old_version="$($BINARY --version 2>/dev/null || echo unknown)"
  new_version="$($NEW_BINARY --version)"
  if [ "$old_version" = "$new_version" ]; then
    mkdir -p "$(dirname "$NEXTTRACE_BINARY")" "$(dirname "$NEXTTRACE_LICENSE")"
    mv "$TEMP_DIR/nexttrace" "$NEXTTRACE_BINARY"
    mv "$TEMP_DIR/NEXTTRACE-LICENSE" "$NEXTTRACE_LICENSE"
    echo ">>> NetPilot Agent is already up to date (${new_version})"
    exit 0
  fi
  echo ">>> upgrading ${old_version} -> ${new_version}"

  ROLLBACK="native"
  service_stop
  mkdir -p "$(dirname "$NEXTTRACE_BINARY")" "$(dirname "$NEXTTRACE_LICENSE")"
  mv "$TEMP_DIR/nexttrace" "$NEXTTRACE_BINARY"
  mv "$TEMP_DIR/NEXTTRACE-LICENSE" "$NEXTTRACE_LICENSE"
  mv "$BINARY" "$BACKUP_BINARY"
  mv "$NEW_BINARY" "$BINARY"
  service_start
  sleep 2
  if ! service_healthy; then
    echo "Updated Agent service did not become healthy." >&2
    exit 1
  fi
  ROLLBACK=""
  rm -f "$BACKUP_BINARY"
  echo ">>> NetPilot Agent updated to ${new_version}"
}

update_docker() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Docker Agent updates must run as root." >&2
    exit 1
  fi
  if ! command -v docker >/dev/null 2>&1 || ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
    echo "NetPilot Agent container '$CONTAINER' was not found." >&2
    exit 1
  fi
  if docker inspect "$BACKUP_CONTAINER" >/dev/null 2>&1; then
    echo "Backup container '$BACKUP_CONTAINER' already exists." >&2
    exit 1
  fi

  image="${NETPILOT_AGENT_IMAGE:-$(docker inspect --format '{{.Config.Image}}' "$CONTAINER")}"
  case "$image" in
    *netpilot-agent*) ;;
    *) echo "Container image '$image' is not a NetPilot Agent image." >&2; exit 1 ;;
  esac
  old_image_id="$(docker inspect --format '{{.Image}}' "$CONTAINER")"
  restart_policy="$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER")"
  if [ -z "$restart_policy" ] || [ "$restart_policy" = "no" ]; then restart_policy="unless-stopped"; fi
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" | awk '/^NETPILOT_/ { print }' > "$TEMP_DIR/agent.env"
  for required in NETPILOT_SERVER NETPILOT_TOKEN NETPILOT_AGENT_ID; do
    if ! grep -q "^${required}=" "$TEMP_DIR/agent.env"; then
      echo "Container is missing required environment variable ${required}." >&2
      exit 1
    fi
  done

  echo ">>> pulling ${image}"
  docker pull "$image"
  new_image_id="$(docker image inspect --format '{{.Id}}' "$image")"
  if [ "$old_image_id" = "$new_image_id" ]; then
    echo ">>> NetPilot Agent container is already up to date"
    exit 0
  fi
  ROLLBACK="docker"
  docker rename "$CONTAINER" "$BACKUP_CONTAINER"
  docker stop "$BACKUP_CONTAINER" >/dev/null
  docker run -d --name "$CONTAINER" --restart "$restart_policy" --cap-add NET_RAW --env-file "$TEMP_DIR/agent.env" "$image" >/dev/null
  sleep 3
  if [ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER")" != "true" ]; then
    echo "Updated Agent container did not become healthy." >&2
    exit 1
  fi
  if ! new_version="$(docker exec "$CONTAINER" /usr/local/bin/netpilot-agent --version 2>/dev/null)" || [ -z "$new_version" ]; then
    echo "Updated Agent container binary did not pass its version check." >&2
    exit 1
  fi
  ROLLBACK=""
  docker rm -f "$BACKUP_CONTAINER" >/dev/null
  echo ">>> NetPilot Agent container updated to ${new_version}"
}

if [ "$MODE" = "native" ]; then
  update_native
elif [ "$MODE" = "docker" ]; then
  update_docker
elif [ "$MODE" = "auto" ]; then
  if [ -x "$BINARY" ] && detect_service; then update_native
  elif command -v docker >/dev/null 2>&1 && docker inspect "$CONTAINER" >/dev/null 2>&1; then update_docker
  else
    echo "No supported NetPilot Agent installation was found." >&2
    echo "Run this script on the Agent host, or set NETPILOT_UPDATE_MODE=native|docker." >&2
    exit 1
  fi
else
  echo "NETPILOT_UPDATE_MODE must be auto, native or docker." >&2
  exit 1
fi

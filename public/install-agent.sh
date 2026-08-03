#!/bin/sh
set -eu

REPO="${NETPILOT_REPO:-Lorry-San/netpilot}"
SERVER="${NETPILOT_SERVER:-}"
TOKEN="${NETPILOT_TOKEN:-}"
AGENT_ID="${NETPILOT_AGENT_ID:-}"
AGENT_NAME="${NETPILOT_AGENT_NAME:-}"
ACCEL="${NETPILOT_GITHUB_ACCEL:-}"
NEXTTRACE_VERSION="v1.7.1"
if [ -n "$ACCEL" ] && [ "${ACCEL%/}" = "$ACCEL" ]; then ACCEL="${ACCEL}/"; fi

if [ "$(id -u)" -ne 0 ]; then
  echo "This installer must run as root." >&2
  exit 1
fi
if [ -z "$SERVER" ] || [ -z "$TOKEN" ] || [ -z "$AGENT_ID" ]; then
  echo "NETPILOT_SERVER, NETPILOT_TOKEN and NETPILOT_AGENT_ID are required." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

install_iperf3() {
  if command -v iperf3 >/dev/null 2>&1; then return; fi
  if command -v apk >/dev/null 2>&1; then apk add --no-cache iperf3 ca-certificates
  elif command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y iperf3 ca-certificates
  elif command -v dnf >/dev/null 2>&1; then dnf install -y iperf3 ca-certificates
  elif command -v yum >/dev/null 2>&1; then yum install -y iperf3 ca-certificates
  else echo "iperf3 is required and no supported package manager was found." >&2; exit 1
  fi
}

download() {
  url="$1"
  destination="$2"
  if command -v curl >/dev/null 2>&1; then curl -fL --retry 3 "$url" -o "$destination"
  elif command -v wget >/dev/null 2>&1; then wget -O "$destination" "$url"
  else echo "curl or wget is required." >&2; exit 1
  fi
}

install_nexttrace() {
  case "$ARCH" in
    amd64) checksum="1f4c559cbdf6f667a1a9e050567c9cf1fc11741e8cc1e50f5fdcaf2dbb247232" ;;
    arm64) checksum="9c2f1b79e7d0e37f59ebe685aec1d5c41fb8f3407f54e17b34656712eaa66fd9" ;;
  esac
  url="${ACCEL}https://github.com/nxtrace/NTrace-core/releases/download/${NEXTTRACE_VERSION}/nexttrace_linux_${ARCH}"
  download "$url" /usr/local/bin/nexttrace.tmp
  download "${ACCEL}https://github.com/nxtrace/NTrace-core/raw/${NEXTTRACE_VERSION}/LICENSE" /tmp/netpilot-nexttrace-license
  actual="$(sha256sum /usr/local/bin/nexttrace.tmp | awk '{ print $1 }')"
  if [ "$actual" != "$checksum" ]; then
    rm -f /usr/local/bin/nexttrace.tmp
    echo "NextTrace checksum verification failed." >&2
    exit 1
  fi
  license_actual="$(sha256sum /tmp/netpilot-nexttrace-license | awk '{ print $1 }')"
  if [ "$license_actual" != "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986" ]; then
    rm -f /usr/local/bin/nexttrace.tmp /tmp/netpilot-nexttrace-license
    echo "NextTrace license checksum verification failed." >&2
    exit 1
  fi
  chmod 0755 /usr/local/bin/nexttrace.tmp
  mv /usr/local/bin/nexttrace.tmp /usr/local/bin/nexttrace
  mkdir -p /usr/share/licenses/nexttrace
  mv /tmp/netpilot-nexttrace-license /usr/share/licenses/nexttrace/LICENSE
}

escape_value() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

install_iperf3
if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum is required to verify NextTrace." >&2
  exit 1
fi
install_nexttrace
DOWNLOAD_URL="${ACCEL}https://github.com/${REPO}/releases/latest/download/netpilot-agent-linux-${ARCH}"
download "$DOWNLOAD_URL" /usr/local/bin/netpilot-agent.tmp
chmod 0755 /usr/local/bin/netpilot-agent.tmp
mv /usr/local/bin/netpilot-agent.tmp /usr/local/bin/netpilot-agent

mkdir -p /etc/netpilot-agent
umask 077
{
  printf 'NETPILOT_SERVER="%s"\n' "$(escape_value "$SERVER")"
  printf 'NETPILOT_TOKEN="%s"\n' "$(escape_value "$TOKEN")"
  printf 'NETPILOT_AGENT_ID="%s"\n' "$(escape_value "$AGENT_ID")"
  printf 'NETPILOT_AGENT_NAME="%s"\n' "$(escape_value "$AGENT_NAME")"
} > /etc/netpilot-agent/env
chmod 0600 /etc/netpilot-agent/env

if command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/netpilot-agent.service <<'UNIT'
[Unit]
Description=NetPilot Network Test Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/netpilot-agent/env
ExecStart=/usr/local/bin/netpilot-agent
Restart=always
RestartSec=5
NoNewPrivileges=true
CapabilityBoundingSet=CAP_NET_RAW
AmbientCapabilities=CAP_NET_RAW
RuntimeDirectory=netpilot-agent
RuntimeDirectoryMode=0700
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now netpilot-agent
elif command -v rc-service >/dev/null 2>&1; then
  cat > /etc/init.d/netpilot-agent <<'OPENRC'
#!/sbin/openrc-run
description="NetPilot Network Test Agent"

. /etc/netpilot-agent/env
export NETPILOT_SERVER NETPILOT_TOKEN NETPILOT_AGENT_ID NETPILOT_AGENT_NAME

command="/usr/local/bin/netpilot-agent"
command_background="yes"
pidfile="/run/netpilot-agent.pid"
output_log="/var/log/netpilot-agent.log"
error_log="/var/log/netpilot-agent.log"

depend() { need net; }
OPENRC
  chmod 0755 /etc/init.d/netpilot-agent
  rc-update add netpilot-agent default
  rc-service netpilot-agent restart
else
  echo "Installed /usr/local/bin/netpilot-agent, but systemd/OpenRC was not found."
  echo "Start it with: set -a; . /etc/netpilot-agent/env; set +a; netpilot-agent"
fi

echo "NetPilot Agent with NextTrace ${NEXTTRACE_VERSION} installed for ${ARCH}."

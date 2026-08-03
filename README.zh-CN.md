# NetPilot

[English](README.md) | 简体中文

维护者请先阅读 [项目交接文档](HANDOFF.md)。仓库还提供 NetPilot 开发、发布和生产运维三个 Codex skill，位于 [`.codex/skills`](.codex/skills)。

[![构建与发布](https://github.com/Lorry-San/netpilot/actions/workflows/build.yml/badge.svg)](https://github.com/Lorry-San/netpilot/actions/workflows/build.yml)
[![GitHub Release](https://img.shields.io/github/v/release/Lorry-San/netpilot)](https://github.com/Lorry-San/netpilot/releases/latest)
[![许可证：AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

NetPilot 是一个可自托管的分布式 `iperf3` 与 NextTrace 网页测试平台。Node.js 服务端使用 SQLite 保存数据，通过带 Token 鉴权的 WebSocket 长连接向只建立出站连接的 Go Agent 下发任务。浏览器端提供实时原始输出、速率曲线、路由明细、多用户权限和 Agent 管理，也可以通过可选的 Telegram Bot 使用同一批 Agent。

## 功能

- 支持 TCP/UDP `iperf3` 测试，可设置目标、端口、时长、并行流、带宽和反向测试（`-R`）
- 支持 ICMP/TCP/UDP NextTrace v1.7.1 路由追踪，可设置 IPv4/IPv6、包大小、最大跳数、每跳查询次数、超时、PTR 和 MPLS
- 通过 `/ws/ui` 向浏览器实时推送原始输出和速率/时间数据
- 提供带坐标轴、单位、数据点和数值标记的速率曲线
- Linux Agent 同时支持 `x86-64` 和 `arm64`
- 显示 Agent CPU、内存和网络接口带宽占用
- 支持 Agent 命名、公网连接 IP 和 IP 归属地
- 支持管理员与普通用户两种角色，以及按用户分配 Agent 权限
- 系统管理员固定为 `uid=1`，不能删除、禁用或降级
- 使用 SQLite WAL 模式保存数据
- 提供 Alpine `linux/amd64` Agent Docker 镜像安装命令
- 提供自动识别 `x86-64`/`arm64` 的 Linux 一键安装脚本
- 支持在线原生 Agent 自动更新及手动原地更新，包含校验和验证与失败回滚
- 可分别设置 Agent WebSocket 地址、安装脚本地址和 GitHub 下载加速地址
- 在 Web 顶栏检测最新 GitHub Release
- Telegram Bot 支持 `iperf3` 和 `/nexttrace`、账号绑定、鉴权后的 Agent 选择、进度更新与原始输出
- 支持管理员管理 Telegram 群组及私有/公共访问模式
- 提供 Docker Compose 服务端原地更新脚本
- GitHub Actions 自动构建双架构 Agent、Release 附件和 amd64 Agent 镜像

## 架构

```text
浏览器
   |
   | HTTPS / JSON
   v
Node.js 控制端 -------- SQLite
   |
   | WSS + Agent Token
   v
Go Agent -------- iperf3 / NextTrace

Telegram Bot ---- long polling ---- Node.js 控制端
```

Agent 只会主动建立出站 WSS 连接，不开放入站管理端口。

## 环境要求

- Node.js 22.5 或更高版本，推荐 Node.js 24
- Linux Agent 主机；安装脚本会安装 `iperf3` 和固定版本的 NextTrace v1.7.1
- 生产环境建议使用 Caddy 或 Nginx 终止 TLS

服务端直接使用 Node.js 内置的 `node:sqlite`，不依赖原生 SQLite npm 模块。

## 快速开始

```bash
git clone https://github.com/Lorry-San/netpilot.git
cd netpilot
cp .env.example .env
npm ci

ADMIN_PASSWORD='请替换为足够长的随机密码' \
PUBLIC_BASE_URL='http://localhost:8080' \
npm start
```

打开 `http://localhost:8080`，使用用户名 `admin` 登录。

全新数据库会显式创建 `uid=1` 的系统管理员。如果没有设置 `ADMIN_PASSWORD`，或密码少于 12 个字符，NetPilot 会生成随机初始密码，并仅在服务端控制台输出一次。

## 使用 Docker Compose 部署服务端

创建 `.env`：

```dotenv
PUBLIC_BASE_URL=https://netpilot.example.com
GITHUB_REPO=Lorry-San/netpilot
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-at-least-12-characters
```

启动服务：

```bash
docker compose up -d --build
```

SQLite 数据保存在 `netpilot-data` 卷中。

## 添加 Agent

1. 使用管理员账号登录。
2. 打开 **Agent** 页面。
3. 点击 **添加 Agent** 并设置名称。
4. 执行页面生成的 Docker 命令或一键安装命令。

Token 只在生成后显示一次，服务端仅保存它的 SHA-256 摘要。

默认情况下，安装命令使用管理员当前访问请求中的协议和域名，包括反向代理传入的 `X-Forwarded-Proto`。只有请求主机缺失或不合法时才回退到 `PUBLIC_BASE_URL`。`uid=1` 系统管理员可以在 **系统设置** 中分别覆盖 Agent WebSocket 地址和安装脚本地址，适用于 Web 页面与 WebSocket 使用不同域名或 IP 的场景。

### Docker Agent

GitHub Actions 发布以下镜像：

```text
ghcr.io/lorry-san/netpilot/netpilot-agent:latest
```

页面生成的命令会传入 WSS 地址、Agent ID、Agent 名称和 Token，并且仅添加路由探测需要的 `NET_RAW` 能力。镜像基于 Alpine，内置 `iperf3` 和经过校验和验证的 NextTrace v1.7.1，以非特权用户运行，目前提供 `linux/amd64` 版本。

### 一键安装脚本

安装脚本支持：

- `x86_64` / `amd64`
- `aarch64` / `arm64`
- systemd
- OpenRC
- Alpine、Debian/Ubuntu、Fedora 和 RHEL 系包管理器

脚本会安装对应架构的 Release 二进制、`iperf3`、经过校验的 NextTrace v1.7.1 及其 GPL-3.0 许可证，将 Agent Token 以 `0600` 权限保存到 `/etc/netpilot-agent/env`，然后启动服务。systemd 单元仅保留 `CAP_NET_RAW` 能力。

在线或忙碌状态的 Agent 不能重新生成安装 Token、不能从 Web 页面重新安装，也不能删除。需要先断开 Agent。该限制由 Node.js API 强制执行，不只依赖前端按钮状态。

## 更新 Agent

管理员可以在 **Agent** 页面选择两种更新方式：

- **自动更新**：通过已鉴权的 WebSocket 向在线且空闲的 Agent 下发更新请求。页面顶部会显示更新成功或失败，并包含原版本和更新后版本。原生 systemd Agent 会尽可能使用临时 `systemd-run` 单元，使更新进程可以跨越 Agent 服务重启。
- **手动更新**：显示需要在 Agent 主机上以 root 执行的命令。适用于离线 Agent、不能访问宿主机 Docker 的容器 Agent，或自动更新失败的情况。

低于 `v0.1.19` 的 Agent 可能不支持自动更新 WebSocket 请求，或会把更新脚本放进 systemd 私有 `/tmp` 命名空间。服务端会拒绝向这些版本下发自动更新，并要求先手动更新一次。手动更新会安装共享运行时目录，之后的网页自动更新可以独立运行并等待新 Agent 重连。

Agent 正在执行 iperf 或路由追踪任务时不能更新。更新过程不会轮换或暴露 Agent Token。更新到 v0.1.18 或更高版本时也会安装固定版本的 NextTrace；旧 Agent 仍能执行 iperf，但页面会显示其不支持路由追踪。

更新脚本支持：

- systemd/OpenRC 原生安装，兼容 `x86-64` 和 `arm64`
- NetPilot 创建的标准 `netpilot-agent` Docker 容器
- **系统设置** 中配置的可选 GitHub 加速地址
- 根据 Release `SHA256SUMS` 校验原生二进制
- 原子替换二进制和原生服务自动回滚
- Docker 镜像比较、环境变量/重启策略保留和容器回滚

原生安装不会修改现有 `/etc/netpilot-agent/env`。Docker 手动更新会保留 `NETPILOT_*` 环境变量和重启策略，并为替换后的标准容器添加 `NET_RAW`。自定义 Docker 网络、挂载和其他手工增加的 `docker run` 参数不在更新器处理范围内。除非主动向容器开放宿主机 Docker 权限，否则自动更新通常无法从容器内部替换 Agent 容器，因此应保留手动更新命令。

独立更新脚本地址为 `/update-agent.sh`。通常应使用 Web 页面生成的命令，因为其中包含已配置的仓库和 GitHub 加速前缀。

## 用户角色

| 权限 | 管理员 | 普通用户 |
| --- | --- | --- |
| 执行测试 | 任意 Agent | 仅分配给自己的 Agent |
| 查看测试 | 全部测试 | 仅自己的测试 |
| 添加、重装或删除 Agent | 是 | 否 |
| 管理用户 | 是 | 否 |
| 修改角色 | 是 | 否 |
| 配置 Telegram 群组 | 是 | 否 |
| 修改系统连接/下载设置 | 仅 `uid=1` | 否 |

系统管理员始终为 `uid=1`。任何尝试删除、禁用或降级 `uid=1` 的 API 请求都会被拒绝。

## Telegram Bot

`uid=1` 系统管理员可以在 **系统设置** 中填写 BotFather Token。NetPilot 会通过 `getMe` 验证 Token，显示连接到的 Bot 用户名，然后在 Node.js 进程中启动 Telegram Bot API 长轮询，不需要公开 webhook。清空 Token 会停止 Bot。

每个用户可以在独立的 **Telegram 机器人** 页面绑定一个 Telegram 账号：

1. 在 Web 页面点击 **生成绑定码**。
2. 在 10 分钟内向 Bot 发送 `/bind <绑定码>`。
3. 在私聊或允许的群组中使用 `/help`、`/status`、`/agents`、`/iperf`、`/iperf <IP> [端口] [线程] [时长] [-R]` 或 `/nexttrace [参数] <目标>`。

Bot 启动时会自动注册命令菜单。未绑定用户私聊时会收到未授权提示，但仍可使用 `/bind`。

`/iperf` 不带参数时进入交互流程：选择 Agent、选择上行或下行，然后在 Bot 私聊中输入 `IP:端口`，端口默认 `5201`。在群组中调用时，方向按钮会直接打开经过鉴权的私聊继续操作。`/iperf IP` 是快速上行模式，默认端口 `5201`、1 个并行流、10 秒。快速下行同时支持 `/iperf IP -R` 和 `/iperf -R IP`。

Bot 使用带鉴权、支持分页和多选的键盘展示当前用户可用的在线 Agent。所有回调按钮和私聊后续步骤都绑定请求者的 Telegram ID，并在每一步重新检查权限。测试进度、结果和图表文件都会回复最初召唤 Bot 的消息。选择多个 Agent 时会严格逐个执行，因为标准 iperf3 服务端一次只能接受一个客户端；当前任务结束后才会下发下一个。Web Agent 权限和忙碌/离线状态检查仍然生效。

运行中的消息会显示当前 Agent、单次测试进度、输出行数和批次已用时间，并提供鉴权后的刷新和停止按钮。最终结果包含每次测试及总耗时、Telegram 可折叠原始输出，以及以文件发送的 PNG 曲线图。曲线包含 X/Y 轴、单位、数据点和每个点的实测数值。过长的原始输出会保留尾部以满足 Telegram 消息长度限制。

`/nexttrace` 支持与 NextTrace 类似的安全参数子集：`-4`、`-6`、`-T`、`-U`、`-p`、`-q`、`-m`、`--timeout`、`--parallel-requests`、`--psize`、`-n` 和 `-e`。例如：

```text
/nexttrace -T -p 443 -q 3 --psize 64 example.com
```

参数解析完成后，Bot 只显示在线且声明支持 `nexttrace` 的 Agent；选择一个 Agent 后立即开始。最终回复包含 Agent、目标、协议、地址族、包大小、跳数摘要、耗时和可折叠原生输出。超过 Telegram 消息长度的输出也会作为文本文件发送，不生成图表。

已经绑定的 Telegram 账号把 Bot 加入群组时，系统会在 **Telegram 机器人** 页面登记该群组；发送命令也可以作为兜底登记方式。管理员可以在一个连续列表中多选群组，并设置为：

- **私有模式**：只有已绑定 NetPilot 的 Telegram 账号可以使用，并沿用各自的 Agent 权限。群组中所有人发起的 `/iperf` 测试都会在 Bot 回复里把真实目标替换为 `x.x.x.x`，覆盖 Agent 选择提示、运行进度、可折叠原始输出、错误信息和图表标题。系统内部仍保留真实目标并下发给 Agent，不影响实际测速。
- **公共模式**：群组所有成员都可以使用。未绑定成员沿用群组登记者的 Agent 权限。

管理员可以登记任意数量的群组。普通用户只能登记一个群组，并且只能保持私有模式或删除它。只有 NetPilot 管理员可以开启公共模式，所有群组修改都会由 API 再次鉴权。

## 系统设置与版本检测

只有不可变的 `uid=1` 系统管理员可以打开 **系统设置** 或访问 `/api/settings`。该页面可以设置：

- Agent WebSocket 基础地址，例如 `wss://iperf.example.com` 或 `ws://192.0.2.10:8080`
- Agent 安装和更新脚本基础地址，例如 `https://iperf.example.com`
- Agent 安装、更新和版本检测共用的可选 GitHub 加速前缀
- Telegram Bot Token，仅 `uid=1` 可以查看或修改
- NextTrace GeoIP 数据源，以及是否允许生成外部 MapTrace

配置保存在 SQLite 中。WS 和安装脚本地址留空时，会根据用户访问 Web 页面的域名自动生成。保存后的新值只影响之后生成的安装命令，不会自动重写已安装 Agent 的服务配置。

页面顶栏显示当前运行版本，并在 GitHub 出现新 Release 时提示。Release 检查结果缓存 30 分钟，检查失败不会影响正常使用。

## 更新服务端部署

如果使用位于 `/opt/netpilot` 的 Git 仓库和 Docker Compose 部署，执行：

```bash
cd /opt/netpilot
sh scripts/update.sh
```

脚本会拉取配置的分支（默认 `main`），将工作区同步到上游分支，重新构建服务端镜像、重启 Compose 服务并移除无用镜像。如果目录或分支不同，可以设置：

```bash
NETPILOT_DIR=/srv/netpilot NETPILOT_BRANCH=main sh /srv/netpilot/scripts/update.sh
```

SQLite Docker 卷和本地 `.env` 会保留。更新脚本会替换所选分支的工作区，因此请先提交或备份本地源码修改。

## 密码与会话安全

- 密码不会以明文保存或写入日志
- 密码使用 Node.js `scrypt`、随机 128 位盐和 64 字节派生密钥进行哈希
- 密码比较使用恒定时间算法
- 会话 ID 使用 256 位随机数生成
- SQLite 只保存会话 Token 的 SHA-256 摘要
- 会话 Cookie 使用 `HttpOnly` 和 `SameSite=Lax`；`PUBLIC_BASE_URL` 为 HTTPS 时启用 `Secure`
- Agent 注册 Token 使用 256 位随机数，同样只保存 SHA-256 摘要
- 管理操作会记录到 `audit_logs`

生产环境请始终使用 HTTPS，并将 SQLite 文件和数据库备份视为敏感信息保护。

## Agent 协议

Agent 通过第一条 WSS 消息进行鉴权：

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

主要消息类型包括 `agent.heartbeat`、`agent.info`、`task.start`、`trace.start`、`task.cancel`、`task.stdout`、`task.stderr`、`task.metric`、`task.done`、`trace.stdout`、`trace.stderr`、`trace.done` 及对应错误消息。

Agent 不拼接 Shell 命令。它会验证任务字段，并用固定参数数组调用 `exec.CommandContext`。路由追踪时，Agent 会自行解析目标、限制请求的地址族、拒绝普通用户访问私有/保留地址，并将选定 IP 传给 NextTrace，以阻止 DNS 重绑定。

## 开发

```bash
npm install
npm run dev
```

服务端检查：

```bash
npm test
npm run check
```

在安装 Go 1.23 的机器上检查 Agent：

```bash
cd agent
go test ./...
go build ./...
```

## Release 与容器构建

`.github/workflows/build.yml` 会在 Pull Request、推送到 `main`、推送版本标签和手动触发时运行。

- Node.js 24 执行服务端测试和语法检查
- Go 1.23 使用 `CGO_ENABLED=0` 构建 `netpilot-agent-linux-amd64` 和 `netpilot-agent-linux-arm64`
- `v0.1.0` 一类版本标签会创建 GitHub Release 附件
- Buildx 只构建要求的 Alpine `linux/amd64` Agent 镜像
- 非 Pull Request 构建会把镜像推送到 GitHub Container Registry

## 当前范围

NetPilot 仍处于早期阶段。在向不受信任的用户或公网开放前，应根据部署环境补充目标 CIDR 黑白名单、登录频率限制、CSRF Origin 校验、数据保留策略、备份方案和完整的端到端测试。普通用户的 NextTrace 请求已经在服务端和 Agent 两层拒绝私有及保留目标；管理员被有意允许追踪私有网络。

服务端会记录 Agent WSS 连接的公网 IP。数据库和协议已包含 `ip_location` 字段，可以在不修改 Web API 的情况下接入本地 GeoIP 解析器。

## 开源许可证

Copyright (C) 2026 NetPilot contributors.

NetPilot 使用 GNU Affero General Public License v3.0 only 开源，详见 [LICENSE](LICENSE)。

Agent 安装包和镜像还包含单独以 GPL-3.0 发布的 NextTrace v1.7.1 可执行文件。其源码、署名和安装后的许可证位置记录在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。GeoIP 和 MapTrace 默认关闭，因为外部服务条款可能限制第三方使用。

服务端内置 WenQuanYi Micro Hei 字体（Apache-2.0 或 GPL-3.0 字体嵌入例外双许可），用于在无系统字体的容器中将 Telegram 速率图的坐标轴、数据点数值、图例和中文标题渲染为 PNG，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

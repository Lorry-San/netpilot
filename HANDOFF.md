# NetPilot 项目交接文档

> 本文是 NetPilot 的维护事实源。README 面向用户；本文面向接手开发、发布和生产运维的人，记录代码边界、协议、数据、权限、不变量、生产现状、排障方式和技术债。

## 1. 当前状态

| 项目 | 当前值 |
| --- | --- |
| GitHub | `Lorry-San/netpilot` |
| 默认分支 | `main` |
| 许可证 | `AGPL-3.0-only` |
| 交接版本 | `v0.1.23` |
| 交接提交 | `v0.1.23` 标签指向的发布提交 |
| 核对日期 | 2026-08-03（Asia/Shanghai） |
| 生产站点 | `https://iperf.nbiepl.cloud` |
| 生产主机 | `103.240.198.97` |
| 服务端目录 | `/opt/netpilot` |

版本、提交和 DNS 会变化。每次排障先重新核实 `git rev-parse HEAD`、`package.json`、GitHub Release、站点资源版本和 DNS。

## 2. 产品与架构

NetPilot 是自托管 C/S 网络测试平台：

- Node.js 控制端提供 Web、JSON API、浏览器实时 WebSocket、Agent WebSocket 和 Telegram Bot。
- Go Agent 只建立出站 WSS，在 Linux 上执行 `iperf3` 和 NextTrace，不开放管理端口。
- SQLite 是唯一持久化层，保存用户、权限、Agent、任务、输出、指标、设置和审计。
- Web 与 Telegram 共用同一套用户、Agent 权限和任务创建逻辑。
- Agent 原生二进制支持 Linux `amd64`/`arm64`；Alpine Docker Agent 当前只发布 `linux/amd64`。

```text
浏览器
  ├─ HTTPS / JSON API ───────────────┐
  └─ WSS /ws/ui（Cookie 会话）───────┤
                                      v
Telegram API <─ long polling ── Node.js 控制端 ── SQLite WAL
                                      |
                                      | WSS /ws/agent + Token 首包鉴权
                                      v
                                  Go Agent
                                  ├─ iperf3
                                  ├─ nexttrace
                                  └─ /proc、/sys 探针
```

控制端是单进程、单实例设计。Telegram `getUpdates` 也只适合一个活跃实例；横向扩容前必须解决 Agent 连接归属、UI 广播、Telegram offset、任务锁和 SQLite 协调。

## 3. 目录职责

| 路径 | 职责 |
| --- | --- |
| `src/server.js` | HTTP API、两类 WS、任务生命周期、权限、Agent 更新、静态文件 |
| `src/telegram.js` | Bot 长轮询、命令、绑定、群组、按钮鉴权、图表和批量串行测速 |
| `src/db.js` | SQLite schema、轻量迁移、WAL、查询和事务 |
| `src/crypto.js` | scrypt 密码、随机 Token、SHA-256 摘要 |
| `public/index.html` | 单页应用结构、表单和对话框 |
| `public/app.js` | 前端状态、API、实时 WS、图表和交互 |
| `public/styles.css` | 全部 Web 样式 |
| `assets/fonts/` | Telegram 图表 PNG 栅格化内置字体（WenQuanYi Micro Hei）及许可证 |
| `public/install-agent.sh` | 原生 Agent 一键安装 |
| `public/update-agent.sh` | 原生/Docker Agent 更新、校验和、回滚 |
| `agent/main.go` | Agent 鉴权、互斥、命令执行、流式输出、探针、自动更新 |
| `agent/Dockerfile` | Alpine amd64 Agent 镜像 |
| `scripts/update.sh` | Git + Compose 服务端原地更新 |
| `test/*.test.js` | 服务端、静态、实时 WS、Telegram、更新器回归测试 |
| `.github/workflows/build.yml` | CI、双架构 Agent、Release、GHCR 镜像 |
| `.codex/skills/` | 随仓库交接的维护技能 |

前端没有框架和构建器。修改 JS/CSS 后要同步 `public/index.html` 的 `?v=`，防止浏览器或 CDN 继续缓存旧资源。

## 4. 运行依赖

### 服务端

- Node.js 最低 `22.5`，Docker/CI 使用 Node.js 24。
- npm 依赖：`ws`、`@resvg/resvg-js`。
- 图表 PNG 的文字由 `assets/fonts/` 内置字体渲染（生产镜像没有系统字体，resvg 会静默丢字）；服务端 Dockerfile 必须复制该目录。
- SQLite 使用 Node 内置 `node:sqlite`。
- 默认端口 `8080`，Docker 数据库为 `/data/netpilot.sqlite`。
- SQLite 启用 WAL、外键和 5 秒 busy timeout。

### Agent

- Go 代码在 `agent/`，依赖 `gorilla/websocket`。
- CI 使用 Go 1.23、`CGO_ENABLED=0` 构建 Linux amd64/arm64。
- 运行依赖 `iperf3`；NextTrace 能力取决于 `nexttrace` 是否存在。
- 探针读取 `/proc/stat`、`/proc/meminfo`、`/proc/net/dev` 和 `/sys/class/net/*/speed`。

## 5. 配置

### 服务端环境变量

| 变量 | 默认/要求 | 作用 |
| --- | --- | --- |
| `PORT` | `8080` | 监听端口 |
| `DB_PATH` | `.data/netpilot.sqlite` | SQLite 路径 |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | Cookie Secure、日志及 Host 回退 |
| `GITHUB_REPO` | `Lorry-San/netpilot` | Release、镜像、安装命令仓库 |
| `ADMIN_USERNAME` | `admin` | 全新 DB 创建 uid=1 时使用 |
| `ADMIN_PASSWORD` | 至少 12 字符 | 全新 DB 创建 uid=1；不足会生成一次性随机密码并输出 |
| `NETPILOT_DISABLE_TELEGRAM` | 未设置 | 测试中设 `1` 禁止 Bot |

修改部署环境中的 `ADMIN_PASSWORD` 不会修改已有数据库的管理员密码，它只在 uid=1 尚不存在时生效。

### Agent 环境变量

- `NETPILOT_SERVER`：完整 `/ws/agent` 的 `ws://`/`wss://` 地址。
- `NETPILOT_TOKEN`：Agent Token 明文；服务端只保存摘要。
- `NETPILOT_AGENT_ID`：服务端生成的 ID。
- `NETPILOT_AGENT_NAME`：显示名称。

原生安装写入 `/etc/netpilot-agent/env`，权限必须保持 `0600`。

### uid=1 系统设置

只有 uid=1 能通过 `/api/settings` 维护：

- `agent_ws_base`：新安装命令使用的 WS/WSS 基础地址。
- `script_base`：安装/更新脚本基础地址。
- `github_accel_enabled`、`github_accel_domain`：GitHub 加速前缀。
- `telegram_bot_token`、`telegram_bot_username`：Bot 凭据和验证后的用户名。
- `nexttrace_data_provider`、`nexttrace_map_enabled`。
- `telegram_update_offset`：Bot 长轮询消费位置。

WS/脚本地址留空时，安装命令使用实际请求 Host 和 `X-Forwarded-Proto`，再回退 `PUBLIC_BASE_URL`。反向代理必须正确传这些头。

## 6. 数据模型

| 表 | 作用 |
| --- | --- |
| `users` | 用户、显示名、密码哈希、角色、禁用；`id=1` 为系统管理员 |
| `sessions` | 会话 Token 摘要、用户、过期时间 |
| `agents` | Agent Token 摘要、状态、平台、版本、能力、探针、软删除 |
| `user_agent_permissions` | 普通用户可用 Agent 多对多表 |
| `tests` | iperf 参数、状态、结果元数据 |
| `test_output` | iperf stdout/stderr 按行保存 |
| `test_metrics` | 时间、发送/接收 Mbps、资源指标 |
| `trace_tasks` | NextTrace 参数、状态、结果元数据 |
| `trace_output` | NextTrace stdout/stderr 按行保存 |
| `trace_hops` | 按 `trace_id + ttl` upsert 的结构化跳点 |
| `settings` | 系统键值设置和 Telegram offset |
| `telegram_users` | Telegram ID 与用户一对一绑定 |
| `telegram_groups` | 群组所有者和 `members_only/all_members` 模式 |
| `telegram_bind_codes` | 10 分钟有效六位绑定码 |
| `audit_logs` | 登录、管理、测试、更新等审计 |

迁移直接写在 `src/db.js`：先建表，再通过 `PRAGMA table_info` 增列。增加字段时必须同时支持新数据库和已有生产数据库。

Agent 状态：`offline`、`online`、`busy`。Agent 断开会把运行中的 iperf/trace 标为失败；SQLite 锁冲突时断开收尾最多重试三次。

任务允许 `queued/running/completed/failed/cancelled/timeout`。当前创建后通常直接 `running`，没有通用队列；Telegram 多 Agent 是 Bot 内存中逐个调用，不是数据库排队。

## 7. 安全与权限不变量

### 密码和会话

- 密码最少 12 字符。
- scrypt：`N=16384, r=8, p=1`，16 字节随机盐、64 字节派生值。
- 会话/Agent Token 为 32 字节随机值，数据库只保存 SHA-256 摘要。
- 会话 24 小时；Cookie 为 `HttpOnly; SameSite=Lax`，HTTPS 时加 `Secure`。

### 不可破坏的不变量

1. uid=1 永远是管理员，不能改 UID、降权、禁用或删除。
2. 所有用户 UID 都不可修改。
3. 只有 uid=1 能读写系统设置和 Bot Token。
4. 管理员可用所有未删除 Agent；普通用户只能用已分配 Agent。
5. 在线/忙碌 Agent 不能轮换安装 Token或删除，必须先断开。
6. Go Agent 同时只允许一个 iperf、trace 或更新任务。
7. 普通用户 NextTrace 在服务端和 Agent DNS 解析后两层拒绝私有/保留地址，防 DNS 重绑定。
8. Telegram 按钮和私聊续接必须绑定发起者 Telegram ID并重新鉴权。
9. 私有群全部 iperf Bot 回复隐藏真实目标为 `x.x.x.x`，实际任务和审计保留真实值。
10. Agent 删除是软删除，历史任务不能被级联清除。

| 权限 | uid=1 | 其他管理员 | 普通用户 |
| --- | --- | --- | --- |
| 使用/查看 Agent | 全部 | 全部 | 已分配 |
| 查看任务 | 全部 | 全部 | 自己 |
| 管理 Agent/用户 | 是 | 是 | 否 |
| 系统设置 | 是 | 否 | 否 |
| Telegram 群数量 | 不限 | 不限 | 1 个 |
| 开启公共群模式 | 是 | 是 | 否 |

## 8. HTTP API

登录、登出和 `/api/me` 匿名查询之外都要求会话。

### 身份与系统

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `PATCH /api/me`
- `GET /api/system/version`
- `GET|PUT /api/settings`：仅 uid=1

### Agent 与任务

- `GET /api/agents`
- `GET|POST /api/tests`
- `POST /api/tests/:id/cancel`
- `GET|POST /api/traces`
- `POST /api/traces/:id/cancel`
- `POST /api/admin/agents`
- `POST /api/admin/agents/:id/install`：离线时轮换 Token并生成安装命令
- `GET /api/admin/agents/:id/update-command`
- `POST /api/admin/agents/:id/update`
- `DELETE /api/admin/agents/:id`：离线时软删除

### 用户与 Telegram

- `GET|POST /api/users`
- `GET|PATCH|DELETE /api/users/:id`
- `GET /api/telegram`
- `POST /api/telegram/bind-code`
- `DELETE /api/telegram/bind`
- `POST /api/telegram/groups/mode`
- `DELETE /api/telegram/groups`
- `/api/admin/telegram/groups*`：管理员全局操作

字段与状态码以 `src/server.js` 和测试为准。改 API 时同步前端、Telegram、README、本文和测试。

## 9. WebSocket 协议

### Agent `/ws/agent`

连接后 10 秒内第一条必须是：

```json
{
  "type": "agent.auth",
  "token": "plaintext-token",
  "payload": {
    "agentId": "agent_xxx",
    "name": "广州节点",
    "os": "linux",
    "arch": "amd64",
    "version": "v0.1.22",
    "capabilities": ["iperf3", "nexttrace"],
    "nexttraceVersion": "v1.7.1"
  }
}
```

服务端按 Token 摘要查 Agent，不信任客户端 Agent ID。一个 Agent 只允许一条连接；`4003` 表示鉴权失败，`4004` 表示重复连接。

服务端发出：`agent.auth.ok`、`task.start`、`trace.start`、`task.cancel`、`agent.update.start`。

Agent 发出：`agent.info`、`agent.heartbeat`、`task.stdout/stderr/metric/done/error`、`trace.stdout/stderr/done/error`、`agent.update.started/output/done`。

### 浏览器 `/ws/ui`

- 使用 `netpilot_session` Cookie 鉴权。
- 普通用户只收自己的任务，管理员收全部；Agent 更新只发给管理员。
- 主要事件为 `task.*`、`trace.*`、`trace.hop` 和 `agent.update`。
- WS 传实时增量，REST 用于完整历史和断线恢复。

## 10. iperf 实时链路

1. Web/Telegram 调 `createTest`，验证权限/状态，写 `tests`，Agent 标为 busy。
2. 服务端发 `task.start`。
3. Agent 以固定参数数组运行 `iperf3 -c ... -i 1 --forceflush`，不拼 Shell。
4. Agent 扫描 stdout/stderr，每行立即发 `task.stdout/stderr`；匹配速率时发 `task.metric`。
5. 服务端先落 `test_output/test_metrics`，再广播 `/ws/ui`。
6. 前端追加原始行并重绘 SVG；Bot 每 2 秒刷新，结束后上传图表文件。

若仍成批刷新，逐层检查 iperf force flush、Agent 逐行发送、代理 WS 缓冲、`/ws/ui` 在线和前端是否用 REST 覆盖活动输出。`-i 1` 本身不是历史卡顿原因。

## 11. NextTrace 链路

- 参数包括地址族、ICMP/TCP/UDP、端口、每跳次数、最大跳数、超时、并发、包大小、rDNS、MPLS 和受控 MapTrace。
- Agent 先解析目标并再次执行地址族/私网限制，再把确定 IP 交给 NextTrace。
- 固定 `--no-color --language cn`，输出按行流式返回。
- 服务端保存原始输出，并从两行式 hop 中提取 TTL、地址、ASN、详情、主机名和 RTT。
- Web 表格以地址/ASN为主行，地区/运营商为小字。
- Bot `/nexttrace` 不生成图；长输出作为文本文件。

升级 NextTrace 必须同步版本、二进制校验和、许可证校验和、参数语义、通知文档和真实输出测试夹具。

## 12. Telegram Bot

### 启动、绑定和群组

- uid=1 保存 Token 时用 `getMe` 验证；Node 启动后 long polling `getUpdates(timeout=35)`。
- `telegram_update_offset` 持久化，单 Token 不得同时运行第二个 poller。
- 启动注册 `/help`、`/status`、`/bind`、`/agents`、`/iperf`、`/nexttrace`。
- Web 生成 6 位、10 分钟绑定码；用户和 Telegram ID 均一对一。
- `members_only` 使用调用者自己的权限；`all_members` 允许全群，未绑定者继承群主权限。
- 普通用户最多登记一个群；只有管理员能设公共模式。

### 命令

- `/iperf IP [端口] [线程] [时长] [-R]`：默认 5201、1、10 秒；无 `-R` 为上行。
- `/iperf`：选 Agent、上/下行，再去私聊输入 `IP:端口`。
- 多 Agent 严格串行，避免标准 iperf3 服务端一次只能接一个客户端。
- `/nexttrace [安全参数] 目标`：选择一个支持 NextTrace 的 Agent。
- 回调 data 包含发起者 Telegram ID；每次回调都要重新检查。
- Bot 任务消息回复最初召唤命令，最终图作为文件发送。图表 SVG 含坐标轴、数据点数值和图例，栅格化时必须经 `chartResvgOptions` 加载内置字体，否则容器内文字全部丢失。

### 私有群脱敏和群聊过滤

- 私有群所有人的 iperf Bot 输出都隐藏目标，覆盖选择、进度、结果、错误、原始输出和图标题。
- 用户自己发送的 Telegram 命令原文无法由 Bot 修改；完全隐藏应先发 `/iperf`，目标在私聊输入。
- 群组只处理本 Bot 的已注册命令；普通文字、回复 Bot 的闲聊、未知命令和发给其他 Bot 的命令全部忽略。
- 命令过滤必须早于群组授权提示，否则普通群聊会反复触发“未授权”；这是 v0.1.22 修复的历史故障。

## 13. Agent 安装与更新

### 安装

- 创建 Agent 时生成 ID 和 32 字节 Token，只展示一次。
- 一键脚本识别 amd64/arm64，安装 iperf3、固定 NextTrace、许可证和 Agent。
- NextTrace 二进制与许可证都校验 SHA-256。
- 原生服务支持 systemd/OpenRC；systemd 只保留 `CAP_NET_RAW` 并加固文件系统访问。

### 手动更新

`public/update-agent.sh` 支持 systemd/OpenRC 和标准 `netpilot-agent` Docker 容器：

- Release `SHA256SUMS` 校验。
- 原生二进制原子替换，健康失败回滚。
- Docker 保留 `NETPILOT_*` 环境和重启策略，失败恢复旧容器。
- 同步固定 NextTrace。

自定义 Docker 网络、挂载和额外参数不会复制，更新前要人工记录并重建。

### 网页自动更新

- 只下发给 `v0.1.19+`、在线且空闲 Agent。
- Agent 下载脚本上限 2 MiB。
- 原生 systemd 优先用 `systemd-run` 临时单元，使更新器跨越主服务重启。
- 服务端接收 `agent.update.*`；更新导致重启时，以新版本重连作为成功信号。
- 服务端 180 秒超时，Agent 更新上下文最长 5 分钟。
- Docker Agent 通常不能控制宿主 Docker，应走手动更新。

## 14. 前端维护要点

- `public/app.js` 全局 state 保存用户、Agent、用户列表、测试、路由、Telegram、设置和 WS。
- 刷新通过 `/api/me` 恢复 Cookie 会话，不应重新登录。
- 对话框取消按钮必须避免提交并调用原生 `close()`。
- 图表必须保留 X/Y 轴、刻度、单位、点和数值标签。
- WS 增量不能清空当前输出；REST 刷新用 `preserveActiveOutput` 避免重绘抖动。
- 用户/Agent/群组多选使用连续容器，并支持全选、反选、清空。
- UID 始终只读，不得重新加入编辑输入框。

## 15. 开发与测试

```bash
npm ci
npm test
npm run check
```

Windows PowerShell 阻止 `npm.ps1` 时用 `npm.cmd test`。Agent 变更在 `agent/` 执行：

```bash
go test ./...
go build ./...
```

Shell 变更执行：

```bash
sh -n public/install-agent.sh public/update-agent.sh scripts/update.sh
```

测试覆盖安装域名、实时 WS、密码/角色/uid=1、Agent 锁和软删除、静态结构、Telegram 回调鉴权、串行测试、图片、脱敏、交互、回复关系、群组过滤、命令注册和更新器回滚。高风险修复要加入能精确复现历史故障的测试。

## 16. 发布流程

### 版本位置

发布时同步：

- `package.json`。
- `package-lock.json` 顶层和根包版本。
- `public/index.html` 的 CSS/JS `?v=`。
- 写死当前版本的测试断言。
- 行为/运维变化对应的 README 和本文。

Agent 编译版本来自 Git tag 的 `GITHUB_REF_NAME`，正式发布使用 `vX.Y.Z`。

### 标准步骤

1. 确认工作树只含本次改动。
2. 更新版本和文档。
3. 跑 Node、Shell、可用时的 Go 检查。
4. 提交并推送 `main`。
5. 创建并推送注释标签 `vX.Y.Z`。
6. 等标签工作流全部成功。
7. 核验 Release 的 amd64、arm64、`SHA256SUMS`。
8. 核验 GHCR Alpine amd64 镜像。
9. 最后部署生产并冒烟测试。

`.github/workflows/build.yml` 包含 `server`、两个 `agent`、`release`、`agent-image`。正式构建全部依赖 GitHub Actions，不用本地产物替换 Release。

## 17. 生产环境

### 当前非秘密信息

| 项目 | 当前值 |
| --- | --- |
| 主机/SSH | `root@103.240.198.97:22` |
| SSH ED25519 指纹 | `SHA256:7zyvWen/Euu7vMoO2p30swnp5ZgKRQdf9LQ1LJl+BuU` |
| OS | Debian 13 trixie x86_64 |
| 目录 | `/opt/netpilot` |
| Compose 服务/容器 | `server` / `netpilot-server-1` |
| 映射 | `0.0.0.0:8080 -> 8080/tcp` |
| 数据卷 | `netpilot_netpilot-data` |
| 卷目录 | `/var/lib/docker/volumes/netpilot_netpilot-data/_data` |
| 站点 | `https://iperf.nbiepl.cloud` |
| 当前 CNAME | `637ba431.cdn.drc-mod.top` |

本机透明代理可能把 DNS A 记录映射到 `198.18.0.0/15`，不要当成真实源站；用权威 DNS 和外部解析器交叉核对。

### 秘密交接

公开仓库严禁记录 SSH 密码/私钥、Web 密码、Bot Token、Agent Token、Cookie、`.env` 秘密或数据库副本。通过密码管理器或加密渠道单独交接。当前 SSH 用户是 root；曾通过聊天传输的凭据应尽快轮换，并改用 SSH Key、关闭密码登录。

### 更新服务端

标签 CI 和产物成功后：

```bash
cd /opt/netpilot
git status --short
git rev-parse --short HEAD
docker compose ps
sh scripts/update.sh
```

脚本执行 `git reset --hard origin/main`，会覆盖服务器未提交源码；先保存必要改动。

更新后：

```bash
grep -m1 '"version"' package.json
docker compose ps
docker compose logs --since=5m --timestamps --no-color
curl -fsS https://iperf.nbiepl.cloud/ | grep 'app.js?v='
```

日志应出现 Web listener 和 Telegram Bot enabled。再验证登录、刷新会话、`/ws/ui`、Agent 在线和授权测试目标。仅服务端变化时 Agent 无需更新。

## 18. 备份与恢复

SQLite 是全部业务状态。WAL 模式下不要在繁忙时只复制主文件而忽略 `-wal/-shm`。

简单一致备份可在维护窗口：

```bash
docker volume inspect netpilot_netpilot-data
cd /opt/netpilot
docker compose stop server
# 将已确认的数据卷目录整体复制到加密备份位置
docker compose start server
```

恢复前保留当前数据库用于取证，停止服务，验证目标确实是 NetPilot 卷，恢复完整数据集与权限，再检查 uid=1、Agent、设置和历史。数据库含密码哈希、Token 摘要、Bot Token、测试目标和审计，始终按秘密处理。

当前没有内置定时备份、恢复演练、保留或清理策略。

## 19. 常见故障

### 站点正常但日志频繁 401

`requireUser` 的预期 401 当前也会打印堆栈。检查旧页面、监控或爬虫是否持续请求受保护 API；这通常不是 Bot 故障，但需要后续把预期 4xx 与 5xx 分开记录。

### 刷新后退出登录

检查 `PUBLIC_BASE_URL`、Secure Cookie、Host/`X-Forwarded-Proto`、代理 Cookie、`/api/me`、系统时间和 session 过期时间。

### Agent 无法连接

从 Agent 主机测试 DNS/TLS/WSS，核对 `/etc/netpilot-agent/env`，查看 `journalctl -u netpilot-agent`。`4003` 是 Token，`4004` 是重复连接。安装域名错误检查 uid=1 设置和代理头。

### Agent 自动更新失败

低于 v0.1.19 先手动更新；busy 要等任务结束。检查脚本/加速地址、SHA256、临时 systemd 单元、服务日志、Release latest 和更新后重连版本。

### Telegram 没反应/重复回复

检查 Bot enabled、polling 错误、是否单 poller、offset 是否推进。普通群聊必须无回复；检查命令过滤是否仍早于授权。服务重启会丢失 activeTests/activeTraces，旧按钮会失效。

### 删除 Agent 返回 500

在线应返回 409。Agent 是软删除；检查 SQLite 锁、外键和手工硬删，不要级联删除历史任务。

### NextTrace 展示异常

检查版本、`--no-color --language cn` 和真实两行输出格式。第三方升级时用真实输出加测试。ASN/地址主行，地区/运营商详情小字。

## 20. 已知限制与技术债

1. 无登录频率限制、MFA 或账户锁定。
2. 尚无完整 CSRF Origin/Token 防护。
3. iperf 普通用户没有与 NextTrace 同等级的目标 CIDR/DNS 重绑定限制。
4. 单 Node、SQLite、内存任务状态不能直接横向扩容。
5. Telegram 交互状态在内存，重启后旧按钮/续接失效。
6. 无自动备份、恢复演练、数据保留和输出清理。
7. 输出与指标表会持续增长。
8. 预期 401 打完整堆栈，日志噪声大。
9. Agent `ip_location` 字段已存在，但完整自动 GeoIP 填充尚未落地。
10. 前端无构建和类型系统，DOM/API 变更易运行时报错。
11. GeoIP/MapTrace 有第三方服务条款，默认应关闭。
12. Docker Agent 只有 amd64，arm64 使用原生安装。
13. 服务端更新器会硬重置工作树。

建议优先补：加密自动备份和恢复验证、登录限流、iperf 目标策略、4xx 日志降噪、数据保留、反向代理模板/WSS E2E、Telegram 重启恢复、本地 GeoIP。

## 21. 高风险修改清单

### 用户/权限

- 保持 uid=1 不变量。
- 同时检查 API、前端、Telegram 和 DB。
- 普通用户查询与测试按用户/Agent 权限过滤。
- 增加越权和 UID 篡改测试。

### 实时输出

- 分别验证 Agent 发出、服务端落库/广播、UI WS、前端渲染。
- 不用高频 REST 覆盖活动输出。
- 统一 Mbps 和秒。

### Telegram

- 每个按钮校验发起者 ID。
- 群组先过滤命令，再授权提示。
- 新增任何 iperf 输出面时同步私有群脱敏。
- 多 Agent 继续串行。
- offset 只能前进并持久化。

### Agent/更新器

- 不把用户输入拼进 Shell。
- 保持互斥、超时、进程组取消。
- 下载必须校验，失败必须回滚。
- systemd 更新跨主服务重启。
- 协议不兼容时提高最低版本并提供手动迁移路径。

### 数据库

- 同测新建数据库和旧库迁移。
- 软删除保留历史。
- 事务中不做异步工作。
- 评估 WAL、锁与索引。

## 22. 交接验收

- [ ] 接手者能访问仓库、Actions 和 Packages。
- [ ] 通过安全渠道取得并轮换生产 SSH/Web/Bot 凭据。
- [ ] 完成一次 SQLite 备份和恢复演练。
- [ ] 本地 Node 检查通过。
- [ ] 能说明 `/ws/agent` 与 `/ws/ui` 的鉴权差异。
- [ ] 能执行短 iperf/NextTrace并看到流式输出。
- [ ] 能解释 Telegram 私有/公共模式和私有群脱敏。
- [ ] 能从 Actions 发布测试版本并核验双架构产物。
- [ ] 能安全更新生产并核对版本。

## 23. 随仓库技能

`.codex/skills/` 包含三个经过 `skill-creator` 校验的项目技能：

- `$netpilot-development`：日常功能开发、权限/实时链路/Telegram/Agent 修改与测试。
- `$netpilot-release`：版本号同步、GitHub Actions、Release 产物和镜像核验。
- `$netpilot-production-ops`：生产只读诊断、Compose 更新、备份恢复和事故排查。

这些 skill 故意把详细事实集中引用到本文，避免各技能复制一份架构说明后产生漂移。若使用的 Codex 客户端不自动发现仓库级 skill，可将对应目录安装到个人 `CODEX_HOME/skills`；不要在安装过程中加入任何生产秘密。

## 24. 维护本文

架构、依赖、API、WS、schema、权限、默认值、最低 Agent 版本、Telegram 脱敏、安装/更新/发布/备份、生产主机/域名/卷/指纹或重大事故变化时必须更新本文。生产事实可写，秘密只记录其安全托管位置和轮换负责人，绝不写明文。

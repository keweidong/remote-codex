# Codex Remote Web

Codex Remote Web 是一个运行在本机的非官方手机伴侣。它读取电脑上 Codex Desktop 的项目、会话和历史记录，让你在手机上查看进度、发送消息、继续任务，或在已有本地项目中创建新会话。

会话仍由这台电脑上的 Codex 处理。这个项目不提供云端 Codex 账号、不保存聊天到作者的服务器，也不修改 Codex 的配置、数据库或锁文件。

## 功能

- 查看本机项目、已有会话、消息历史和记录状态。
- 在已有本地项目中创建持久会话，并发送首条消息。
- 向已有会话发送消息或继续任务，提交结果会明确显示为“已提交”或“已开始”。
- 从本机 Codex 的模型目录读取可用模型和推理强度，在发送或创建会话时选择。
- 通过局域网二维码配对手机，也可以使用 Cloudflare 临时隧道或固定域名隧道。
- 公网固定地址（中继）：临时隧道自动注册到中继 Worker，手机扫一次码即可跨服务重启使用，被分享者不需要申请域名。
- 在电脑管理页查看已配对设备、生成新的二维码、撤销设备和关闭隧道。

## 运行结构

服务启动两个 HTTP 监听器：

| 入口 | 默认地址 | 用途 |
| --- | --- | --- |
| 电脑管理页 | `http://127.0.0.1:8765` | 仅本机登录、配对、设备和隧道管理 |
| 手机入口 | `http://0.0.0.0:8766` | 局域网或隧道访问的手机页面与 API |

管理页不会出现在手机监听器上。Cloudflare 隧道只转发手机端口，不转发管理页。

已有会话的消息通过官方 `codex queue` 提交，并使用 `shell: false` 启动命令；新会话通过官方 `codex app-server --stdio` 调用 `thread/start` 和 `turn/start`。Codex 的 SQLite 状态和历史文件以只读方式打开，服务不会直接写入 Codex 数据库、历史或锁文件。

## 环境要求

- Windows，PowerShell 和 Node.js **24 或更高版本**。
- 已安装并登录 Codex Desktop，且本机可以找到 `codex.exe`。
- 手机与电脑在同一网络时，需要允许受信任网络访问 TCP `8766`。
- 使用外网访问时需要 `cloudflared`：依赖的 npm 包会在安装时自动下载对应平台的二进制（约 55 MB，仅一次）；用 `--ignore-scripts` 安装时由服务在首次启动时后台补下载。也可以用 `CLOUDFLARED_PATH` 指定自己的副本。

服务与 Codex Desktop 必须使用同一个 `CODEX_HOME`。默认值为 `%USERPROFILE%\.codex`。

## 快速开始

```powershell
# 安装依赖
npm.cmd install --ignore-scripts

# 启动服务并打开电脑管理页
.\Start-Codex-Remote.cmd
```

启动脚本会检查 Node.js 版本，查找 Codex CLI，按需安装依赖，并将运行日志写入 `%LOCALAPPDATA%\CodexRemoteWeb`。管理页打开后：

1. 在“选择手机能访问的地址”中选择电脑的局域网地址。
2. 点击“生成配对二维码”，用手机浏览器扫描并填写设备名称。
3. 配对完成后选择项目和会话，即可查看历史、发送消息或继续任务。

二维码 5 分钟内有效且只能使用一次。`127.0.0.1` 仅供电脑本机预览，不能填入手机二维码。

停止服务（包括由本服务启动的隧道）：

```powershell
.\Stop-Codex-Remote.cmd
```

也可以直接运行 `npm.cmd start` 启动 Node 服务；这种方式不会自动打开带管理凭据的浏览器链接，日常使用建议使用启动脚本。

## 外网访问

### 临时地址

在电脑管理页点击“开启外网访问”。服务会启动 Cloudflare Quick Tunnel，并显示一个 `https://…trycloudflare.com` 地址；选择该地址重新生成二维码。临时地址在服务重启后会变化，需要重新配对。

### 公网固定地址（中继，默认开启）

临时隧道运行后，服务会自动把当前隧道地址注册到项目中继（部署在你自己 Cloudflare 账户上的 Worker，部署与原理见 `relay/README.md`），并把二维码建在固定源 `https://<id>.codexremote.dpdns.org` 上：

- 手机用固定地址配对一次后，服务重启、隧道更换都不需要重新扫码；实例离线时手机看到友好的离线页而不是死链。
- 每台实例的 id 与注册密钥首次运行自动铸造，保存在数据目录 `relay-identity.json`；密钥只以 SHA-256 哈希存在中继侧。
- 中继不可达时自动回退为裸临时地址（上一节行为），不影响局域网和隧道功能。
- 中继只改变访问源，不终结配对；但经过 Worker 的流量对中继运营者的 Cloudflare 账户可见（与 Cloudflare 之于 trycloudflare 的可见性相同），分享给他人前请如实说明。
- 用 `CODEX_REMOTE_RELAY=0` 或数据目录 `relay.json` 写入 `{"enabled":false}` 关闭；`CODEX_REMOTE_RELAY_BASE`、`CODEX_REMOTE_RELAY_DOMAIN` 可指向其他中继部署。

### 固定域名

先在 Cloudflare Tunnel 的 Public Hostname 中把域名指向 `http://127.0.0.1:8766`，再在 `%LOCALAPPDATA%\CodexRemoteWeb\tunnel.json` 写入：

```json
{
  "hostname": "remote.example.com",
  "token": "<Cloudflare Tunnel Token>",
  "autostart": true
}
```

也可以使用环境变量 `CODEX_REMOTE_TUNNEL_HOSTNAME`、`CODEX_REMOTE_TUNNEL_TOKEN`、`CODEX_REMOTE_TUNNEL_MODE` 和 `CODEX_REMOTE_TUNNEL_AUTOSTART` 配置。Token 是隧道凭据，请勿提交到 Git 或发给他人。固定域名隧道自动重连，手机授权可以跨服务重启保留；首次从临时地址切换到固定域名时，需在新地址重新配对一次。

## 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEX_HOME` | `%USERPROFILE%\.codex` | Codex 数据目录 |
| `CODEX_CLI_PATH` | 自动查找 | `codex.exe` 的完整路径 |
| `CLOUDFLARED_PATH` | npm 包自动下载 | `cloudflared.exe` 的完整路径 |
| `CODEX_REMOTE_DATA` | `%LOCALAPPDATA%\CodexRemoteWeb` | 本服务的运行数据和日志目录 |
| `CODEX_REMOTE_ADMIN_PORT` | `8765` | 本机管理端口 |
| `CODEX_REMOTE_PHONE_PORT` | `8766` | 手机入口端口 |
| `CODEX_REMOTE_HOST` | `0.0.0.0` | 手机入口监听地址；填 `127.0.0.1` 可只供隧道访问 |
| `CODEX_REMOTE_TUNNEL_HOSTNAME` | 无 | 固定隧道域名 |
| `CODEX_REMOTE_TUNNEL_TOKEN` | 无 | 固定隧道 Token |
| `CODEX_REMOTE_TUNNEL_MODE` | 自动选择 | 填 `quick` 强制使用临时隧道 |
| `CODEX_REMOTE_TUNNEL_AUTOSTART` | 配置文件值 | 固定隧道是否随服务启动 |
| `CODEX_REMOTE_RELAY` | 开启 | 填 `0` 关闭公网固定地址中继 |
| `CODEX_REMOTE_RELAY_BASE` | `https://registry.codexremote.dpdns.org` | 中继注册表地址 |
| `CODEX_REMOTE_RELAY_DOMAIN` | 从注册表地址推导 | 实例固定子域的基础域 |

## 本地数据和安全边界

默认运行目录为 `%LOCALAPPDATA%\CodexRemoteWeb`，包含：

- `admin-key`：电脑管理页的本机启动凭据。
- `devices.json`：设备授权记录，只保存设备 Token 的哈希值。
- `outbox.json`、`new-threads.json`：提交和新会话请求的防重复记录。
- `relay.json`（可选）、`relay-identity.json`：中继配置，以及本实例的固定子域 id 与注册密钥。
- `tunnel.json`、`runtime.json`、`stdout.log`、`stderr.log`：隧道配置、运行状态和日志。

管理凭据只接受本机地址。配对码为一次性随机值，有效期 5 分钟；设备会话有效期 30 天，最多保留 10 台设备，撤销后立即失效。修改请求要求同源 `Origin` 和 JSON 内容类型，管理端口不会通过隧道公开。

请保护 `admin-key` 和 `tunnel.json`。固定隧道 Token 是 bearer credential，泄露后应立即在 Cloudflare 中轮换。`relay-identity.json` 的密钥能把你的固定子域指向别人的隧道；怀疑泄露时删除该文件并重启，实例会铸造新 id（手机需重扫一次）。

## 当前限制

- 手机端不处理命令审批，不支持强制中断、删除聊天、任意终端执行或文件附件。
- 历史页只展示用户文字、助手回复、简短活动状态和记录状态；不展示原始推理、工具参数、工具输出或完整 diff。
- 状态来自 Codex 已保存的记录，可能有延迟或在异常退出后暂时保留“执行中”。“已提交”表示已进入桌面队列，不代表任务已经完成。
- 若桌面正在占用某个会话，手机不能跨进程强制切换该会话的模型；可以在桌面切换，或在手机创建新会话。模型目录暂不可用时仍可沿用会话或默认设置发送。
- 新会话首轮由本服务启动的 App Server 子进程执行；停止本服务会停止仍在执行的首轮任务。新建确认只表示会话和首条消息已被确认，不表示任务完成。
- 当前实现依赖本机 Codex CLI `0.162.0-alpha.17.2` 附近的数据结构和 App Server 接口；升级 Codex 后可能需要适配。公网访问和真实手机扫码需要在目标设备上自行验证。

## 开发与验证

安装依赖后运行测试：

```powershell
npm.cmd install --ignore-scripts
npm.cmd test
```

测试使用临时 SQLite 数据和受控 CLI fixture，覆盖配对过期与撤销、设备凭据哈希、未授权拒绝、管理入口隔离、同源校验、历史读取与分页、shell 安全的消息提交、幂等重试、新会话创建、模型目录和 App Server 生命周期。测试不会向你的真实 Codex 会话插入消息。

## 目录

```text
src/        Node.js 服务、只读 Codex store、队列、配对、隧道和中继客户端
public/     管理页和手机端静态页面
relay/      公网固定地址中继 Worker、wrangler 配置与部署指南
test/       Node.js 内置测试与受控 fixtures
docs/       设计说明和实现计划
start.ps1   启动服务、检查依赖并打开管理页
stop.ps1    通过本机管理接口停止服务
```

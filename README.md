# Codex Remote Web

Codex Remote Web 是一个运行在本机的非官方手机伴侣。它读取电脑上 Codex Desktop 的项目、会话和历史记录，让你在手机上查看进度、发送消息、继续任务、控制进行中的回合，或在已有本地项目中创建新会话。

会话仍由这台电脑上的 Codex 处理。这个项目不提供云端 Codex 账号、不保存聊天到作者的服务器，也不修改 Codex 的配置、数据库或锁文件。

## 功能

- 查看本机项目、已有会话、消息历史和记录状态。
- 在已有本地项目中创建持久会话，并发送首条消息；发送时可选择模型与推理强度。
- 向已有会话发送消息或继续任务；对进行中的回合可中断、引导（steer）和恢复排队任务。
- 通过局域网二维码配对手机；外网访问支持 Cloudflare 临时隧道、**中继固定地址**（推荐）或自带固定域名隧道。
- 在电脑管理页查看已配对设备、生成新的二维码、逐设备撤销和关闭隧道。

## 它是如何连上的（三分钟版）

- 服务启动两个 HTTP 监听器：`http://127.0.0.1:8765` 是**电脑管理页**（仅本机可访问）；`http://0.0.0.0:8766` 是**手机入口**（局域网或隧道访问）。管理页不会出现在手机监听器上，隧道也只转发手机端口。
- 家庭网络里的电脑通常没有公网地址，外面无法直接连进来。本项目用**反向隧道**解决：电脑上的 `cloudflared` 主动向外拨出一条到 Cloudflare 边缘的长连接并保持不断，手机的请求到达 Cloudflare 后被塞进这条连接送回电脑。电脑不需要公网 IP，也不需要开任何入站端口。
- 临时隧道（Quick Tunnel）的地址每次重启都会变。为了让手机书签和配对跨重启有效，项目内置**中继**：一个部署在作者 Cloudflare 账户上的 Worker 维护一本登记簿（实例 id → 当前隧道地址），手机永远访问固定名字 `https://<实例id>.codexremote.dpdns.org`，背后当前是哪条临时线路由登记簿决定。详见 `relay/README.md`。
- 已有会话的消息通过官方 `codex queue` 提交（`shell: false`）；新会话通过官方 `codex app-server --stdio` 调用 `thread/start` 与 `turn/start`。Codex 的 SQLite 状态和历史文件以只读方式打开，服务不会直接写入 Codex 数据库、历史或锁文件。

## 环境要求

使用者（你自己或被分享的朋友）要求相同：

- Windows，PowerShell 和 Node.js **24 或更高版本**。
- 已安装并登录 Codex Desktop，且本机可以找到 `codex.exe`（启动脚本会自动在 PATH、`%LOCALAPPDATA%\OpenAI\Codex\bin`、`~/.codex\plugins` 中查找）。
- 手机与电脑同一网络配对时，需要允许受信任网络访问 TCP `8766`（Windows 防火墙首次可能询问）。
- 使用外网访问时需要 `cloudflared`：**无需手动安装**——npm 依赖会在安装时自动下载对应平台二进制（约 55 MB，仅一次）；用 `--ignore-scripts` 安装时由服务在首次启动后台补下载。也可以用 `CLOUDFLARED_PATH` 指定自己的副本。
- 服务与 Codex Desktop 必须使用同一个 `CODEX_HOME`，默认 `%USERPROFILE%\.codex`。

**不需要**：域名、Cloudflare 账号、wrangler、任何手写配置文件。

## 快速开始（自用）

```powershell
# 安装依赖
npm.cmd install --ignore-scripts

# 启动服务并打开电脑管理页
.\Start-Codex-Remote.cmd
```

启动脚本会检查 Node.js 版本、查找 Codex CLI、按需安装依赖，并将运行日志写入 `%LOCALAPPDATA%\CodexRemoteWeb`。管理页打开后：

1. 在“选择手机能访问的地址”中选择电脑的局域网地址（外网场景见下节）。
2. 点击“生成配对二维码”，用手机浏览器扫描并填写设备名称。
3. 配对完成后选择项目和会话，即可查看历史、发送消息、继续任务或控制进行中的回合。

二维码 5 分钟内有效且只能使用一次。`127.0.0.1` 仅供电脑本机预览，不能填入手机二维码。

停止服务（包括由本服务启动的隧道）：

```powershell
.\Stop-Codex-Remote.cmd
```

也可以直接运行 `npm.cmd start` 启动 Node 服务；这种方式不会自动打开带管理凭据的浏览器链接，日常使用建议使用启动脚本。

## 使用说明

### 场景一：手机与电脑同一 Wi-Fi（局域网）

管理页地址下拉里选 `http://<电脑局域网IP>:8766` → 生成二维码 → 手机扫码配对。若手机连不上，检查 Windows 防火墙是否放行了 node.exe 的 TCP 8766 入站。

### 场景二：手机在别的网络（外网，临时地址）

管理页点击“开启外网访问”。服务启动 Cloudflare Quick Tunnel 并显示一个 `https://…trycloudflare.com` 地址；选择该地址重新生成二维码即可。注意：临时地址在服务重启后会变化，需要重新配对——想要不变请用场景三。

### 场景三：外网 + 固定地址（中继，推荐分享时使用）

开启外网访问后，服务会自动把当前临时隧道地址注册到项目中继，地址下拉会**自动选中**形如 `https://<16位id>.codexremote.dpdns.org` 的“公网固定地址”：

- 用这个地址生成二维码配对一次后，**服务重启、隧道换址都不需要重新扫码**；手机书签长期有效。
- 实例离线（电脑关机、服务停止、隧道重连中）时，手机打开固定地址会看到友好的“实例离线”页，而不是死链；恢复运行后刷新即回。
- 每台电脑有自己的 id 子域，互不干扰；id 与注册密钥首次运行自动铸造，保存在 `%LOCALAPPDATA%\CodexRemoteWeb\relay-identity.json`。
- 中继不可达时自动回退为场景二的裸临时地址，不影响任何现有功能。
- 关闭中继：环境变量 `CODEX_REMOTE_RELAY=0`，或在数据目录写 `relay.json`：`{"enabled": false}`。
- 信任说明：中继只改变访问源、不终结配对；但经过中继 Worker 的流量对中继运营者的 Cloudflare 账户可见（与 Cloudflare 之于临时隧道的可见性相同）。分享给他人前请如实告知。

### 场景四：自带固定域名（命名隧道）

如果你有自己的域名并托管在 Cloudflare：先在 Cloudflare Tunnel 的 Public Hostname 中把域名指向 `http://127.0.0.1:8766`，再在 `%LOCALAPPDATA%\CodexRemoteWeb\tunnel.json` 写入：

```json
{
  "hostname": "remote.example.com",
  "token": "<Cloudflare Tunnel Token>",
  "autostart": true
}
```

也可以使用环境变量 `CODEX_REMOTE_TUNNEL_HOSTNAME`、`CODEX_REMOTE_TUNNEL_TOKEN`、`CODEX_REMOTE_TUNNEL_MODE` 和 `CODEX_REMOTE_TUNNEL_AUTOSTART` 配置。Token 是隧道凭据，请勿提交到 Git 或发给他人。固定域名隧道自动重连；首次从其他地址切换到固定域名时，需在新地址重新配对一次。此模式不依赖中继。

### 设备管理与安全操作

- 管理页“已配对设备”列出所有设备（按 User-Agent 推断的名称、最近访问时间、配对地址），可逐设备“撤销”。
- 点击“关闭隧道”或停止服务不会撤销设备；想全部撤销请删除数据目录下的 `devices.json` 后重启，或逐设备撤销。
- 设备会话有效期 30 天（每次使用续期），最多保留 10 台。
- 怀疑某台手机丢失：立即在管理页撤销该设备，下一次请求即失效。

### 手机侧能做什么

- 浏览项目与会话列表、分页加载历史消息、查看记录状态（“已提交”表示已进入桌面队列，不代表任务完成）。
- 发送消息、继续任务；在已有项目里创建新会话并发送首条消息；发送前选择模型与推理强度。
- 对进行中的回合：中断、引导（steer）、恢复排队任务（取决于桌面是否共享控制通道；不可用时界面会说明原因）。
- 手机端不处理命令审批，不支持删除聊天、任意终端执行或文件附件。

## 分享给他人（开箱即用指南）

**打包**：压缩项目目录时排除 `node_modules`、`.state`、`artifacts`、`*.log`，以及 `%LOCALAPPDATA%\CodexRemoteWeb` 整个数据目录（含管理凭据、设备库、隧道 Token——绝不外发）。`.git` 视需要保留。

**接收方流程**：

1. 安装 Node.js 24+ 与已登录的 Codex Desktop（仅有的两项手动准备）。
2. 解压后双击 `Start-Codex-Remote.cmd`：自动安装依赖、启动服务、打开管理页。
3. 管理页点“开启外网访问”；首次启动约 1 分钟内 cloudflared 在后台自动下载，下载完成前点击会提示“请稍后重试”，再点一次即可。
4. 地址下拉自动选中接收方自己的中继固定地址 → 生成二维码 → 手机扫码填设备名 → 完成。
5. 之后接收方重启服务、更换隧道地址，手机书签与配对均不失效。

接收方**不需要**：域名、Cloudflare 账号、wrangler、tunnel.json、任何环境变量。

## 中继部署（作者一次性操作）

中继 Worker 部署在你自己的 Cloudflare 账户上，为所有接收方提供固定子域。完整步骤、验证命令、费用与安全说明见 [`relay/README.md`](relay/README.md)。摘要：

```powershell
cd relay
npx wrangler login                      # 浏览器点一次 Allow
npx wrangler kv namespace create RELAY_KV   # 把输出的 id 填进 wrangler.toml
npx wrangler deploy                     # 自动创建 *.你的域名 泛路由
```

再到 Cloudflare 控制台为该 zone 添加一条 DNS 记录：类型 `AAAA`、名称 `*`、内容 `100::`、代理状态“已代理”。完成后所有实例的自动注册即刻可用；未部署时项目自动回退为临时地址模式。

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

## 常见问题

- **启动报 `Node.js 24 or newer is required.`**：安装 Node.js 24 或更高版本后重试。
- **提示“未找到 cloudflared……后台自动下载”**：首次启动正在下载二进制（约 55 MB），等一会儿再点“开启外网访问”即可；也可用 `CLOUDFLARED_PATH` 指定已有副本。
- **固定域名访问报 530**：隧道连接器不在线——确认服务在运行、管理页里隧道状态为“已连接/运行中”。
- **固定地址打开是“实例离线”页**：该电脑的服务未运行或隧道重连中；恢复后刷新即可，**无需重新配对**。
- **重启后手机提示配对失效**：你配对时用的是临时地址而非固定地址；用中继固定地址或固定域名重新配对一次即可长期有效。
- **新的临时地址刚出现时打不开**：DNS 传播需要几十秒，稍候刷新；中继注册自带退避重试，不受影响。
- **升级 Codex 后异常**：当前实现依赖 Codex CLI `0.162.0-alpha.17.2` 附近的数据结构与 App Server 接口，升级后可能需要适配。

## 当前限制

- 手机端不处理命令审批，不支持删除聊天、任意终端执行或文件附件。
- 历史页只展示用户文字、助手回复、简短活动状态和记录状态；不展示原始推理、工具参数、工具输出或完整 diff。
- 状态来自 Codex 已保存的记录，可能有延迟或在异常退出后暂时保留“执行中”。
- 若桌面正在占用某个会话，手机不能跨进程强制切换该会话的模型；可以在桌面切换，或在手机创建新会话。模型目录暂不可用时仍可沿用会话或默认设置发送。
- 新会话首轮由本服务启动的 App Server 子进程执行；停止本服务会停止仍在执行的首轮任务。
- 中继流量经过运营者 Worker，技术上可见明文；配对与设备授权仍由本服务校验，Cloudflare 与中继不参与放行判断。
- 公网访问和真实手机扫码需要在目标设备上自行验证。

## 开发与验证

安装依赖后运行测试：

```powershell
npm.cmd install --ignore-scripts
npm.cmd test
```

测试使用临时 SQLite 数据和受控 CLI fixture，覆盖配对过期与撤销、设备凭据哈希、未授权拒绝、管理入口隔离、同源校验（含中继来源）、历史读取与分页、shell 安全的消息提交、幂等重试、新会话创建、模型目录、回合控制和 App Server 生命周期。测试不会向你的真实 Codex 会话插入消息。

## 目录

```text
src/        Node.js 服务、只读 Codex store、队列、配对、回合控制、隧道和中继客户端
public/     管理页和手机端静态页面
relay/      公网固定地址中继 Worker、wrangler 配置与部署指南
test/       Node.js 内置测试与受控 fixtures
docs/       设计说明和实现计划
start.ps1   启动服务、检查依赖并打开管理页
stop.ps1    通过本机管理接口停止服务
```

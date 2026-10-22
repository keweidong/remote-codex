# 公网固定地址中继（Relay Worker）部署指南

这个目录包含“无域名固定地址”方案的服务端：一个部署在你自己 Cloudflare 账户上的 Worker。
它为每个 CodexRemoteWeb 实例提供一个**永不变化的子域名**（`https://<id>.codexremote.dpdns.org`），
把流量逐字节转发到该实例当前的 Cloudflare 快速隧道地址。部署一次之后：

- 你分享给的任何人都**不需要注册域名、不需要 Cloudflare 账号、不需要任何配置**；
- 他们扫一次码配对，之后即使你的服务重启、隧道地址更换，手机书签和配对照常有效；
- 实例离线时手机看到友好的离线页，而不是死链。

## 工作原理

```text
手机 ── https://<id>.codexremote.dpdns.org/...
        │  (Worker 查 KV：id → 当前 quick 隧道地址)
        ▼
      https://xxxx.trycloudflare.com/...   ← Cloudflare 边缘
        ▼
      实例电脑 127.0.0.1:8766
```

- **注册表**（`registry.codexremote.dpdns.org/_relay/register`）：实例每次快速隧道启动/重启时，
  用自己的 id + secret 把当前隧道地址写入 KV。secret 只以 SHA-256 哈希存储，明文只在实例本机
  （`%LOCALAPPDATA%\CodexRemoteWeb\relay-identity.json`）。目标地址只接受 `*.trycloudflare.com`。
- **转发**：其余所有子域名按 id 查表转发；目标隧道失效（Cloudflare 5xx）或无记录时返回离线页。
- **信任模型**：中继只改变访问源，不终结任何配对——设备 cookie 与应用层校验都在实例上。
  但请注意：**经过 Worker 的流量对你的 Cloudflare 账户 technically 可见**，与 Cloudflare 之于
  裸 trycloudflare 隧道的可见性相同。在项目 README 中向使用者如实说明。

## 部署步骤（一次性，约 10 分钟）

前提：`codexremote.dpdns.org` 已在你的 Cloudflare 账户 Zones 列表中（命名隧道 Public Hostname
能工作就说明已经在了）；本机有 Node.js。

```powershell
cd relay

# 1. 登录 Cloudflare（浏览器授权一次）
npx wrangler login

# 2. 创建 KV 命名空间，把输出里的 id 填进 wrangler.toml
npx wrangler kv namespace create RELAY_KV

# 3. 部署 Worker
npx wrangler deploy
```

4. 泛域名两件套（路由随部署自动创建；DNS 记录需在控制台手动加一次）：
   - **路由**：`wrangler.toml` 里的
     `routes = [{ pattern = "*.codexremote.dpdns.org/*", zone_name = "codexremote.dpdns.org" }]`，
     `npx wrangler deploy` 时自动创建。注意 Cloudflare **自定义域（Custom Domain）不允许通配符**，
     必须用 zone 路由；另外 TOML 的表作用域有坑——`routes` 这类顶级键必须写在任何 `[表头]` 之前，
     否则会被静默解析成该表的变量。
   - **DNS 记录**（控制台，一次性）：zone `codexremote.dpdns.org` → DNS → 记录 → 添加记录：
     类型 `AAAA`、名称 `*`、内容 `100::`、代理状态**已代理**（橙云）。
     这是 Cloudflare 给 Worker 路由用的占位记录，没有它泛子域不会解析。
   泛域名**不覆盖顶级名** `codexremote.dpdns.org` 本身，现有的命名隧道主机名不受影响；
   zone 的 Universal SSL 证书恰好覆盖一级子域，所以实例 id 必须是单标签（16 位十六进制）。

5. 验证：

```powershell
# 注册一条假记录（16 位十六进制 id + 43 位 base64url secret）
$body = '{"id":"0123456789abcdef","target":"https://example-dead.trycloudflare.com","new_secret":"' + [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 })) .TrimEnd('=').Replace('+','-').Replace('/','_') + '"}'
Invoke-RestMethod -Method Post -Uri 'https://registry.codexremote.dpdns.org/_relay/register' -ContentType 'application/json' -Body $body

# 固定源应返回 503 离线页（目标是假地址）
Invoke-WebRequest 'https://0123456789abcdef.codexremote.dpdns.org/' -UseBasicParsing -SkipHttpErrorCheck | Select-Object StatusCode

# 清理测试记录
$unreg = $body -replace 'new_secret','secret' -replace 'target[^,]*,',''
Invoke-RestMethod -Method Post -Uri 'https://registry.codexremote.dpdns.org/_relay/unregister' -ContentType 'application/json' -Body ($body -replace '"target":"[^"]*",','' -replace 'new_secret','secret')
```

更简单的验证：在项目里开一次“外网访问”（临时隧道），管理页中继状态变为“已注册”后，
用手机流量打开显示的固定地址，应看到 CodexRemoteWeb 手机页。

## 与实例侧的对接

实例侧（`src/relay.js`）默认启用，默认注册表地址为 `https://registry.codexremote.dpdns.org`。
如果你换了域名，改两处：

| 位置 | 字段 |
| --- | --- |
| `relay/wrangler.toml` | `RELAY_DOMAIN` |
| `src/relay.js` | `DEFAULT_RELAY_BASE`（`https://registry.<你的域名>`） |

实例侧运行时覆盖（都不需要改代码）：

| 变量 / 文件 | 作用 |
| --- | --- |
| `CODEX_REMOTE_RELAY=0` | 关闭中继（回到裸临时地址行为） |
| `CODEX_REMOTE_RELAY_BASE` | 指定注册表地址 |
| `CODEX_REMOTE_RELAY_DOMAIN` | 指定实例子域的基础域（默认从注册表地址推导） |
| `%LOCALAPPDATA%\CodexRemoteWeb\relay.json` | 同上，文件形式：`{"enabled":true,"base":"...","domain":"..."}` |

## 运行成本与配额（Cloudflare 免费档）

- Worker 请求：10 万次/天。手机 GUI 的每次 API 轮询都算一次请求，重度使用的单实例
  每天可能消耗数千次；朋友数量多时留意用量，必要时升级 Workers Paid（$5/月，1000 万次）。
- KV：免费档读 10 万次/天、**写 1000 次/天**。Worker 已做写放大防护：同目标重复注册不写 KV，
  换目标写入有 3 秒冷却；正常使用时每实例只在隧道地址变化时写一次。
- 域名：`codexremote.dpdns.org` 来自 DigitalPlat 免费域名，无年费；注意其续期政策（按期在
  DigitalPlat 面板确认/续期），域名失效则中继和命名隧道一起失效。

## 安全注意事项

- `relay-identity.json` 里的 secret 是注册凭据：拿到它的人能把你的固定子域指向**他自己的**
  trycloudflare 隧道（钓鱼面）。文件只在实例本机，权限尽量收紧；怀疑泄露时删除该文件重启，
  实例会铸造新 id（手机需重扫一次）。
- Worker 不接受 `*.trycloudflare.com` 之外的目标，注册表不存储任何流量或设备数据。
- 想彻底下线中继：控制台删除 Worker 与 KV 命名空间即可；实例侧会在重试耗尽后自动回退裸临时地址。

# 当前轮控制

手机页面保留默认的“排队”发送，同时提供“插话”和停止当前轮的入口。

## 行为

- 排队：沿用现有 `codex queue` 和指定模型的入队流程，不改变当前执行轮。
- 插话：调用 `turn/steer`，带上原活动轮的 `expectedTurnId`；不会新开一轮，也不会同时修改模型或推理强度。
- 停止：调用 `turn/interrupt`，明确指定 `threadId` 和 `turnId`。只停止该轮，不删除排队消息，后续排队工作仍可能继续。
- 恢复队列：当实时通道确认会话空闲且队列有首条待执行消息时，手机显示“恢复队列”，调用 `thread/queue/start` 启动原有首条消息；不会发送文字“继续”、新开轮次或改写队列。
- 模型设置在插话模式禁用，切回排队后保留原选择。

停止请求的 RPC 回执不等于已经停止。只有匹配轮次的中断完成通知，或实时连接返回的该轮已中断记录，才显示已中断。尚未确认完成时显示“已请求停止”。

## 可用范围

控制能力按会话实时判断，不以历史记录的“执行中”状态单独作为依据：

1. 本服务通过 `SessionCreator` 创建、或通过 `ConfiguredTurns` 成功持有的执行连接可供控制。
2. 其他会话只尝试连接已有的 `codex app-server proxy` 共享通道，读取已加载会话的实时状态。
3. 不启动共享 daemon，不调用 `thread/resume` 抢占桌面会话，不删除写锁，不通过杀桌面进程实现中断。
4. 桌面使用独立 stdio app-server、共享端口不可连接，或无法确认活动轮标识时，控制不可用；普通排队仍可使用。

因此，“功能已接入”不表示每个桌面独占会话都能被手机直接中断。可用性以该会话返回的控制能力为准。
队列恢复同样受共享控制通道限制；如果手机只能读取本地队列计数，页面会显示待执行数量和“请在桌面点击继续”的原因，但不会伪造恢复成功。

## 接口

以下接口仍受设备配对鉴权保护。POST 另需同源 Origin 和 JSON。

- `GET /api/threads/:id/control`：返回实时能力、活动 `turnId`、状态和不可用原因；可附带已验证的历史完成信息 `lastTurn`，它不代表当前执行轮。
- `POST /api/threads/:id/steer`：`{text, requestId, turnId}`。
- `POST /api/threads/:id/interrupt`：`{requestId, turnId}`。
- `POST /api/threads/:id/queue/resume`：`{requestId, queuedSubmissionId}`。服务端重新读取并校验队首 ID、空闲状态和实时控制通道后，才调用 `thread/queue/start`。

插话回执为 `steered`。停止回执为 `interruptRequested` 或 `interrupted`，都包含对应 `requestId` 和 `turnId`。控制动作不能携带模型设置，也不会回退为排队发送。
恢复队列回执为 `queueStarted`，包含 `queuedSubmissionId`、新轮次 `turnId` 和实际 `turnStatus`（`inProgress`、`completed`、`failed` 或 `interrupted`）。

## 请求安全

服务端在自己的数据目录保存 `control-outbox.json`，按设备和请求 ID 去重，指纹包含动作、会话、原轮次和文本；不保存明文引导文本。重启前未确认的动作保持未知，不自动重发。

网页在 sessionStorage 保留未确认请求及草稿。用户主动重试时沿用原请求 ID 和原轮次，不把旧引导发送到新轮。已知未发送的拒绝与“可能已发送但回执丢失”分别处理。
队列恢复的未确认请求还会保留原 `queuedSubmissionId`；即使队首后来变化或队列为空，人工核对也只检查原请求，不会误启动下一条消息。普通消息确认发送后会同步清除已发送草稿，但不会清除另一条未确认的恢复请求。

## 验证

```powershell
npm.cmd test
node test/mobile-layout.browser.mjs
git -c core.whitespace=cr-at-eol diff --check
```

浏览器脚本使用隔离测试服务和模拟控制数据，不会中断或引导真实 Codex 会话。它依赖 Playwright，可使用本机安装或 Codex 的捆绑运行时；浏览器路径可由 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定。

import { randomUUID } from "node:crypto";
import { AppServerClient } from "./app-server-client.js";
import { error } from "./auth.js";

function notSent(message, status = 409) {
  return Object.assign(error(message, status), { notSubmitted: true });
}

function settingsConfirmation(client, threadId, settings, timeoutMs) {
  let timer;
  let notification, closed;
  const dispose = () => {
    clearTimeout(timer);
    client.off("notification", notification);
    client.off("closed", closed);
  };
  const promise = new Promise((resolve, reject) => {
    notification = (method, params) => {
      if (method !== "thread/settings/updated" || params?.threadId !== threadId) return;
      const actual = params.threadSettings;
      if (actual?.model !== settings.model) return;
      if (settings.effort !== undefined && actual.effort !== settings.effort) return;
      dispose();
      resolve();
    };
    closed = () => { dispose(); reject(error("设置确认连接已关闭。", 503)); };
    timer = setTimeout(() => { dispose(); reject(error("设置确认超时。", 504)); }, timeoutMs);
    client.on("notification", notification);
    client.once("closed", closed);
  });
  return { promise, dispose };
}

// queue/add has no model fields. Update only this server's successfully resumed
// thread, await its settings notification, then enqueue through the durable API.
export class ConfiguredTurns {
  constructor({ store, executable = "codex", prefixArgs = [], codexHome, timeoutMs = 25000, maxRunning = 3, controls }) {
    this.store = store;
    this.executable = executable;
    this.prefixArgs = prefixArgs;
    this.codexHome = codexHome;
    this.timeoutMs = timeoutMs;
    this.maxRunning = maxRunning;
    this.controls = controls;
    this.clients = new Map();
    this.stopping = false;
  }

  has(threadId) { return this.clients.has(threadId); }

  checkStopping() {
    if (this.stopping) throw notSent("服务正在停止，请稍后再试。", 503);
  }

  async send(thread, text, settings) {
    this.checkStopping();
    if (this.has(thread.id)) throw notSent("这条会话正在处理指定模型的消息，请完成后再发送。");
    if (this.clients.size >= this.maxRunning) throw notSent("正在执行其他模型任务，请稍后再试。", 429);
    if (this.store.pendingCount?.(thread.id) > 0)
      throw notSent("此会话还有排队消息。请先处理队列，再指定新的模型发送。");

    const client = new AppServerClient({
      executable: this.executable, prefixArgs: this.prefixArgs,
      codexHome: this.codexHome, cwd: thread.cwd, timeoutMs: this.timeoutMs,
    });
    const entry = { client, timer: null, messageId: null };
    this.clients.set(thread.id, entry);
    client.closePromise.then(() => {
      clearTimeout(entry.timer);
      if (this.clients.get(thread.id) === entry) this.clients.delete(thread.id);
    });

    let resumeRequested = false, resumeAccepted = false;
    let settingsDispatched = false, queueDispatched = false;
    try {
      await client.initialize();
      this.checkStopping();
      resumeRequested = true;
      const resumed = await client.request("thread/resume", { threadId: thread.id });
      if (resumed?.thread?.id !== thread.id)
        throw notSent("Codex 未确认目标会话，本次消息未发送。", 502);
      resumeAccepted = true;
      this.controls?.attach(thread.id, client);
      for (const turn of resumed.thread.turns || [])
        this.controls?.observeTurn(thread.id, turn);
      this.checkStopping();
      if (this.store.pendingCount?.(thread.id) > 0)
        throw notSent("会话已有排队消息，本次消息未发送，也未更改模型设置。");

      const selected = { model: settings.model, ...(settings.effort !== undefined ? { effort: settings.effort } : {}) };
      const confirmation = settingsConfirmation(client, thread.id, selected, this.timeoutMs);
      try {
        settingsDispatched = true;
        await Promise.all([
          client.request("thread/settings/update", { threadId: thread.id, ...selected }),
          confirmation.promise,
        ]);
      } finally {
        confirmation.dispose();
      }
      this.checkStopping();

      const clientUserMessageId = randomUUID();
      queueDispatched = true;
      const reply = await client.request("thread/queue/add", {
        threadId: thread.id,
        input: [{ type: "text", text, text_elements: [] }],
        clientUserMessageId,
      });
      const receipt = reply?.queuedSubmission;
      if (typeof receipt?.id !== "string" || !receipt.id
        || receipt.clientUserMessageId !== clientUserMessageId
        || !Array.isArray(receipt.input)) throw error("Codex 未确认排队回执。", 502);
      entry.messageId = receipt.id;
      this.observeUntilIdle(thread.id, entry);
      return {
        status: "queued", messageId: receipt.id,
        model: selected.model, effort: selected.effort ?? null,
        notice: "消息已排队。所选模型设置用于会话后续轮次，不改变正在执行的轮次；之后在桌面修改设置也会影响尚未执行的消息。",
      };
    } catch (cause) {
      // A resume timeout may have acquired this process's writer. Observe it
      // conservatively instead of killing possibly active queued work.
      const resumeRejected = !resumeAccepted && Number.isInteger(cause.code);
      const writerConflict = !resumeAccepted && /active writer|already.*(?:loaded|running)|thread.*owned/i.test(cause.message || "");
      if (resumeRequested && !resumeRejected && !writerConflict && !this.stopping && !client.closedError)
        this.observeUntilIdle(thread.id, entry);
      else await client.close();

      if (!settingsDispatched) {
        if (cause.notSubmitted) throw cause;
        if (writerConflict)
          throw notSent("当前会话被 Codex 桌面占用，手机暂时无法切换它的模型。本次消息未发送；可在桌面切换，或选择“沿用当前设置”排队。");
        throw notSent("无法接管这个会话，本次消息未发送，也未请求修改模型设置。", cause.statusCode || 502);
      }
      // Keep the outbox entry as unknown after any settings mutation. A queue
      // timeout is not proof that enqueueing failed, so never mark safe retry.
      throw error(queueDispatched
        ? "模型设置可能已更新，但消息入队未确认。请先检查会话及模型设置，勿重复发送。"
        : "模型设置可能已更新，但尚未确认，本次消息未发送。请先检查会话设置，勿重复发送。",
      cause.statusCode || 502);
    }
  }

  observeUntilIdle(threadId, entry) {
    if (entry.observing) return;
    entry.observing = true;
    const alive = () => !this.stopping && !entry.client.closedError && this.clients.get(threadId) === entry;
    const emptyQueue = async () => {
      // One item is enough: keep the owner for all outstanding submissions,
      // including concurrent messages from another client, not just our own.
      const result = await entry.client.request("thread/queue/list", { threadId, limit: 1 });
      return Array.isArray(result?.data) && result.data.length === 0 && result.nextCursor == null;
    };
    const poll = async () => {
      if (!alive()) return;
      try {
        if (await emptyQueue() && alive()) {
          const result = await entry.client.request("thread/read", { threadId, includeTurns: false });
          if (result?.thread?.id === threadId
            && ["idle", "notLoaded"].includes(result.thread.status?.type)
            && alive() && await emptyQueue() && alive()) {
            await entry.client.close();
            return;
          }
        }
      } catch {
        // Observation failure does not establish idleness. Retain the owner
        // and retry; stop() remains the explicit shutdown path.
      }
      if (alive()) entry.timer = setTimeout(poll, Math.min(this.timeoutMs, 1000));
    };
    entry.timer = setTimeout(poll, 0);
  }

  async stop() {
    this.stopping = true;
    const entries = [...this.clients.values()];
    for (const entry of entries) clearTimeout(entry.timer);
    await Promise.all(entries.map(({ client }) => client.close()));
  }
}

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AppServerClient } from "./app-server-client.js";
import { error, hash, saveJson } from "./auth.js";

const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const requestPattern = /^[a-zA-Z0-9_-]{16,80}$/;
const notSent = (message, statusCode = 409) =>
  Object.assign(error(message, statusCode), {notSubmitted: true});
const unknown = () => Object.assign(
  error("控制结果未确认，请检查当前执行轮，勿重复操作。", 409), {controlUnknown: true});
const unavailable = reason => ({
  available: false, source: null, state: "unavailable", turnId: null,
  canInterrupt: false, canSteer: false, reason,
});

function interruptedConfirmation(client, threadId, turnId, timeoutMs) {
  let confirmed = false, done = false, timer, resolve;
  const notification = (method, params) => {
    if (method !== "turn/completed" || params?.threadId !== threadId ||
      params.turn?.id !== turnId || params.turn.status !== "interrupted") return;
    confirmed = true;
    finish();
  };
  const closed = () => finish();
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    client.off("notification", notification);
    client.off("closed", closed);
    resolve(confirmed);
  };
  const promise = new Promise(r => { resolve = r; });
  client.on("notification", notification);
  client.once("closed", closed);
  timer = setTimeout(finish, timeoutMs);
  return {promise, get confirmed() { return confirmed; }, dispose: finish};
}

export class TurnControls {
  constructor({
    store, dataDir, executable = "codex", prefixArgs = [], codexHome, cwd,
    timeoutMs = 8000, confirmTimeoutMs = 2000, sharedRetryMs = 30000, sharedFactory,
  }) {
    this.store = store;
    this.confirmTimeoutMs = confirmTimeoutMs;
    this.sharedRetryMs = sharedRetryMs;
    this.sharedFactory = sharedFactory || (() => new AppServerClient({
      executable, prefixArgs, codexHome, cwd, timeoutMs, transport: "proxy",
    }));
    this.entries = new Map();
    this.finished = new Map();
    this.reading = new Map();
    this.running = new Map();
    this.activeThreads = new Set();
    this.sharedRetryAt = 0;
    this.stopping = false;
    mkdirSync(dataDir, {recursive: true});
    this.path = join(dataDir, "control-outbox.json");
    this.records = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
    if (!this.records || typeof this.records !== "object" || Array.isArray(this.records))
      throw new Error("会话控制记录格式无效");
    for (const record of Object.values(this.records))
      if (record.status === "sending") record.status = "unknown";
  }

  attach(threadId, client) {
    this.checkStopping();
    if (typeof threadId !== "string" || !idPattern.test(threadId)) throw notSent("会话标识无效。", 400);
    const previous = this.entries.get(threadId);
    if (previous?.client === client) return;
    if (previous && !previous.client.closedError) throw notSent("会话已有活动控制连接。");
    const entry = {client, turn: null};
    const notification = (method, params) => {
      if (params?.threadId !== threadId) return;
      if (method === "turn/started") this.observeTurn(threadId, params.turn);
      if (method === "turn/completed") {
        if (entry.turn?.id === params.turn?.id) entry.turn = null;
        this.noteCompletion(threadId, params.turn);
      }
    };
    const closed = () => {
      client.off("notification", notification);
      if (this.entries.get(threadId) === entry) this.entries.delete(threadId);
    };
    this.entries.set(threadId, entry);
    client.on("notification", notification);
    client.once("closed", closed);
  }

  observeTurn(threadId, turn) {
    const entry = this.entries.get(threadId);
    if (entry && typeof turn?.id === "string" && idPattern.test(turn.id))
      entry.turn = turn.status === "inProgress" ? {id: turn.id} : null;
  }

  noteCompletion(threadId, turn) {
    if (typeof turn?.id !== "string" || !idPattern.test(turn.id) ||
      !["interrupted", "completed", "failed"].includes(turn.status)) return;
    this.finished.set(threadId, {id: turn.id, status: turn.status, at: Date.now()});
    if (this.finished.size > 256) this.finished.delete(this.finished.keys().next().value);
    if (turn.status !== "interrupted") return;
    let changed = false;
    for (const record of Object.values(this.records)) {
      if (record.action !== "interrupt" || record.threadId !== threadId || record.turnId !== turn.id ||
        !(record.status === "sending" || record.status === "unknown" || record.result?.status === "interruptRequested")) continue;
      record.status = "confirmed";
      record.result = {status: "interrupted", requestId: record.requestId, turnId: turn.id};
      changed = true;
    }
    // A read-only observation must not crash the transport if the disk is unavailable.
    if (changed) try { this.persist(); } catch {}
  }

  checkStopping() {
    if (this.stopping) throw notSent("控制服务正在停止，请稍后再试。", 503);
  }

  unavailableQueue(threadId, reason = "队列控制通道不可用，请在桌面点击“继续”。") {
    let count = null;
    try {
      const value = this.store.pendingCount?.(threadId);
      if (Number.isSafeInteger(value) && value >= 0) count = value;
    } catch {}
    return {available: false, pending: count > 0, count, headId: null, canResume: false, reason};
  }

  async readQueue(client, threadId, idle) {
    try {
      const page = await client.request("thread/queue/list", {threadId, limit: 1});
      if (!Array.isArray(page?.data) ||
        (page.data.length && (typeof page.data[0]?.id !== "string" || !idPattern.test(page.data[0].id))))
        throw new Error("invalid queue response");
      const stored = this.unavailableQueue(threadId).count;
      const count = page.nextCursor == null ? page.data.length
        : stored !== null && stored >= page.data.length ? stored : null;
      const headId = page.data[0]?.id || null;
      return {available: true, pending: !!headId, count, headId, canResume: idle && !!headId,
        reason: !headId ? "当前没有待执行的排队消息。"
          : !idle ? "当前轮仍在执行，请等待结束后恢复队列。" : ""};
    } catch {
      return this.unavailableQueue(threadId, "无法读取待执行队列，请在桌面确认队列状态。");
    }
  }

  async sharedClient() {
    this.checkStopping();
    if (this.shared && !this.shared.closedError) return this.shared;
    if (Date.now() < this.sharedRetryAt) return null;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let client;
      try {
        client = this.sharedFactory();
        await client.initialize();
        this.checkStopping();
        this.shared = client;
        client.once("closed", () => {
          if (this.shared === client) this.shared = null;
          this.sharedRetryAt = Date.now() + this.sharedRetryMs;
        });
        return client;
      } catch {
        this.sharedRetryAt = Date.now() + this.sharedRetryMs;
        await client?.close();
        return null;
      }
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async inspect(threadId, includeQueue = false) {
    this.checkStopping();
    this.store.requireThread(threadId);
    const entry = this.entries.get(threadId);
    const client = entry?.client.closedError ? null : entry?.client;
    const connection = client || await this.sharedClient();
    if (!connection) return {state: unavailable("桌面未开放共享控制通道，此会话暂不能停止或引导。")};
    const source = client ? "mobile" : "shared";
    const reply = await connection.request("thread/read", {threadId, includeTurns: false});
    const thread = reply?.thread;
    if (thread?.id !== threadId || !["active", "idle"].includes(thread.status?.type) ||
      (!client && typeof thread.canAcceptDirectInput !== "boolean"))
      return {state: unavailable("此会话尚未接入可控的实时执行通道，可继续排队发送。")};
    let turnId = null;
    try {
      const turns = await connection.request("thread/turns/list", {
        threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
      });
      if (turns?.data?.[0]) this.noteCompletion(threadId, turns.data[0]);
      if (thread.status.type === "active") {
        const active = turns?.data?.find(t => t.status === "inProgress" && typeof t.id === "string" && idPattern.test(t.id));
        turnId = active?.id || entry?.turn?.id || null;
      }
    } catch {
      if (thread.status.type === "active") turnId = entry?.turn?.id || null;
    }
    const canInterrupt = !!turnId;
    const canSteer = canInterrupt && thread.canAcceptDirectInput !== false;
    const state = {
      available: true, source, state: thread.status.type === "active" ? "inProgress" : "idle",
      turnId, canInterrupt, canSteer,
      reason: thread.status.type === "idle" ? "当前没有正在执行的轮次。"
        : !turnId ? "尚未取得活动轮标识，暂不能控制。"
          : !canSteer ? "当前执行轮暂不接受引导。" : "",
    };
    if (includeQueue) state.queue = await this.readQueue(connection, threadId, thread.status.type === "idle");
    return {client: connection, state};
  }

  async status(threadId) {
    this.store.requireThread(threadId);
    if (this.stopping) return unavailable("控制服务正在停止。");
    if (!this.reading.has(threadId)) {
      const pending = this.inspect(threadId, true).then(({state}) => state)
        .catch(() => unavailable("实时控制状态暂不可用，可继续排队发送。"))
        .then(state => {
          if (!state.queue) state = {...state, queue: this.unavailableQueue(threadId)};
          const last = this.finished.get(threadId);
          if (last && Date.now() - last.at < 5 * 60000)
            return {...state, lastTurn: {id: last.id, status: last.status}};
          this.finished.delete(threadId);
          return state;
        })
        .finally(() => this.reading.delete(threadId));
      this.reading.set(threadId, pending);
    }
    return this.reading.get(threadId);
  }

  async act({action, threadId, turnId, queuedSubmissionId, text = "", requestId, deviceId}) {
    this.checkStopping();
    const resuming = action === "resumeQueue";
    if (!["steer", "interrupt", "resumeQueue"].includes(action) ||
      typeof threadId !== "string" || !idPattern.test(threadId) ||
      (!resuming && (typeof turnId !== "string" || !idPattern.test(turnId))) ||
      (resuming && (typeof queuedSubmissionId !== "string" || !idPattern.test(queuedSubmissionId) ||
        turnId !== undefined || text !== "")) ||
      typeof requestId !== "string" || !requestPattern.test(requestId))
      throw notSent("控制动作、会话、轮次或请求标识无效。", 400);
    if (typeof deviceId !== "string" || !deviceId) throw notSent("设备授权无效。", 401);
    if (action === "steer" && (typeof text !== "string" || !text.trim() || text.length > 12000))
      throw notSent("引导消息不能为空，且不能超过 12000 个字符。", 400);
    this.store.requireThread(threadId);
    const key = hash(deviceId + ":" + requestId);
    const fingerprint = hash(JSON.stringify(resuming ? {action, threadId, queuedSubmissionId}
      : {action, threadId, turnId, text: action === "steer" ? text : ""}));
    const previous = this.records[key];
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw notSent("同一请求标识不能用于不同控制动作。");
      if (this.running.has(key)) return this.running.get(key);
      if (previous.status === "confirmed") return previous.result;
      throw unknown();
    }
    if (this.activeThreads.has(threadId)) throw notSent("此会话已有控制请求，请等待确认。");
    if (this.running.size >= 3) throw notSent("正在处理其他控制请求，请稍后重试。", 429);
    this.records[key] = {fingerprint, status: "sending", createdAt: Date.now(),
      action, threadId, turnId, queuedSubmissionId, requestId};
    this.persist();
    this.activeThreads.add(threadId);
    let dispatched = false;
    const promise = Promise.resolve().then(async () => {
      const {client, state} = await this.inspect(threadId, resuming);
      this.checkStopping();
      if (resuming) {
        if (!state.available || !state.queue?.available || !state.queue.canResume)
          throw notSent(state.queue?.reason || "此会话的队列控制通道不可用，请在桌面点击“继续”。");
        if (state.queue.headId !== queuedSubmissionId)
          throw notSent("队首消息已变化，本次未恢复队列，请确认最新状态。");
        dispatched = true;
        const reply = await client.request("thread/queue/start", {threadId, queuedSubmissionId});
        const turn = reply?.turn;
        if (typeof turn?.id !== "string" || !idPattern.test(turn.id) ||
          !["inProgress", "completed", "failed", "interrupted"].includes(turn.status)) throw unknown();
        this.observeTurn(threadId, turn);
        const result = {status: "queueStarted", requestId, queuedSubmissionId, turnId: turn.id, turnStatus: turn.status};
        this.records[key] = {...this.records[key], status: "confirmed", result};
        this.persist();
        return result;
      }
      if (!state.available || !(action === "steer" ? state.canSteer : state.canInterrupt))
        throw notSent(state.reason || "当前执行轮不能接受这个控制动作。");
      if (state.turnId !== turnId) throw notSent("当前执行轮已变化，本次控制未发送，请确认最新状态。");
      dispatched = true;
      let status;
      if (action === "steer") {
        const reply = await client.request("turn/steer", {
          threadId, expectedTurnId: turnId,
          input: [{type: "text", text, text_elements: []}], clientUserMessageId: requestId,
        });
        if (reply?.turnId !== turnId) throw unknown();
        status = "steered";
      } else {
        const confirmation = interruptedConfirmation(client, threadId, turnId, this.confirmTimeoutMs);
        try {
          const rpc = client.request("turn/interrupt", {threadId, turnId});
          rpc.catch(() => {});
          const reply = await Promise.race([
            rpc,
            confirmation.promise.then(confirmed => confirmed ? {confirmed: true} : new Promise(() => {})),
          ]);
          if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw unknown();
          status = reply.confirmed || await confirmation.promise ? "interrupted" : "interruptRequested";
        } finally { confirmation.dispose(); }
      }
      const result = {status, turnId, requestId};
      this.records[key] = {...this.records[key], status: "confirmed", result};
      this.persist();
      return result;
    }).catch(cause => {
      const settled = this.records[key];
      if (settled?.status === "confirmed" && settled.result) return settled.result;
      const rejected = !dispatched || cause.notSubmitted === true;
      if (rejected) delete this.records[key];
      else this.records[key].status = "unknown";
      this.persist();
      if (cause.notSubmitted) throw cause;
      if (rejected) throw notSent("Codex 未接受本次控制，执行轮可能已结束或变化。");
      throw unknown();
    }).finally(() => {
      this.running.delete(key);
      this.activeThreads.delete(threadId);
    });
    this.running.set(key, promise);
    return promise;
  }

  persist() {
    const cutoff = Date.now() - 30 * 86400000;
    for (const [key, record] of Object.entries(this.records))
      if (record.createdAt < cutoff) delete this.records[key];
    saveJson(this.path, this.records);
  }

  async stop() {
    this.stopping = true;
    await this.connecting;
    await this.shared?.close();
    await Promise.allSettled([...this.running.values()]);
  }
}

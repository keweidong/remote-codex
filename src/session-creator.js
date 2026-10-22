import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { error, hash, saveJson } from "./auth.js";
import { AppServerClient } from "./app-server-client.js";
import {modelSelection,selectionSuffix} from './model-selection.js';

const requestPattern = /^[a-zA-Z0-9_-]{16,80}$/;

function projectRoot(project) {
  const roots = Array.isArray(project?.paths) ? project.paths : [];
  for (const value of roots) {
    if (typeof value !== "string" || !value || value.length > 4096) continue;
    try {
      if (existsSync(value) && statSync(value).isDirectory()) return value;
    } catch {}
  }
  throw error("项目目录不可用，请先在桌面打开该项目后重试。", 409);
}

export class SessionCreator {
  constructor({
    store,
    dataDir,
    executable = "codex",
    prefixArgs = [],
    codexHome,
    startTimeoutMs = 25000,
    maxRunning = 3,
    models,
    controls,
  }) {
    this.store = store;
    this.executable = executable;
    this.prefixArgs = prefixArgs;
    this.codexHome = codexHome;
    this.startTimeoutMs = startTimeoutMs;
    this.maxRunning = maxRunning;
    this.models=models;
    this.controls = controls;
    this.running = new Map();
    this.children = new Set();
    this.clients = new Set();
    this.stopping = false;
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "new-threads.json");
    this.records = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, "utf8"))
      : {};
    if (!this.records || typeof this.records !== "object")
      throw new Error("新会话记录格式无效");
    for (const record of Object.values(this.records))
      if (record.status === "starting") record.status = "unknown";
  }

  async create({ projectId, text, requestId, deviceId, model, effort }) {
    if (typeof text !== "string" || !text.trim() || text.length > 12000)
      throw error("首条消息不能为空，且不能超过 12000 个字符。");
    if (typeof requestId !== "string" || !requestPattern.test(requestId))
      throw error("消息请求标识无效。");
    if (typeof deviceId !== "string" || !deviceId)
      throw error("设备授权无效。", 401);
    const project = this.store.requireProject(projectId);
    const selection=modelSelection({model,effort});
    const key = hash(deviceId + ":" + requestId);
    const fingerprint = hash(project.id + "\n" + text + selectionSuffix(selection));
    const previous = this.records[key];
    if (previous) {
      if (previous.fingerprint !== fingerprint && previous.fingerprint !== hash(projectId + "\n" + text + selectionSuffix(selection)))
        throw error("同一请求标识不能用于不同新会话。", 409);
      if (this.running.has(key)) return this.running.get(key);
      if (previous.status === "created") return previous.result;
      throw error(
        "这条新会话已有提交记录，请先检查桌面会话，避免重复创建。",
        409,
      );
    }
    if (this.stopping) throw error("服务正在停止，请稍后再试。", 503);
    const cwd = projectRoot(project);
    if (this.children.size >= this.maxRunning)
      throw error("正在创建其他会话，请稍后再试。", 429);
    this.records[key] = {
      fingerprint,
      status: "starting",
      createdAt: Date.now(),
      selection,
    };
    this.persist();
    const promise = Promise.resolve().then(async()=>{
      if(this.stopping)throw Object.assign(error('服务正在停止，本次会话未创建。',503),{notSubmitted:true});
      let settings={};
      if(Object.keys(selection).length){
        try{
          if(!this.models)throw error('模型选择服务暂不可用，请在电脑重启服务。',503);
          settings=await this.models.normalize(selection);
        }catch(e){throw Object.assign(e,{notSubmitted:true});}
      }
      if(this.stopping)throw Object.assign(error('服务正在停止，本次会话未创建。',503),{notSubmitted:true});
      if(this.children.size>=this.maxRunning)throw Object.assign(error('正在创建其他会话，请稍后再试。',429),{notSubmitted:true});
      return this.execute(project,cwd,text,(threadId)=>{
        this.records[key].threadId=threadId;this.persist();
      },settings);
    })
      .then((threadId) => {
        const result = {
          status: "created",
          threadId,
          requestId,
          projectId: project.id,
          cwd,
        };
        this.records[key] = {
          ...this.records[key],
          status: "created",
          result,
        };
        this.persist();
        return result;
      })
      .catch((e) => {
        if(e.notSubmitted)delete this.records[key];
        else this.records[key] = { ...this.records[key],status: "unknown" };
        this.persist();
        throw e;
      })
      .finally(() => this.running.delete(key));
    this.running.set(key, promise);
    return promise;
  }

  persist() {
    const cutoff = Date.now() - 30 * 86400000;
    for (const [key, record] of Object.entries(this.records))
      if (record.createdAt < cutoff) delete this.records[key];
    saveJson(this.path, this.records);
  }

  async execute(project, cwd, text, onThreadStarted, settings={}) {
    const client = new AppServerClient({
      executable: this.executable,
      prefixArgs: this.prefixArgs,
      codexHome: this.codexHome,
      cwd,
      timeoutMs: this.startTimeoutMs,
    });
    this.clients.add(client);
    if (client.child) this.children.add(client.child);
    const release = () => {
      this.clients.delete(client);
      this.children.delete(client.child);
    };
    if (client.child) client.child.once("close", release);
    else client.once("closed", release);
    let threadId, firstTurnId;
    const completedTurns = new Set();
    const interruptedTurns = new Set();
    client.on("notification", (method, params) => {
      if (method === "turn/completed" && params?.threadId === threadId) {
        completedTurns.add(params.turn?.id);
        if (params.turn?.status === "interrupted") interruptedTurns.add(params.turn?.id);
        if (firstTurnId && completedTurns.has(firstTurnId)) {
          if (interruptedTurns.has(firstTurnId)) this.closeWhenIdle(client, threadId);
          else void client.close();
        }
      }
    });
    try {
      await client.initialize();
      const started = await client.request("thread/start", {
        cwd,
        projectId: project.id,
        ephemeral: false,
        ...(settings.model?{model:settings.model}:{}),
      });
      const thread = started?.thread;
      if (
        !thread || typeof thread.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(thread.id) ||
        !["cli", "vscode"].includes(thread.source) ||
        thread.projectId !== project.id || thread.ephemeral !== false
      ) throw error("Codex 未确认桌面可见的项目会话，请检查客户端版本。", 502);
      threadId = thread.id;
      this.controls?.attach(threadId, client);
      // Keep the allocated id even if the first turn later fails or times out.
      onThreadStarted(threadId);
      const response = await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        ...settings,
      });
      if (typeof response?.turn?.id !== "string" || !response.turn.id ||
          !["inProgress", "completed"].includes(response.turn.status))
        throw error("Codex 未确认首条消息，状态未知。请检查会话，勿重复创建。", 502);
      firstTurnId = response.turn.id;
      this.controls?.observeTurn(threadId, response.turn);
      if (response.turn.status === "completed" || completedTurns.has(firstTurnId)) void client.close();
      return threadId;
    } catch (e) {
      await client.close();
      throw Object.assign(error(
        threadId
          ? "会话已分配，但首条消息未确认，状态未知。请先检查会话，勿重复创建。"
          : "新会话创建未确认，状态未知。请检查本机 Codex 后重试原请求。",
        e.statusCode || 502,
      ), { cause: e });
    }
  }

  async closeWhenIdle(client, threadId) {
    // A completion notification can race with the next queued turn. Keep the
    // owner until the app-server confirms both an idle thread and an empty queue.
    await new Promise(resolve => queueMicrotask(resolve));
    try {
      const [thread, queued] = await Promise.all([
        client.request("thread/read", {threadId, includeTurns: false}),
        client.request("thread/queue/list", {threadId, limit: 1}),
      ]);
      if (thread?.thread?.status?.type === "idle" &&
        Array.isArray(queued?.data) && queued.data.length === 0 &&
        queued.nextCursor == null) await client.close();
    } catch {
      // Keep the owner alive when the state cannot be proven idle.
    }
  }

  async stop() {
    this.stopping = true;
    await Promise.all([...this.clients].map(client => client.close()));
    await Promise.allSettled([...this.running.values()]);
  }
}

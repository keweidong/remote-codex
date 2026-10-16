import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { hash, error, saveJson } from "./auth.js";
import {modelSelection,selectionSuffix} from './model-selection.js';

export class Queue {
  constructor({ store, dataDir, executable = "codex", prefixArgs = [], models, configuredTurns }) {
    this.store = store;
    this.executable = executable;
    this.prefixArgs = prefixArgs;
    this.running = new Map();
    this.runningThreads=new Set();
    this.models=models;
    this.configuredTurns=configuredTurns;
    this.stopping=false;
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "outbox.json");
    this.records = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, "utf8"))
      : {};
    for (const r of Object.values(this.records))
      if (r.status === "sending") r.status = "unknown";
  }
  async send({ threadId, text, requestId, deviceId, model, effort }) {
    if(this.stopping)throw Object.assign(error('服务正在停止，请稍后再试。',503),{notSubmitted:true});
    if (typeof text !== "string" || !text.trim() || text.length > 12000)
      throw error("消息不能为空，且不能超过 12000 个字符。");
    if (
      typeof requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId)
    )
      throw error("消息请求标识无效。");
    const thread = this.store.requireThread(threadId);
    const selection=modelSelection({model,effort});
    const key = hash(deviceId + ":" + requestId),
      fingerprint = hash(threadId + "\n" + text + selectionSuffix(selection));
    const previous = this.records[key];
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw error("同一请求标识不能用于不同消息。", 409);
      if (this.running.has(key)) return this.running.get(key);
      if (['queued','started'].includes(previous.status)) return previous.result;
      throw error(
        "这条消息已有提交记录，请先检查桌面会话，避免重复发送。",
        409,
      );
    }
    if (this.running.size >= 3)
      throw error("正在提交其他消息，请稍后再试。", 429);
    if(this.runningThreads.has(threadId)||this.configuredTurns?.has(threadId))
      throw error('这条会话正在提交或执行指定模型的消息，请完成后再发送。',409);
    this.records[key] = {
      fingerprint,
      status: "sending",
      createdAt: Date.now(),
      threadId,
      selection,
    };
    this.persist();
    this.runningThreads.add(threadId);
    const promise = Promise.resolve().then(async()=>{
      if(this.stopping)throw Object.assign(error('服务正在停止，本次消息未发送。',503),{notSubmitted:true});
      if(!Object.keys(selection).length)return this.execute(thread,text);
      if(!this.models||!this.configuredTurns)throw Object.assign(error('模型切换服务暂不可用，请在电脑重启服务。',503),{notSubmitted:true});
      let settings;
      try{settings=await this.models.normalize(selection,{currentModel:thread.model});}
      catch(e){throw Object.assign(e,{notSubmitted:true});}
      if(this.stopping)throw Object.assign(error('服务正在停止，本次消息未发送。',503),{notSubmitted:true});
      return this.configuredTurns.send(thread,text,settings);
    })
      .then((result) => {
        const value = typeof result==='string'?{ status: "queued", messageId: result, requestId }:{...result,requestId};
        this.records[key] = {
          ...this.records[key],
          status: value.status,
          result: value,
        };
        this.persist();
        return value;
      })
      .catch((e) => {
        if(e.notSubmitted)delete this.records[key];
        else this.records[key].status = "unknown";
        this.persist();
        throw e;
      })
      .finally(() => {this.running.delete(key);this.runningThreads.delete(threadId);});
    this.running.set(key, promise);
    return promise;
  }
  persist() {
    const cutoff = Date.now() - 30 * 86400000;
    for (const [k, r] of Object.entries(this.records))
      if (r.createdAt < cutoff) delete this.records[k];
    saveJson(this.path, this.records);
  }
  async stop(){this.stopping=true;await this.configuredTurns?.stop();await Promise.allSettled([...this.running.values()]);}
  execute(thread, text) {
    return new Promise((resolve, reject) => {
      const args = [
        ...this.prefixArgs,
        "queue",
        "--thread",
        thread.id,
        "--message=" + text,
        "-C",
        thread.cwd,
      ];
      const child = spawn(this.executable, args, {
        cwd: thread.cwd,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "",
        settled = false;
      const done = (err, id) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve(id);
      };
      const timer = setTimeout(() => {
        child.kill();
        done(
          error(
            "提交超时，状态未知。请先在桌面查看是否已收到，勿重复发送。",
            504,
          ),
        );
      }, 25000);
      child.stdout.on("data", (d) => {
        stdout = (stdout + d).slice(-64000);
      });
      child.stderr.on("data", (d) => {
        stderr = (stderr + d).slice(-8000);
      });
      child.on("error", () =>
        done(
          error("无法启动 Codex 命令，请检查本机 Codex CLI 和项目目录。", 503),
        ),
      );
      child.on("exit", (code) => {
        const match = stdout.match(
          /Queued message\s+(\S+)\s+for thread\s+([A-Za-z0-9_-]+)\.?\s*$/im,
        );
        if (code === 0 && match && match[2] === thread.id) done(null, match[1]);
        else
          done(
            error(
              `Codex 未确认提交（退出码 ${code ?? "未知"}）。请在桌面查看会话；不会自动重发。`,
              502,
            ),
          );
      });
    });
  }
}

import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { hash, error, saveJson } from "./auth.js";

export class Queue {
  constructor({ store, dataDir, executable = "codex", prefixArgs = [] }) {
    this.store = store;
    this.executable = executable;
    this.prefixArgs = prefixArgs;
    this.running = new Map();
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "outbox.json");
    this.records = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, "utf8"))
      : {};
    for (const r of Object.values(this.records))
      if (r.status === "sending") r.status = "unknown";
  }
  async send({ threadId, text, requestId, deviceId }) {
    if (typeof text !== "string" || !text.trim() || text.length > 12000)
      throw error("消息不能为空，且不能超过 12000 个字符。");
    if (
      typeof requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId)
    )
      throw error("消息请求标识无效。");
    const thread = this.store.requireThread(threadId);
    const key = hash(deviceId + ":" + requestId),
      fingerprint = hash(threadId + "\n" + text);
    const previous = this.records[key];
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw error("同一请求标识不能用于不同消息。", 409);
      if (this.running.has(key)) return this.running.get(key);
      if (previous.status === "queued") return previous.result;
      throw error(
        "这条消息已有提交记录，请先检查桌面会话，避免重复发送。",
        409,
      );
    }
    if (this.running.size >= 3)
      throw error("正在提交其他消息，请稍后再试。", 429);
    this.records[key] = {
      fingerprint,
      status: "sending",
      createdAt: Date.now(),
    };
    this.persist();
    const promise = this.execute(thread, text)
      .then((result) => {
        const value = { status: "queued", messageId: result, requestId };
        this.records[key] = {
          ...this.records[key],
          status: "queued",
          result: value,
        };
        this.persist();
        return value;
      })
      .catch((e) => {
        this.records[key].status = "unknown";
        this.persist();
        throw e;
      })
      .finally(() => this.running.delete(key));
    this.running.set(key, promise);
    return promise;
  }
  persist() {
    const cutoff = Date.now() - 30 * 86400000;
    for (const [k, r] of Object.entries(this.records))
      if (r.createdAt < cutoff) delete this.records[k];
    saveJson(this.path, this.records);
  }
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
          /Queued message\s+(\S+)\s+for thread\s+(\S+)/i,
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

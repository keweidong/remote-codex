import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const maxMessageBytes = 8 * 1024 * 1024;

function failure(message, code, statusCode = 502) {
  return Object.assign(new Error(message), { code, statusCode });
}

export class AppServerClient extends EventEmitter {
  constructor({ executable = "codex", prefixArgs = [], codexHome, cwd, timeoutMs = 25000 } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";
    this.closedError = null;
    this.processClosed = false;
    this.closePromise = new Promise((resolve) => { this.resolveClose = resolve; });
    try {
      this.child = spawn(executable, [...prefixArgs, "app-server", "--stdio"], {
        cwd,
        windowsHide: true,
        shell: false,
        env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      this.processClosed = true;
      this.startupError = failure("无法启动 Codex app-server，请检查本机命令和项目目录。", "ESPAWN", 503);
      queueMicrotask(() => {
        this.finish(this.startupError);
        this.resolveClose();
      });
      return;
    }
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.receive(chunk));
    this.child.stdout.on("error", () => this.abort(failure("Codex app-server 输出连接已断开。", "EPIPE")));
    // Drain diagnostic output without retaining or exposing credentials or prompt text.
    this.child.stderr.resume();
    this.child.stderr.on("error", () => {});
    this.child.stdin.on("error", () => this.abort(failure("Codex app-server 输入连接已断开。", "EPIPE")));
    this.child.on("error", () => this.abort(failure("无法启动 Codex app-server，请检查本机命令和项目目录。", "ESPAWN", 503)));
    this.child.on("close", (code, signal) => {
      this.processClosed = true;
      clearTimeout(this.killTimer);
      this.finish(failure(`Codex app-server 已退出（${signal || `退出码 ${code ?? "未知"}`}）。`, "EEXIT"));
      this.resolveClose();
    });
  }

  initialize() {
    if (!this.initialization) {
      this.initialization = this.request("initialize", {
        clientInfo: { name: "codex_remote_web", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      }).then((result) => {
        this.write({ method: "initialized", params: {} });
        return result;
      });
    }
    return this.initialization;
  }

  request(method, params = {}) {
    if (this.closedError || this.startupError) return Promise.reject(this.closedError || this.startupError);
    if (this.pending.size >= 128)
      return Promise.reject(failure("Codex app-server 等待中的请求过多。", "EBUSY", 503));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(failure("Codex app-server 请求超时，执行状态未知。", "ETIMEDOUT", 504));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  write(message) {
    if (this.closedError || this.startupError) throw this.closedError || this.startupError;
    let line;
    try {
      line = JSON.stringify(message) + "\n";
    } catch {
      throw failure("Codex app-server 请求无法序列化。", "EINVAL", 400);
    }
    if (Buffer.byteLength(line) + this.child.stdin.writableLength > maxMessageBytes)
      throw failure("Codex app-server 请求数据超过限制。", "EMSGSIZE", 413);
    this.child.stdin.write(line, (error) => {
      if (error) this.abort(failure("Codex app-server 输入连接已断开。", "EPIPE"));
    });
  }

  receive(chunk) {
    if (this.closedError) return;
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > maxMessageBytes) {
        this.abort(failure("Codex app-server 输出超过协议限制。", "EPROTOCOL"));
        return;
      }
      if (line.trim()) this.receiveLine(line);
      if (this.closedError) return;
    }
    if (Buffer.byteLength(this.buffer) > maxMessageBytes)
      this.abort(failure("Codex app-server 输出超过协议限制。", "EPROTOCOL"));
  }

  receiveLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.abort(failure("Codex app-server 返回了无效的 JSONL 消息。", "EPROTOCOL"));
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.abort(failure("Codex app-server 返回了无效的协议消息。", "EPROTOCOL"));
      return;
    }
    const hasId = Object.hasOwn(message, "id");
    if (typeof message.method === "string") {
      if (!hasId) {
        this.emit("notification", message.method, message.params);
      } else {
        try {
          this.write({ id: message.id, error: { code: -32601, message: "Method not supported by this client" } });
          this.emit("serverRequestRejected", message.method);
        } catch (error) {
          this.abort(error);
        }
      }
      return;
    }
    const pending = hasId && this.pending.get(message.id);
    if (!pending) return; // A response can arrive after its request deadline.
    if (!Object.hasOwn(message, "result") && !message.error) {
      this.abort(failure("Codex app-server 返回了无效的响应。", "EPROTOCOL"));
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      const text = typeof message.error.message === "string"
        ? message.error.message.slice(0, 500) : "Codex app-server 请求失败。";
      pending.reject(failure(text, message.error.code ?? "ERPC"));
    } else {
      pending.resolve(message.result);
    }
  }

  finish(error) {
    if (this.closedError) return;
    this.closedError = error;
    this.buffer = "";
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }

  abort(error) {
    this.finish(error);
    if (this.child && !this.processClosed) {
      this.child.stdin.destroy();
      this.child.kill();
      this.forceCloseSoon();
    }
  }

  forceCloseSoon() {
    if (this.killTimer || this.processClosed) return;
    this.killTimer = setTimeout(() => {
      this.child.kill("SIGKILL");
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    }, 1000);
  }

  async close() {
    this.finish(failure("Codex app-server 连接已关闭。", "ECLOSED", 503));
    if (this.child && !this.processClosed) {
      this.child.stdin.end();
      this.forceCloseSoon();
    }
    await this.closePromise;
  }
}

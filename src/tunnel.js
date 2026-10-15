import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export class Tunnel {
  constructor({ executable, port }) {
    this.executable = executable;
    this.port = port;
    this.child = null;
    this.value = {
      status: "stopped",
      url: "",
      error: "",
      available: Boolean(executable && existsSync(executable)),
    };
  }
  snapshot() {
    return { ...this.value };
  }
  start() {
    if (this.child) return this.snapshot();
    if (!this.value.available) {
      this.value = {
        ...this.value,
        status: "error",
        error: "未找到 cloudflared，请设置 CLOUDFLARED_PATH 后重启服务。",
      };
      return this.snapshot();
    }
    const child = spawn(
      this.executable,
      [
        "tunnel",
        "--no-autoupdate",
        "--url",
        `http://127.0.0.1:${this.port}`,
        "--protocol",
        "http2",
      ],
      { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.child = child;
    this.value = { ...this.value, status: "starting", url: "", error: "" };
    let tail = "";
    const consume = (data) => {
      if (this.child !== child) return;
      tail = (tail + data.toString()).slice(-16000);
      const match = tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);
      if (match)
        this.value = {
          ...this.value,
          status: "running",
          url: match[0],
          error: "",
        };
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", () => {
      if (this.child !== child) return;
      this.child = null;
      this.value = {
        ...this.value,
        status: "error",
        url: "",
        error: "无法启动公网隧道，请检查 cloudflared 程序。",
      };
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.value = {
        ...this.value,
        status: "error",
        url: "",
        error: `公网隧道已退出（${code ?? "未知"}）。可以重新启动。`,
      };
    });
    return this.snapshot();
  }
  stop() {
    const child = this.child;
    this.child = null;
    if (child) child.kill();
    this.value = { ...this.value, status: "stopped", url: "", error: "" };
    return this.snapshot();
  }
}

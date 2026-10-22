import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { error, saveJson } from "./auth.js";

// A quick tunnel hostname is random per launch, so a paired phone cannot find it
// again after a restart. A named tunnel driven by TUNNEL_TOKEN keeps one fixed
// hostname forever, which is what makes pairing survive restarts.
const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/;
const CONNECTED = /Registered tunnel connection/i;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const TOKEN = /^[A-Za-z0-9_.\-=]{20,8192}$/;
const BACKOFF_MS = [2000, 5000, 10000, 20000, 30000];
// cloudflared normally logs a registered connection within a few seconds; if the
// log wording ever changes we still promote a live process instead of hanging.
const CONFIRM_MS = 20000;

export function sanitizeHostname(value) {
  if (typeof value !== "string") return null;
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return HOSTNAME.test(host) ? host : null;
}
export function sanitizeToken(value) {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return TOKEN.test(token) ? token : null;
}
function flag(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}
export function normalizeTunnelConfig(input = {}) {
  const hostname = sanitizeHostname(input.hostname);
  const token = sanitizeToken(input.token);
  const ready = Boolean(hostname && token);
  // "quick" is the only meaningful override: without both credentials a fixed
  // domain cannot work at all, so there is nothing to force.
  const preferQuick = input.mode === "quick";
  const mode = ready && !preferQuick ? "token" : "quick";
  return {
    mode,
    preferQuick,
    hostname,
    token,
    autostart: Boolean(input.autostart) && mode === "token",
  };
}
export function loadTunnelConfig(dataDir, env = process.env) {
  let stored = {};
  try {
    const parsed = JSON.parse(
      readFileSync(join(dataDir, "tunnel.json"), "utf8"),
    );
    if (parsed && typeof parsed === "object") stored = parsed;
  } catch {}
  const autostart = flag(env.CODEX_REMOTE_TUNNEL_AUTOSTART, stored.autostart);
  return normalizeTunnelConfig({
    hostname: flag(env.CODEX_REMOTE_TUNNEL_HOSTNAME, stored.hostname),
    token: flag(env.CODEX_REMOTE_TUNNEL_TOKEN, stored.token),
    mode: flag(env.CODEX_REMOTE_TUNNEL_MODE, stored.mode),
    autostart:
      typeof autostart === "string"
        ? !["0", "false", "no", ""].includes(autostart.trim().toLowerCase())
        : autostart,
  });
}
export function saveTunnelConfig(dataDir, config) {
  const saved = {
    hostname: config.hostname,
    token: config.token,
    autostart: config.autostart,
  };
  // Only a deliberate fallback to the temporary address is worth persisting;
  // the fixed-domain choice must stay derived from the credentials.
  if (config.preferQuick) saved.mode = "quick";
  saveJson(join(dataDir, "tunnel.json"), saved);
}

export class Tunnel {
  constructor({
    executable,
    port,
    dataDir = "",
    config = null,
    prefixArgs = [],
    confirmMs = CONFIRM_MS,
    backoffMs = BACKOFF_MS,
    onUrl = null,
  }) {
    this.executable = executable;
    this.port = port;
    this.dataDir = dataDir;
    this.prefixArgs = prefixArgs;
    this.backoffMs = backoffMs;
    this.confirmMs = confirmMs;
    this.onUrl = onUrl;
    this.config = normalizeTunnelConfig(config || {});
    this.child = null;
    this.retryTimer = null;
    this.confirmTimer = null;
    this.attempt = 0;
    this.value = {
      status: "stopped",
      url: "",
      error: "",
      available: this.checkAvailable(),
    };
  }
  /**
   * Live binary check: the npm-package binary may be downloaded in the
   * background after startup, and the admin page must pick it up without a
   * service restart.
   */
  checkAvailable() {
    return Boolean(this.executable && existsSync(this.executable));
  }
  /** Notify the URL observer (relay registration); observer faults are contained. */
  emitUrl(url) {
    if (typeof this.onUrl !== "function") return;
    try {
      this.onUrl(url);
    } catch {}
  }
  // The token is a bearer credential: it is never part of the snapshot, never
  // stored in tunnel output, and never passed on the command line where other
  // local processes could read it back out of the process list.
  snapshot() {
    const { mode, hostname, token, autostart } = this.config;
    return {
      ...this.value,
      available: this.checkAvailable(),
      mode,
      hostname: hostname || "",
      configured: Boolean(hostname && token),
      fixed: mode === "token" && Boolean(hostname && token),
      autostart,
    };
  }
  shouldAutostart() {
    const snap = this.snapshot();
    return snap.fixed && snap.autostart && snap.available;
  }
  later(fn, ms) {
    const timer = setTimeout(() => {
      this.forget(timer);
      fn();
    }, ms);
    return timer;
  }
  forget(timer) {
    if (this.retryTimer === timer) this.retryTimer = null;
    if (this.confirmTimer === timer) this.confirmTimer = null;
  }
  clearTimers() {
    for (const timer of [this.retryTimer, this.confirmTimer])
      if (timer) clearTimeout(timer);
    this.retryTimer = null;
    this.confirmTimer = null;
  }
  setConfig(input = {}) {
    if (input === null || typeof input !== "object")
      throw error("配置格式无效。");
    const next = { ...this.config };
    // Keep a deliberate temporary-address choice, but never let a derived mode
    // become sticky, or it would block the upgrade once credentials arrive.
    next.mode = next.preferQuick ? "quick" : undefined;
    if ("hostname" in input) {
      const raw = input.hostname;
      if (raw === null || raw === undefined || String(raw).trim() === "")
        next.hostname = null;
      else {
        const hostname = sanitizeHostname(raw);
        if (!hostname)
          throw error("主机名无效，请填写完整域名，例如 codex.example.com。");
        next.hostname = hostname;
      }
    }
    if ("token" in input && typeof input.token === "string") {
      if (input.token.trim() === "") next.token = null;
      else {
        const token = sanitizeToken(input.token);
        if (!token)
          throw error(
            "Token 格式无效，请完整复制 cloudflared tunnel run --token 后面那一长串。",
          );
        next.token = token;
      }
    }
    if ("autostart" in input) next.autostart = Boolean(input.autostart);
    if ("mode" in input) {
      if (!["token", "quick"].includes(input.mode))
        throw error("隧道模式无效。");
      next.mode = input.mode;
    }
    const previous = this.config;
    this.config = normalizeTunnelConfig(next);
    if (this.dataDir) saveTunnelConfig(this.dataDir, this.config);
    const running = Boolean(this.child) || Boolean(this.retryTimer);
    const changed =
      previous.hostname !== this.config.hostname ||
      previous.token !== this.config.token ||
      previous.mode !== this.config.mode;
    if (running && changed) {
      this.stop();
      this.start();
    }
    return this.snapshot();
  }
  start() {
    if (this.child || this.retryTimer) return this.snapshot();
    if (!this.checkAvailable()) {
      this.value = {
        ...this.value,
        status: "error",
        error:
          "未找到 cloudflared。首次启动会在后台自动下载，请稍后重试；也可以设置 CLOUDFLARED_PATH 指定自己的副本。",
      };
      return this.snapshot();
    }
    // mode is only "token" when both credentials are present, so there is no
    // half-configured fixed domain to reject here.
    this.attempt = 0;
    if (this.config.mode === "token") this.launchFixed();
    else this.launchQuick();
    return this.snapshot();
  }
  launch(args, env, onOutput) {
    const child = spawn(this.executable, [...this.prefixArgs, ...args], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", ...env },
    });
    this.child = child;
    let tail = "";
    const consume = (data) => {
      if (this.child !== child) return;
      // Only the tail is inspected and it is never stored, so tunnel output
      // cannot leak into state, logs or the admin API.
      tail = (tail + data.toString()).slice(-16000);
      onOutput(tail);
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", () => {
      if (this.child !== child) return;
      this.child = null;
      this.clearTimers();
      this.value = {
        ...this.value,
        status: "error",
        url: "",
        error: "无法启动公网隧道，请检查 cloudflared 程序。",
      };
      this.emitUrl(null);
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.clearTimers();
      this.exited(code);
    });
    return child;
  }
  launchFixed() {
    const hostname = this.config.hostname;
    this.value = { ...this.value, status: "starting", url: "", error: "" };
    this.launch(
      ["--no-autoupdate", "--protocol", "http2", "tunnel", "run"],
      { TUNNEL_TOKEN: this.config.token },
      (tail) => {
        if (this.value.status === "starting" && CONNECTED.test(tail))
          this.connected(hostname);
      },
    );
    this.confirmTimer = this.later(() => {
      if (this.child && this.value.status === "starting")
        this.connected(hostname);
    }, this.confirmMs);
  }
  connected(hostname) {
    this.attempt = 0;
    // The fallback confirmation is no longer needed; leaving it pending would
    // hold the event loop open for the full window after every start.
    if (this.confirmTimer) {
      clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
    }
    this.value = {
      ...this.value,
      status: "running",
      url: `https://${hostname}`,
      error: "",
    };
    // A fixed hostname needs no relay; park it so the admin page stops
    // offering a stale instance origin.
    this.emitUrl(null);
  }
  launchQuick() {
    this.value = { ...this.value, status: "starting", url: "", error: "" };
    this.launch(
      [
        "tunnel",
        "--no-autoupdate",
        "--url",
        `http://127.0.0.1:${this.port}`,
        "--protocol",
        "http2",
      ],
      {},
      (tail) => {
        const match = tail.match(QUICK_URL);
        if (match && this.value.url !== match[0]) {
          this.value = {
            ...this.value,
            status: "running",
            url: match[0],
            error: "",
          };
          // Hand the fresh quick URL to the relay so the fixed instance
          // origin starts pointing here.
          this.emitUrl(match[0]);
        }
      },
    );
  }
  exited(code) {
    // A fixed hostname is worth reconnecting: the phone's bookmark and cookie
    // stay valid, so a transient drop must not force a new pairing.
    if (this.config.mode === "token" && this.attempt < this.backoffMs.length) {
      const delay = this.backoffMs[this.attempt++];
      this.value = {
        ...this.value,
        status: "reconnecting",
        url: "",
        error: `固定域名隧道已退出（${code ?? "未知"}），${Math.round(delay / 1000)} 秒后自动重试。`,
      };
      this.retryTimer = this.later(() => {
        if (!this.child && this.config.mode === "token") this.launchFixed();
      }, delay);
      return;
    }
    this.value = {
      ...this.value,
      status: "error",
      url: "",
      error:
        this.config.mode === "token"
          ? `固定域名隧道反复退出（最后代码 ${code ?? "未知"}）。请核对 Token 是否完整、Public Hostname 是否指向本机手机端口。`
          : `公网隧道已退出（${code ?? "未知"}）。可以重新启动。`,
    };
    this.emitUrl(null);
  }
  stop() {
    const child = this.child;
    this.child = null;
    this.clearTimers();
    this.attempt = 0;
    if (child) child.kill();
    this.value = { ...this.value, status: "stopped", url: "", error: "" };
    this.emitUrl(null);
    return this.snapshot();
  }
}

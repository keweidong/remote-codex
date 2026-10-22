import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { saveJson } from "./auth.js";

// Fixed-origin relay client. A quick-tunnel URL is random per service start,
// so a paired phone loses its bookmark and cookie context on every restart.
// The relay registry (a small Cloudflare Worker operated by the project
// author, see relay/README.md) maps a stable per-instance subdomain
// https://<id>.<domain> to the instance's current quick-tunnel target and
// forwards bytes to it, so phone bookmarks and pairing cookies survive
// restarts without anyone owning a domain. This module is the instance side
// of that protocol: it mints and persists an identity, re-registers whenever
// a quick-tunnel URL appears, and reports a snapshot for the admin page.
//
// Trust notes (mirrored in README): the relay only ever accepts
// *.trycloudflare.com targets and stores SHA-256 hashes of registration
// secrets; the secret plaintext never leaves this machine. Relay traffic
// passes through the operator's Worker, exactly like quick-tunnel traffic
// passes through Cloudflare.

export const RELAY_ID_RE = /^[a-z0-9]{16}$/;
const RELAY_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const QUICK_TARGET_RE = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;
const BACKOFF_MS = [2000, 5000, 10000, 20000, 30000];
const REQUEST_TIMEOUT_MS = 15000;
// Author-operated registry for this project. Not a secret: it is the public
// Worker base. The instance origin is derived by replacing the first label
// with the instance id (registry.codexremote.dpdns.org -> <id>.codexremote.dpdns.org).
export const DEFAULT_RELAY_BASE = "https://registry.codexremote.dpdns.org";

function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function relayDomainFromBase(base) {
  try {
    const host = new URL(base).hostname.toLowerCase();
    const cut = host.indexOf(".");
    return cut > 0 && cut < host.length - 1 ? host.slice(cut + 1) : null;
  } catch {
    return null;
  }
}

export function normalizeRelayConfig(input = {}) {
  const enabled = input.enabled !== false;
  const base = enabled ? text(input.base) || DEFAULT_RELAY_BASE : "";
  let baseHost = "";
  try {
    baseHost = base ? new URL(base).hostname.toLowerCase() : "";
  } catch {}
  const domain =
    enabled && baseHost
      ? text(input.domain) || relayDomainFromBase(base) || ""
      : "";
  // A relay without a registrable base or an instance domain cannot work.
  const ready = Boolean(enabled && /^https:\/\/.+/.test(base) && domain);
  return { enabled: ready, base, domain };
}

export function loadRelayConfig(dataDir, env = process.env) {
  let stored = {};
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, "relay.json"), "utf8"));
    if (parsed && typeof parsed === "object") stored = parsed;
  } catch {}
  const envOff = ["0", "false", "no"].includes(
    (env.CODEX_REMOTE_RELAY || "").trim().toLowerCase(),
  );
  return normalizeRelayConfig({
    enabled: stored.enabled !== false && !envOff,
    base: text(env.CODEX_REMOTE_RELAY_BASE) || text(stored.base),
    domain: text(env.CODEX_REMOTE_RELAY_DOMAIN) || text(stored.domain),
  });
}

export class Relay {
  constructor({
    dataDir,
    config = null,
    fetchImpl = null,
    backoffMs = BACKOFF_MS,
  }) {
    this.dataDir = dataDir;
    this.fetchImpl = fetchImpl || fetch;
    this.backoffMs = backoffMs;
    this.config = config || loadRelayConfig(dataDir);
    this.identity = null;
    this.registeredTarget = "";
    this.desiredTarget = "";
    this.attempt = 0;
    this.retryTimer = null;
    this.inflight = null;
    this.value = {
      status: this.config.enabled ? "idle" : "disabled",
      url: "",
      error: "",
    };
  }
  snapshot() {
    return {
      ...this.value,
      configured: this.config.enabled,
      base: this.config.enabled ? this.config.base : "",
      domain: this.config.enabled ? this.config.domain : "",
    };
  }
  /** The stable instance URL while registered; "" otherwise. */
  runningUrl() {
    return this.value.status === "running" ? this.value.url : "";
  }
  runningHost() {
    const url = this.runningUrl();
    return url ? new URL(url).host : "";
  }
  /** Origins the phone surface must accept in addition to its own Host. */
  allowedOrigins() {
    const url = this.runningUrl();
    return url ? [`https://${new URL(url).host}`] : [];
  }
  identityFile() {
    return join(this.dataDir, "relay-identity.json");
  }
  loadIdentity() {
    if (this.identity) return this.identity;
    try {
      const parsed = JSON.parse(readFileSync(this.identityFile(), "utf8"));
      if (
        parsed &&
        RELAY_ID_RE.test(parsed.id) &&
        RELAY_SECRET_RE.test(parsed.secret)
      ) {
        this.identity = {
          id: parsed.id,
          secret: parsed.secret,
          fresh: parsed.fresh === true,
        };
        return this.identity;
      }
    } catch {}
    // A missing or corrupt identity is reminted: the phone then re-pairs
    // once, the same cost as losing the devices file.
    this.identity = {
      id: randomBytes(8).toString("hex"),
      secret: randomBytes(32).toString("base64url"),
      fresh: true,
    };
    this.persistIdentity();
    return this.identity;
  }
  persistIdentity() {
    saveJson(this.identityFile(), {
      id: this.identity.id,
      secret: this.identity.secret,
      ...(this.identity.fresh ? { fresh: true } : {}),
    });
  }
  instanceUrl(identity = this.identity) {
    return `https://${identity.id}.${this.config.domain}`;
  }
  /**
   * Tunnel URL observer wired to Tunnel.onUrl. Quick-tunnel URLs trigger a
   * (re-)registration; anything else — fixed-domain mode, stop, crash —
   * parks the relay in idle while the registry row stays behind, so the
   * operator's Worker answers bookmarks with its offline page instead of a
   * dead proxy target.
   */
  onTunnelUrl(url) {
    if (!this.config.enabled) return this.snapshot();
    if (!url || !QUICK_TARGET_RE.test(url)) {
      // Fixed-domain mode, tunnel stopped or crashed: stop offering the
      // instance origin for NEW pairings. The registry row deliberately
      // stays behind, so an existing phone bookmark meets the Worker's
      // offline page (and revives on the next quick-tunnel start) instead
      // of a DNS dead end.
      this.clearRetry();
      this.registeredTarget = "";
      if (this.value.status !== "idle" && this.value.status !== "failed")
        this.value = { status: "idle", url: "", error: "" };
      return this.snapshot();
    }
    if (this.registeredTarget === url && this.value.status === "running")
      return this.snapshot();
    this.attempt = 0;
    this.schedule(url);
    return this.snapshot();
  }
  clearRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
  schedule(target) {
    this.clearRetry();
    this.value = { status: "registering", url: "", error: "" };
    this.register(target);
  }
  register(target) {
    // Remember the newest desired target: a registration already in flight
    // must not swallow a tunnel restart that happened while it was running.
    this.desiredTarget = target;
    if (this.inflight) return this.inflight;
    const identity = this.loadIdentity();
    const payload = {
      id: identity.id,
      target,
      ...(identity.fresh
        ? { new_secret: identity.secret }
        : { secret: identity.secret }),
    };
    const settleIdentity = () => {
      if (identity.fresh) {
        identity.fresh = false;
        this.persistIdentity();
      }
    };
    this.inflight = this.fetchImpl(new URL("/_relay/register", this.config.base), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
      .then((res) => {
        this.inflight = null;
        if (res.status === 200) {
          settleIdentity();
          this.attempt = 0;
          if (this.desiredTarget !== target) {
            // The tunnel moved (or stopped) while this registration was in
            // flight; chase the new target, or park when there is none.
            if (this.desiredTarget) this.register(this.desiredTarget);
            else this.value = { status: "idle", url: "", error: "" };
            return;
          }
          this.registeredTarget = target;
          this.value = { status: "running", url: this.instanceUrl(identity), error: "" };
          return;
        }
        if (this.desiredTarget !== target) {
          if (this.desiredTarget) this.register(this.desiredTarget);
          else this.value = { status: "idle", url: "", error: "" };
          return;
        }
        this.fail(target, `注册表返回 ${res.status}。`);
      })
      .catch((e) => {
        this.inflight = null;
        if (this.desiredTarget !== target && this.desiredTarget) {
          this.register(this.desiredTarget);
          return;
        }
        this.fail(target, e?.message || "注册表不可达。");
      });
    return this.inflight;
  }
  fail(target, message) {
    if (this.attempt < this.backoffMs.length) {
      const delay = this.backoffMs[this.attempt++];
      this.value = {
        status: "registering",
        url: "",
        error: `中继注册失败（${message}），${Math.round(delay / 1000)} 秒后重试。`,
      };
      this.clearRetry();
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.register(target);
      }, delay);
      return;
    }
    // Registry outage must never block the tunnel: the QR falls back to the
    // raw quick URL for this session, exactly the pre-relay behavior.
    this.value = {
      status: "failed",
      url: "",
      error: `中继注册失败（${message}）本次会话使用临时地址，下次开启隧道时自动重试。`,
    };
  }
  stop() {
    this.clearRetry();
    this.inflight = null;
    this.desiredTarget = "";
    if (this.value.status === "registering")
      this.value = { status: "idle", url: "", error: "" };
    // Deliberately no unregister: a stale registry row makes the Worker show
    // its offline page for the instance bookmark, which is friendlier than a
    // DNS dead end, and the next start re-registers the same id anyway.
  }
}

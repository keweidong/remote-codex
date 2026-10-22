// CodexRemoteWeb relay worker.
//
// Bound to a wildcard custom domain (e.g. *.codexremote.dpdns.org), this
// script plays two roles on one hostname space:
//
//   1. Registry API on the reserved label `registry`:
//      POST /_relay/register   { id, target, secret | new_secret }
//      POST /_relay/unregister { id, secret }
//      An instance maps its fixed 16-hex id to its current quick-tunnel
//      target. Secrets are stored only as SHA-256 hashes; targets must be
//      https://<slug>.trycloudflare.com; per-id writes are rate-limited and
//      no-op re-registrations skip the KV write entirely (free-tier quotas).
//
//   2. Forwarder for every other label: https://<id>.<domain>/... is proxied
//      byte-for-byte (including WebSocket upgrades) to the registered target.
//      Unknown, expired or dead instances answer a friendly offline page, so
//      a phone bookmark survives service restarts without re-pairing.
//
// The relay changes the access origin, never the trust root: device cookies
// and all application checks stay on the instance; this worker terminates no
// pairing and stores no traffic.

const ID_RE = /^[a-z0-9]{16}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const TARGET_RE = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;
const REGISTRY_LABEL = "registry";
// Minimum gap between two DIFFERENT-target writes for one id. Same-target
// refreshes never write, so this only bounds genuine churn.
const REGISTER_COOLDOWN_MS = 3000;
// Cloudflare edge statuses that mean "target tunnel is dead" rather than an
// application answer; they render the offline page instead of a raw 5xx.
const DEAD_TARGET_STATUSES = new Set([502, 504, 520, 521, 523, 530]);

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function offlinePage() {
  return new Response(
    [
      "<!doctype html>",
      '<html lang="zh-CN"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      "<title>实例离线 · Instance offline</title>",
      "<style>body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f1115;color:#e6e8ee}main{max-width:34rem;margin:1rem;padding:1.5rem 2rem;text-align:center}h1{font-size:1.35rem;margin-bottom:.5rem}h2{font-size:1.05rem;margin:2rem 0 .5rem}p{color:#9aa1b2;line-height:1.75;margin:.25rem 0}strong{color:#e6e8ee}</style>",
      "</head><body><main>",
      "<h1>实例暂时离线</h1>",
      "<p>这台电脑上的 Codex Remote Web 服务当前没有运行，或隧道正在重连。</p>",
      "<p>请稍后刷新本页——<strong>无需重新扫码配对</strong>，设备授权保持不变。</p>",
      "<h2>Instance offline</h2>",
      "<p>The Codex Remote Web service on the paired computer is not running right now, or its tunnel is reconnecting.</p>",
      "<p>Refresh later — <strong>no need to re-pair</strong>; your device authorization is kept.</p>",
      "</main></body></html>",
    ].join(""),
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

async function readBody(request) {
  try {
    const text = await request.text();
    if (text.length > 4096) return null;
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
}

async function registry(request, env, url) {
  if (request.method !== "POST") return json(405, { ok: false, error: "method" });
  const body = await readBody(request);
  if (!body || typeof body !== "object") return json(400, { ok: false, error: "body" });
  const { id, target, secret, new_secret: newSecret } = body;
  if (typeof id !== "string" || !ID_RE.test(id))
    return json(400, { ok: false, error: "id" });
  const presented =
    typeof secret === "string" && SECRET_RE.test(secret)
      ? secret
      : typeof newSecret === "string" && SECRET_RE.test(newSecret)
        ? newSecret
        : null;
  if (!presented) return json(400, { ok: false, error: "secret" });
  const key = "relay:" + id;
  const hash = await sha256Hex(presented);
  const now = Date.now();
  let existing = null;
  try {
    existing = await env.RELAY_KV.get(key, "json");
  } catch {}

  if (url.pathname === "/_relay/register") {
    if (typeof target !== "string" || !TARGET_RE.test(target))
      return json(400, { ok: false, error: "target" });
    if (existing) {
      if (hash !== existing.hash) return json(403, { ok: false, error: "auth" });
      // Same target: nothing to persist; keep free-tier KV writes for real
      // changes only, and answer idempotently (lost-response retries land here).
      if (existing.target === target) return json(200, { ok: true, cached: true });
      if (now - (existing.updated || 0) < REGISTER_COOLDOWN_MS)
        return json(429, { ok: false, error: "cooldown" });
      await env.RELAY_KV.put(
        key,
        JSON.stringify({ hash, target, created: existing.created || now, updated: now }),
      );
      return json(200, { ok: true });
    }
    // No row yet: create it. Whichever secret form the instance presented is
    // hashed; a hijacker cannot pre-claim an id usefully because a later
    // legitimate register with a different secret is rejected only when a row
    // already exists — first writer wins, and ids are 64-bit random.
    await env.RELAY_KV.put(
      key,
      JSON.stringify({ hash, target, created: now, updated: now }),
    );
    return json(200, { ok: true });
  }

  if (url.pathname === "/_relay/unregister") {
    if (!existing) return json(200, { ok: true });
    if (hash !== existing.hash) return json(403, { ok: false, error: "auth" });
    await env.RELAY_KV.delete(key);
    return json(200, { ok: true });
  }

  return json(404, { ok: false, error: "endpoint" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const domain = String(env.RELAY_DOMAIN || "").toLowerCase();
    const host = url.hostname.toLowerCase();
    if (!domain || !host.endsWith("." + domain))
      return json(404, { ok: false, error: "host" });
    const label = host.slice(0, host.length - domain.length - 1);

    if (url.pathname.startsWith("/_relay/")) {
      if (label !== REGISTRY_LABEL || label.includes("."))
        return json(404, { ok: false, error: "endpoint" });
      return registry(request, env, url);
    }
    if (!ID_RE.test(label)) return offlinePage();

    let record = null;
    try {
      record = await env.RELAY_KV.get("relay:" + label, "json");
    } catch {}
    if (!record || !TARGET_RE.test(record.target || "")) return offlinePage();

    const upstream = new URL(url.pathname + url.search, record.target);
    const headers = new Headers(request.headers);
    // Echo the stable origin so the instance can record it as the device's
    // pairing address; the instance only trusts this header when it matches
    // its own relay identity, so a spoofed value is inert.
    headers.set("X-Forwarded-Host", host);
    headers.set("X-Forwarded-Proto", "https");

    let response;
    try {
      response = await fetch(upstream, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      });
    } catch {
      return offlinePage();
    }
    if (DEAD_TARGET_STATUSES.has(response.status)) return offlinePage();
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  },
};

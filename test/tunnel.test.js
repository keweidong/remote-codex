import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Tunnel,
  loadTunnelConfig,
  saveTunnelConfig,
} from "../src/tunnel.js";
import { sanitizeOrigin } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { cloudflaredFixture } from "./cloudflared-fixture.js";

const TOKEN = "eyJhIjoiYWNjdC90dW5uZWwifQ.c2lnbmF0dXJlLXBhcnQ";
const PREFIX = "codex-tunnel-fixture-";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  t.after(() => {
    if (dir.startsWith(join(tmpdir(), PREFIX)))
      rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error("等待条件超时");
    await sleep(15);
  }
}
// `executable` must exist for the tunnel to consider cloudflared available, so
// node is the executable and the fixture script rides along in prefixArgs.
function launcher(dir, options) {
  const script = join(dir, "cloudflared.cjs");
  writeFileSync(script, cloudflaredFixture(dir, options));
  return { executable: process.execPath, prefixArgs: [script] };
}
const json = (dir, name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const spawnCount = (dir) =>
  readFileSync(join(dir, "spawns.txt"), "utf8").trim().split("\n").length;
const stubStore = {
  listProjects: () => [],
  listThreads: () => [],
  getThread: () => ({ messages: [] }),
};

test("fixed-domain tunnel keeps one hostname and never exposes the token", async (t) => {
  const dir = temp(t);
  const { executable, prefixArgs } = launcher(dir, { mode: "token" });
  const tunnel = new Tunnel({
    executable,
    prefixArgs,
    port: 8766,
    dataDir: dir,
    confirmMs: 60000,
    config: { hostname: "https://Codex.Example.com/panel", token: TOKEN, autostart: true },
  });
  t.after(() => tunnel.stop());
  const before = tunnel.snapshot();
  assert.equal(before.mode, "token");
  assert.equal(before.fixed, true);
  assert.equal(before.hostname, "codex.example.com");
  assert.ok(tunnel.shouldAutostart());
  assert.equal(tunnel.start().status, "starting");
  await until(() => tunnel.snapshot().status === "running");
  const snap = tunnel.snapshot();
  // The address is derived from config, so it is identical on every restart.
  assert.equal(snap.url, "https://codex.example.com");
  assert.deepEqual(json(dir, "argv.json"), [
    "--no-autoupdate",
    "--protocol",
    "http2",
    "tunnel",
    "run",
  ]);
  assert.equal(json(dir, "env.json").TUNNEL_TOKEN, TOKEN);
  assert.equal(json(dir, "env.json").NO_COLOR, "1");
  assert.ok(!("token" in snap));
  assert.ok(!JSON.stringify(snap).includes(TOKEN));
  tunnel.stop();
  assert.equal(tunnel.snapshot().status, "stopped");
  assert.equal(tunnel.snapshot().url, "");
});

test("quick tunnel keeps scraping its random address", async (t) => {
  const dir = temp(t);
  const { executable, prefixArgs } = launcher(dir, {
    mode: "quick",
    url: "https://random-name.trycloudflare.com",
  });
  const tunnel = new Tunnel({
    executable,
    prefixArgs,
    port: 9999,
    dataDir: dir,
    config: {},
  });
  t.after(() => tunnel.stop());
  assert.equal(tunnel.snapshot().mode, "quick");
  assert.equal(tunnel.shouldAutostart(), false);
  tunnel.start();
  await until(() => tunnel.snapshot().status === "running");
  assert.equal(tunnel.snapshot().url, "https://random-name.trycloudflare.com");
  assert.deepEqual(json(dir, "argv.json"), [
    "tunnel",
    "--no-autoupdate",
    "--url",
    "http://127.0.0.1:9999",
    "--protocol",
    "http2",
  ]);
  assert.equal(json(dir, "env.json").TUNNEL_TOKEN, "");
});

test("tunnel config is validated, persisted and reloaded", async (t) => {
  const dir = temp(t);
  const tunnel = new Tunnel({
    executable: process.execPath,
    port: 8766,
    dataDir: dir,
    config: {},
  });
  assert.throws(() => tunnel.setConfig({ hostname: "not a host" }), /主机名无效/);
  assert.throws(() => tunnel.setConfig({ hostname: "单域名" }), /主机名无效/);
  assert.throws(
    () => tunnel.setConfig({ hostname: "ok.example.com", token: "short" }),
    /Token 格式无效/,
  );
  assert.throws(() => tunnel.setConfig({ mode: "weird" }), /隧道模式无效/);
  const snap = tunnel.setConfig({
    hostname: "codex.example.com",
    token: TOKEN,
    autostart: true,
  });
  assert.equal(snap.mode, "token");
  assert.equal(snap.autostart, true);
  assert.ok(!JSON.stringify(snap).includes(TOKEN));
  const file = join(dir, "tunnel.json");
  assert.ok(existsSync(file));
  // The token must survive on disk, otherwise a restart cannot reconnect.
  assert.ok(readFileSync(file, "utf8").includes(TOKEN));
  const reloaded = loadTunnelConfig(dir, {});
  assert.deepEqual(reloaded, {
    mode: "token",
    preferQuick: false,
    hostname: "codex.example.com",
    token: TOKEN,
    autostart: true,
  });
  const overridden = loadTunnelConfig(dir, {
    CODEX_REMOTE_TUNNEL_HOSTNAME: "env.example.com",
    CODEX_REMOTE_TUNNEL_AUTOSTART: "0",
  });
  assert.equal(overridden.hostname, "env.example.com");
  assert.equal(overridden.autostart, false);
  // An explicit choice of the temporary address is sticky and survives reload,
  // so a configured fixed domain can be bypassed without deleting its token.
  tunnel.setConfig({ hostname: "codex.example.com", token: TOKEN });
  assert.equal(tunnel.setConfig({ mode: "quick" }).mode, "quick");
  assert.equal(loadTunnelConfig(dir, {}).mode, "quick");
  assert.equal(tunnel.setConfig({ mode: "token" }).mode, "token");
  // Clearing the hostname falls back to a quick tunnel instead of half-working.
  const cleared = tunnel.setConfig({ hostname: "" });
  assert.equal(cleared.mode, "quick");
  assert.equal(cleared.fixed, false);
  assert.equal(cleared.autostart, false);
  // Credentials are what make a fixed domain possible, so an incomplete config
  // is not a broken fixed tunnel: it simply falls back to a temporary address.
  const partial = new Tunnel({
    executable: process.execPath,
    port: 8766,
    dataDir: dir,
    config: { mode: "token", hostname: "codex.example.com" },
  });
  assert.equal(partial.snapshot().mode, "quick");
  assert.equal(partial.snapshot().fixed, false);
  assert.equal(partial.shouldAutostart(), false);
});

test("fixed tunnel reconnects with backoff and then reports an error", async (t) => {
  const dir = temp(t);
  const { executable, prefixArgs } = launcher(dir, {
    mode: "token",
    exitCode: 1,
  });
  const tunnel = new Tunnel({
    executable,
    prefixArgs,
    port: 8766,
    dataDir: dir,
    confirmMs: 60000,
    backoffMs: [200, 120],
    config: { hostname: "codex.example.com", token: TOKEN, autostart: true },
  });
  t.after(() => tunnel.stop());
  tunnel.start();
  await until(() => tunnel.snapshot().status === "reconnecting");
  await until(() => tunnel.snapshot().status === "error");
  assert.equal(spawnCount(dir), 3);
  assert.match(tunnel.snapshot().error, /反复退出/);
  assert.equal(tunnel.snapshot().url, "");
});

test("stopping a fixed tunnel cancels pending reconnects", async (t) => {
  const dir = temp(t);
  const { executable, prefixArgs } = launcher(dir, {
    mode: "token",
    exitCode: 1,
  });
  const tunnel = new Tunnel({
    executable,
    prefixArgs,
    port: 8766,
    dataDir: dir,
    confirmMs: 60000,
    backoffMs: [600],
    config: { hostname: "codex.example.com", token: TOKEN },
  });
  tunnel.start();
  await until(() => tunnel.snapshot().status === "reconnecting");
  const before = spawnCount(dir);
  tunnel.stop();
  await sleep(250);
  assert.equal(spawnCount(dir), before);
  assert.equal(tunnel.snapshot().status, "stopped");
});

test("admin API restores a fixed tunnel at startup and never returns the token", async (t) => {
  const dir = temp(t);
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const { executable, prefixArgs } = launcher(dir, { mode: "token" });
  saveTunnelConfig(stateDir, {
    mode: "token",
    hostname: "codex.example.com",
    token: TOKEN,
    autostart: true,
  });
  const app = createApp({
    store: stubStore,
    dataDir: stateDir,
    adminToken: "test-admin-secret",
    queue: {},
    cloudflaredPath: executable,
    cloudflaredPrefixArgs: prefixArgs,
  });
  const { adminUrl } = await app.start({
    adminPort: 0,
    phonePort: 0,
    phoneHost: "127.0.0.1",
  });
  t.after(async () => {
    await app.stop();
  });
  const login = await fetch(adminUrl + "/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: adminUrl },
    body: JSON.stringify({ token: "test-admin-secret" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const status = async () =>
    await (await fetch(adminUrl + "/admin/status", { headers: { Cookie: cookie } })).json();
  const first = await status();
  assert.equal(first.tunnel.fixed, true);
  assert.equal(first.tunnel.hostname, "codex.example.com");
  await until(async () => (await status()).tunnel.status === "running");
  const running = await status();
  assert.equal(running.tunnel.url, "https://codex.example.com");
  assert.ok(!JSON.stringify(running).includes(TOKEN));
  const post = (path, body, origin = adminUrl, auth = cookie) =>
    fetch(adminUrl + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        ...(auth ? { Cookie: auth } : {}),
      },
      body: JSON.stringify(body),
    });
  // The fixed address is a valid pairing base, which is what a QR code needs.
  const pair = await post("/admin/pair", {
    baseUrl: "https://codex.example.com",
  });
  assert.equal(pair.status, 200);
  const grant = await pair.json();
  assert.ok(grant.url.startsWith("https://codex.example.com/#pair="));
  assert.ok(!JSON.stringify(grant).includes(TOKEN));
  assert.equal((await post("/admin/tunnel-config", {}, "https://evil.example")).status, 403);
  assert.equal((await post("/admin/tunnel-config", {}, adminUrl, "")).status, 401);
  const updated = await post("/admin/tunnel-config", {
    hostname: "phone.example.com",
    autostart: false,
  });
  assert.equal(updated.status, 200);
  const saved = await updated.json();
  assert.equal(saved.hostname, "phone.example.com");
  assert.equal(saved.autostart, false);
  assert.ok(!JSON.stringify(saved).includes(TOKEN));
  // Omitting the token keeps the stored one instead of wiping the credential.
  const reloaded = loadTunnelConfig(stateDir, {});
  assert.equal(reloaded.hostname, "phone.example.com");
  assert.equal(reloaded.token, TOKEN);
  assert.equal(reloaded.autostart, false);
});

test("pairing records the address the phone used so a dead one can be explained", async (t) => {
  const dir = temp(t);
  const app = createApp({
    store: stubStore,
    dataDir: join(dir, "state"),
    adminToken: "test-admin-secret",
    queue: {},
  });
  const { adminUrl, phoneUrl } = await app.start({
    adminPort: 0,
    phonePort: 0,
    phoneHost: "127.0.0.1",
  });
  t.after(async () => {
    await app.stop();
  });
  const grant = app.auth.createGrant();
  const res = await fetch(phoneUrl + "/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: phoneUrl },
    body: JSON.stringify({ token: grant.token, name: "phone" }),
  });
  assert.equal(res.status, 200);
  const { device } = await res.json();
  assert.equal(device.baseUrl, phoneUrl);
  assert.ok(!("hash" in device));
  const login = await fetch(adminUrl + "/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: adminUrl },
    body: JSON.stringify({ token: "test-admin-secret" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const status = await (
    await fetch(adminUrl + "/admin/status", { headers: { Cookie: cookie } })
  ).json();
  assert.equal(status.devices.length, 1);
  assert.equal(status.devices[0].baseUrl, phoneUrl);
  assert.equal(sanitizeOrigin("https://codex.example.com"), "https://codex.example.com");
  assert.equal(sanitizeOrigin("javascript://alert(1)"), "");
  assert.equal(sanitizeOrigin("https://bad host"), "");
  assert.equal(sanitizeOrigin(123), "");
});

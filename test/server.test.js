import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fixture, threadId } from "./fixtures.js";
import { createCodexStore } from "../src/codex-store.js";
import { createApp } from "../src/server.js";

test("real HTTP pairing gates private data, isolates admin, rejects CSRF and revokes immediately", async (t) => {
  const { dir, cleanup } = fixture(t);
  const store = createCodexStore({ codexHome: dir });
  let sent = 0;
  const app = createApp({
    store,
    dataDir: join(dir, "state"),
    adminToken: "test-admin-secret",
    queue: {
      send: async () => {
        sent++;
        return { status: "queued", messageId: "test" };
      },
    },
  });
  const address = await app.start({
    adminPort: 0,
    phonePort: 0,
    phoneHost: "127.0.0.1",
  });
  t.after(async () => {
    await app.stop();
    store.close();
    cleanup();
  });
  const admin = address.adminUrl,
    phone = address.phoneUrl;
  assert.equal((await fetch(phone + "/api/projects")).status, 401);
  assert.equal((await fetch(phone + "/admin/status")).status, 404);
  assert.equal((await fetch(phone + "/admin.html")).status, 404);
  assert.equal((await fetch(admin + "/admin/status")).status, 401);
  let res = await fetch(admin + "/admin/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://evil.example",
    },
    body: JSON.stringify({ token: "test-admin-secret" }),
  });
  assert.equal(res.status, 403);
  res = await fetch(admin + "/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: admin },
    body: JSON.stringify({ token: "test-admin-secret" }),
  });
  assert.equal(res.status, 200);
  const adminCookie = res.headers.get("set-cookie").split(";")[0];
  res = await fetch(admin + "/admin/pair", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: admin,
      Cookie: adminCookie,
    },
    body: JSON.stringify({ baseUrl: "https://evil.example" }),
  });
  assert.equal(res.status, 400);
  res = await fetch(admin + "/admin/pair", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: admin,
      Cookie: adminCookie,
    },
    body: JSON.stringify({ baseUrl: phone }),
  });
  const grant = await res.json();
  assert.ok(grant.qr.startsWith("data:image/png"));
  const token = new URLSearchParams(new URL(grant.url).hash.slice(1)).get(
    "pair",
  );
  res = await fetch(phone + "/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: phone },
    body: JSON.stringify({ token, name: "Browser" }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie").split(";")[0];
  const device = (await res.json()).device;
  assert.equal(
    (await fetch(phone + "/api/projects", { headers: { Cookie: cookie } }))
      .status,
    200,
  );
  assert.equal(
    (await fetch(phone + "/admin/status", { headers: { Cookie: adminCookie } }))
      .status,
    404,
  );
  res = await fetch(phone + `/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: "https://evil.example",
    },
    body: JSON.stringify({ text: "run", requestId: "test-request-id-1" }),
  });
  assert.equal(res.status, 403);
  assert.equal(sent, 0);
  res = await fetch(phone + `/api/threads/${threadId}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).messages.length, 3);
  res = await fetch(admin + `/admin/devices/${device.id}`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
      Origin: admin,
    },
    body: "{}",
  });
  assert.equal(res.status, 200);
  assert.equal(
    (await fetch(phone + "/api/threads", { headers: { Cookie: cookie } }))
      .status,
    401,
  );
});

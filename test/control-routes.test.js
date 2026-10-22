import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fixture, threadId } from "./fixtures.js";
import { createCodexStore } from "../src/codex-store.js";
import { createApp } from "../src/server.js";
import { error } from "../src/auth.js";

test("live control routes remain paired-only, same-origin and separate from queue sending", async t => {
  const {dir, cleanup} = fixture(t);
  const store = createCodexStore({codexHome: dir});
  const actions = [];
  let reads = 0, queued = 0;
  const controls = {
    async status() {
      reads++;
      return {available: true, source: "mobile", state: "inProgress", turnId: "active",
        canInterrupt: true, canSteer: true, reason: ""};
    },
    async act(input) {
      actions.push(input);
      if (input.requestId === "unknown-control-id")
        throw Object.assign(error("结果未知", 409), {controlUnknown: true});
      if (input.action === "resumeQueue") return {
        status: "queueStarted", requestId: input.requestId, queuedSubmissionId: input.queuedSubmissionId,
        turnId: "resumed-turn", turnStatus: "inProgress",
      };
      return {status: input.action === "steer" ? "steered" : "interruptRequested",
        requestId: input.requestId, turnId: input.turnId};
    },
    async stop() {},
  };
  const app = createApp({store, controls, dataDir: join(dir, "remote"), adminToken: "fixture-admin",
    queue: {async send() { queued++; }}});
  const {phoneUrl: phone, adminUrl: admin} = await app.start({adminPort: 0, phonePort: 0, phoneHost: "127.0.0.1"});
  t.after(async () => { await app.stop(); store.close(); cleanup(); });
  const path = `/api/threads/${threadId}`;
  assert.equal((await fetch(phone + path + "/control")).status, 401);
  assert.equal(reads, 0);
  const paired = app.auth.pair(app.auth.createGrant().token, "phone");
  const headers = {Cookie: `crw_device=${paired.token}`, Origin: phone, "Content-Type": "application/json"};
  const post = (base, target, payload, extra = {}) => fetch(base + target, {
    method: "POST", headers: {...headers, ...extra}, body: JSON.stringify(payload),
  });
  const input = {turnId: "active", requestId: "control-route-001", text: "调整方向"};
  assert.equal((await post(phone, path + "/steer", input, {Origin: "https://evil.example"})).status, 403);
  assert.equal((await post(admin, path + "/interrupt", input, {Origin: admin})).status, 401);
  assert.equal((await post(phone, path + "/steer", {...input, model: "ignored-model"})).status, 400);
  assert.equal(actions.length, 0);
  const status = await (await fetch(phone + path + "/control", {headers})).json();
  assert.equal(status.turnId, "active");
  const capabilities = (await (await fetch(phone + "/api/session", {headers})).json()).capabilities;
  assert.equal(capabilities.interrupt, true);
  assert.equal(capabilities.steer, true);
  assert.equal(capabilities.queueResume, true);
  let result = await post(phone, path + "/steer", input);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).status, "steered");
  assert.equal(actions[0].deviceId, paired.device.id);
  assert.equal(actions[0].action, "steer");
  assert.equal(actions[0].turnId, "active");
  assert.equal(queued, 0);
  result = await post(phone, path + "/interrupt", input);
  assert.equal((await result.json()).status, "interruptRequested");
  result = await post(phone, path + "/steer", {...input, requestId: "unknown-control-id"});
  assert.equal((await result.json()).controlUnknown, true);
  const resume = {requestId: "resume-route-0001", queuedSubmissionId: "queued-head"};
  const resumePath = path + "/queue/resume";
  assert.equal((await post(phone, resumePath, resume, {Origin: "https://evil.example"})).status, 403);
  assert.equal((await post(phone, resumePath, {...resume, text: "继续"})).status, 400);
  assert.equal((await post(phone, resumePath, {...resume, turnId: "unrelated"})).status, 400);
  assert.equal((await post(phone, resumePath, {...resume, model: "change"})).status, 400);
  result = await post(phone, resumePath, resume);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).status, "queueStarted");
  assert.equal(actions.at(-1).action, "resumeQueue");
  assert.equal(actions.at(-1).queuedSubmissionId, "queued-head");
  assert.equal(actions.at(-1).deviceId, paired.device.id);
  assert.equal(queued, 0);
  assert.equal((await fetch(phone + "/api/threads/child/control", {headers})).status, 404);
  assert.equal((await post(phone, "/api/threads/child/interrupt", input)).status, 404);
  assert.equal((await post(phone, "/api/threads/child/queue/resume", resume)).status, 404);
  app.auth.revoke(paired.device.id);
  const count = actions.length;
  assert.equal((await post(phone, path + "/interrupt", input)).status, 401);
  assert.equal(actions.length, count);
});

test("an older service without controls advertises unavailable rather than a fake stop", async t => {
  const {dir, cleanup} = fixture(t);
  const store = createCodexStore({codexHome: dir});
  const app = createApp({store, queue: {}, dataDir: join(dir, "remote"), adminToken: "fixture-admin"});
  const {phoneUrl: phone} = await app.start({adminPort: 0, phonePort: 0, phoneHost: "127.0.0.1"});
  t.after(async () => { await app.stop(); store.close(); cleanup(); });
  const paired = app.auth.pair(app.auth.createGrant().token, "phone");
  const headers = {Cookie: `crw_device=${paired.token}`, Origin: phone, "Content-Type": "application/json"};
  const status = await (await fetch(phone + `/api/threads/${threadId}/control`, {headers})).json();
  assert.equal(status.available, false);
  assert.equal(status.canInterrupt, false);
  const result = await fetch(phone + `/api/threads/${threadId}/interrupt`, {
    method: "POST", headers, body: JSON.stringify({turnId: "active", requestId: "control-route-002"}),
  });
  assert.equal(result.status, 503);
  assert.equal((await result.json()).notSubmitted, true);
  const resume = await fetch(phone + `/api/threads/${threadId}/queue/resume`, {
    method: "POST", headers, body: JSON.stringify({queuedSubmissionId: "head", requestId: "resume-route-0002"}),
  });
  assert.equal(resume.status, 503);
  assert.equal((await resume.json()).notSubmitted, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, threadId } from "./fixtures.js";
import { createCodexStore } from "../src/codex-store.js";
import { ConfiguredTurns } from "../src/configured-turn.js";

const selected = { model: "chosen-model", effort: "high" };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const deadline = Date.now() + 7000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("fixture condition did not become true");
    await delay(15);
  }
}

function setup(t, options = {}) {
  const { dir, cleanup } = fixture(t), store = createCodexStore({ codexHome: dir });
  const log = join(dir, "runner-requests.jsonl");
  const statePath = join(dir, "runner-state.json");
  let state = { pending: true, status: "active", otherQueued: false };
  const setState = (update) => { state = { ...state, ...update }; writeFileSync(statePath, JSON.stringify(state)); };
  setState({});
  const cli = join(dir, "runner.cjs");
  writeFileSync(cli, `
    const fs = require("node:fs"), options = ${JSON.stringify(options)};
    const send = (value) => console.log(JSON.stringify(value));
    let enqueued = false, currentThread, settings;
    require("node:readline").createInterface({input:process.stdin}).on("line", line => {
      const r = JSON.parse(line);
      fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
      const reply = (result) => send({id:r.id,result});
      const fail = () => send({id:r.id,error:{code:-32600,message:"fixture-secret provider failure"}});
      if (r.method === "initialize") reply({});
      if (r.method === "thread/resume") {
        currentThread = r.params.threadId;
        if (options.busy) return send({id:r.id,error:{code:-32600,message:"thread already has an active writer"}});
        reply({thread:{id:currentThread,status:{type:options.concurrentActive ? "active" : "idle"}}});
      }
      if (r.method === "thread/settings/update") {
        settings = r.params;
        send({method:"thread/settings/updated",params:{threadId:"another-thread",threadSettings:settings}});
        send({method:"thread/settings/updated",params:{threadId:currentThread,threadSettings:{model:"old-model",effort:"low"}}});
        const notify = () => {
          if (!options.omitConfirmation) send({method:"thread/settings/updated",params:{threadId:currentThread,threadSettings:{model:settings.model,effort:settings.effort ?? null}}});
        };
        if (options.confirmBeforeReply) { notify(); setTimeout(() => reply({}), 20); }
        else { reply({}); setTimeout(notify, options.confirmDelay ?? 10); }
      }
      if (r.method === "thread/queue/add") {
        if (options.failQueue) return fail();
        if (options.hangQueue) return;
        enqueued = true;
        if (options.earlyComplete) send({method:"turn/completed",params:{threadId:currentThread,turn:{id:"fast-turn",status:"completed"}}});
        if (options.badReceipt) return reply({queuedSubmission:{id:"queue-item"}});
        reply({queuedSubmission:{id:"queue-item",input:r.params.input,clientUserMessageId:r.params.clientUserMessageId}});
      }
      if (r.method === "thread/queue/list") {
        const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
        if (state.failRead) return fail();
        reply({data:state.otherQueued ? [{id:"other-item"}] : enqueued && state.pending ? [{id:"queue-item"}] : [],nextCursor:null});
      }
      if (r.method === "thread/read") {
        const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
        reply({thread:{id:currentThread,status:{type:state.status}}});
      }
    });
  `);
  const runner = new ConfiguredTurns({ store, executable: process.execPath, prefixArgs: [cli], codexHome: dir, timeoutMs: options.timeoutMs ?? 1500 });
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  t.after(async () => { await runner.stop(); store.close(); cleanup(); });
  return { runner, store, calls, setState, send: () => runner.send(store.requireThread(threadId), "Hello", selected) };
}

test("confirms settings before queue/add and returns the actual durable queue receipt", async (t) => {
  const { runner, calls, send } = setup(t, { confirmDelay: 80 });
  const pending = send();
  await waitFor(() => calls().some(({ method }) => method === "thread/settings/update"));
  assert.equal(calls().some(({ method }) => method === "thread/queue/add"), false);
  const result = await pending;
  assert.equal(result.status, "queued");
  assert.equal(result.messageId, "queue-item");
  assert.equal(result.model, selected.model);
  assert.equal(result.effort, selected.effort);
  assert.match(result.notice, /后续轮次/);
  const sent = calls();
  assert.deepEqual(sent.find(({ method }) => method === "thread/settings/update").params, { threadId, ...selected });
  const queued = sent.find(({ method }) => method === "thread/queue/add").params;
  assert.deepEqual(queued.input, [{ type: "text", text: "Hello", text_elements: [] }]);
  assert.match(queued.clientUserMessageId, /^[0-9a-f-]{36}$/);
  assert.equal(queued.threadId, threadId);
  assert.equal(sent.some(({ method }) => method === "turn/start"), false);
  assert.equal(runner.has(threadId), true);
  await assert.rejects(send(), (error) => error.statusCode === 409 && error.notSubmitted === true);
});

test("confirmation arriving before update response is retained", async (t) => {
  const { send, calls } = setup(t, { confirmBeforeReply: true });
  assert.equal((await send()).status, "queued");
  assert.equal(calls().filter(({ method }) => method === "thread/queue/add").length, 1);
});

test("writer conflict fails before settings or queue mutations", async (t) => {
  const { send, calls, runner } = setup(t, { busy: true });
  await assert.rejects(send(), (error) => error.statusCode === 409 && error.notSubmitted === true && /桌面/.test(error.message));
  assert.equal(calls().some(({ method }) => ["thread/settings/update", "thread/queue/add", "turn/start"].includes(method)), false);
  assert.equal(runner.clients.size, 0);
});

test("existing queue is rejected before spawning or changing settings", async (t) => {
  const { send, store, calls } = setup(t);
  store.pendingCount = () => 1;
  await assert.rejects(send(), (error) => error.statusCode === 409 && error.notSubmitted === true);
  assert.deepEqual(calls(), []);
});

test("a concurrent active turn still receives a queued message and is never steered", async (t) => {
  const { send, calls } = setup(t, { concurrentActive: true });
  assert.equal((await send()).status, "queued");
  assert.equal(calls().some(({ method }) => method === "turn/start" || method === "turn/steer"), false);
});

test("missing matching settings confirmation never queues and reports possible settings change", async (t) => {
  const { send, calls, setState, runner } = setup(t, { omitConfirmation: true, timeoutMs: 500 });
  setState({ pending: false, status: "idle" });
  await assert.rejects(send(), (error) => error.notSubmitted !== true && /设置.*可能|可能.*设置/.test(error.message) && /未发送/.test(error.message));
  assert.equal(calls().some(({ method }) => method === "thread/queue/add"), false);
  await waitFor(() => !runner.has(threadId));
});

test("queue error after settings confirmation remains unknown and is sanitized", async (t) => {
  const { send, calls, setState, runner } = setup(t, { failQueue: true });
  setState({ pending: false, status: "idle" });
  await assert.rejects(send(), (error) => error.notSubmitted !== true && /设置/.test(error.message) && !error.message.includes("fixture-secret"));
  assert.equal(calls().filter(({ method }) => method === "thread/queue/add").length, 1);
  await waitFor(() => !runner.has(threadId));
});

test("queue timeout and malformed receipt never report success or safe retry", async (t) => {
  for (const options of [{ hangQueue: true }, { badReceipt: true }]) {
    const { send, setState, runner } = setup(t, { ...options, timeoutMs: 500 });
    setState({ pending: false, status: "idle" });
    await assert.rejects(send(), (error) => error.notSubmitted !== true && /未确认/.test(error.message));
    await waitFor(() => !runner.has(threadId));
  }
});

test("early or missing completion events cannot prematurely close an active owner", async (t) => {
  const { send, setState, runner, calls } = setup(t, { earlyComplete: true });
  await send();
  setState({ pending: false, status: "active" });
  await waitFor(() => calls().some(({ method }) => method === "thread/read"));
  assert.equal(runner.has(threadId), true);
  setState({ status: "idle" });
  await waitFor(() => !runner.has(threadId));
});

test("other queued work prevents release even after our message disappears", async (t) => {
  const { send, setState, runner, calls } = setup(t);
  await send();
  setState({ pending: false, otherQueued: true, status: "idle" });
  const before = calls().filter(({ method }) => method === "thread/queue/list").length;
  await waitFor(() => calls().filter(({ method }) => method === "thread/queue/list").length > before);
  assert.equal(runner.has(threadId), true);
  setState({ otherQueued: false });
  await waitFor(() => !runner.has(threadId));
});

test("transient observation errors preserve the owner and later recover without notifications", async (t) => {
  const { send, setState, runner, calls } = setup(t);
  await send();
  setState({ failRead: true, pending: false, status: "idle" });
  const before = calls().filter(({ method }) => method === "thread/queue/list").length;
  await waitFor(() => calls().filter(({ method }) => method === "thread/queue/list").length > before);
  assert.equal(runner.has(threadId), true);
  setState({ failRead: false });
  await waitFor(() => !runner.has(threadId));
});

test("stop during confirmation closes the owned child and cannot queue afterward", async (t) => {
  const { send, runner, calls } = setup(t, { omitConfirmation: true });
  const pending = assert.rejects(send(), (error) => error.notSubmitted !== true);
  await waitFor(() => calls().some(({ method }) => method === "thread/settings/update"));
  await runner.stop();
  await pending;
  assert.equal(runner.clients.size, 0);
  assert.equal(calls().some(({ method }) => method === "thread/queue/add"), false);
  await assert.rejects(send(), (error) => error.statusCode === 503 && error.notSubmitted === true);
});

test("stop before initialization finishes cannot resume or mutate a thread", async (t) => {
  const { send, runner, calls } = setup(t);
  const pending = assert.rejects(send(), (error) => error.notSubmitted === true);
  await runner.stop();
  await pending;
  assert.equal(calls().some(({ method }) => method === "thread/resume" || method === "thread/queue/add"), false);
  assert.equal(runner.clients.size, 0);
});

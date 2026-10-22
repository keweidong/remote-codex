import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnControls } from "../src/turn-controls.js";
import { error } from "../src/auth.js";

class Runtime extends EventEmitter {
  constructor() {
    super();
    this.turnId = "turn-live";
    this.state = "active";
    this.calls = [];
    this.closedError = null;
    this.closes = 0;
    this.acceptInput = true;
    this.queued = [];
  }
  async initialize() { return {}; }
  async close() {
    this.closes++;
    this.closedError = new Error("closed");
    this.emit("closed", this.closedError);
  }
  async request(method, params) {
    this.calls.push({method, params});
    if (method === "thread/read") return {thread: {
      id: params.threadId, status: {type: this.state}, canAcceptDirectInput: this.acceptInput,
    }};
    if (method === "thread/turns/list") return {
      data: [{id: this.turnId, status: this.state === "active" ? "inProgress" : this.finishedStatus || "completed", items: []}],
      nextCursor: null,
    };
    if (method === "thread/queue/list") return {
      data: this.queued.slice(0, params.limit || 1),
      nextCursor: this.queued.length > (params.limit || 1) ? "next" : null,
    };
    if (this.failControl) throw this.failControl;
    if (method === "thread/queue/start") {
      if (this.queued[0]?.id !== params.queuedSubmissionId) throw new Error("head changed");
      this.queued.shift();
      this.state = "active";
      return {turn: {id: this.badQueueReceipt ? "" : "resumed-turn",
        status: this.resumeStatus || "inProgress", items: []}};
    }
    if (method === "turn/steer") return {turnId: this.badReceipt ? "wrong-turn" : this.turnId};
    if (method === "turn/interrupt") {
      if (!this.omitCompletion) {
        this.state = "idle";
        this.emit("notification", "turn/completed", {
          threadId: params.threadId, turn: {id: this.turnId, status: "interrupted"},
        });
        if (this.closeOnInterrupt) await this.close();
      }
      return {};
    }
    throw new Error("unexpected method: " + method);
  }
}

function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codex-control-test-"));
  const runtime = new Runtime();
  const store = {requireThread(id) {
    if (id !== "chat") throw error("not found", 404);
    return {id, cwd: dir};
  }};
  const controls = new TurnControls({
    store, dataDir: dir, confirmTimeoutMs: 30,
    sharedFactory: () => { throw new Error("PRIVATE socket credential"); },
    ...options,
  });
  t.after(async () => {
    await controls.stop();
    if (!runtime.closedError) await runtime.close();
    assert.ok(dir.startsWith(join(tmpdir(), "codex-control-test-")));
    rmSync(dir, {recursive: true, force: true});
  });
  return {dir, runtime, store, controls};
}

const steer = {
  action: "steer", threadId: "chat", turnId: "turn-live",
  text: "--help & echo unsafe\n补充要求", requestId: "control-request-0001", deviceId: "phone",
};
const mutations = runtime => runtime.calls.filter(c => c.method.startsWith("turn/"));

test("owned runtime steering targets the expected active turn without queueing or changing settings", async t => {
  const {controls, runtime} = setup(t);
  controls.attach("chat", runtime);
  const state = await controls.status("chat");
  assert.equal(state.canInterrupt, true);
  assert.equal(state.canSteer, true);
  assert.equal(state.turnId, "turn-live");
  const result = await controls.act(steer);
  assert.deepEqual(result, {status: "steered", turnId: "turn-live", requestId: steer.requestId});
  assert.deepEqual(mutations(runtime), [{
    method: "turn/steer", params: {
      threadId: "chat", expectedTurnId: "turn-live",
      input: [{type: "text", text: steer.text, text_elements: []}],
      clientUserMessageId: steer.requestId,
    },
  }]);
  assert.equal(runtime.calls.some(c => /resume|queue\/(?:add|start|update|delete|reorder)|settings|turn\/start/.test(c.method)), false);
  assert.equal(runtime.closes, 0);
});

test("stale turns, idle threads and malformed controls cannot mutate a runtime", async t => {
  const {controls, runtime} = setup(t);
  controls.attach("chat", runtime);
  for (const patch of [{turnId: "old-turn"}, {requestId: "short"}, {text: "  "}, {action: "other"}, {deviceId: ""}])
    await assert.rejects(controls.act({...steer, ...patch}), e => e.notSubmitted === true);
  runtime.state = "idle";
  await assert.rejects(controls.act(steer), e => e.notSubmitted === true && e.statusCode === 409);
  assert.equal(mutations(runtime).length, 0);
});

test("a non-steerable running turn may still be interrupted", async t => {
  const {controls, runtime} = setup(t);
  controls.attach("chat", runtime);
  runtime.acceptInput = false;
  const state = await controls.status("chat");
  assert.equal(state.canSteer, false);
  assert.equal(state.canInterrupt, true);
  await assert.rejects(controls.act(steer), e => e.notSubmitted === true);
  const result = await controls.act({...steer, action: "interrupt", requestId: "interrupt-request-001"});
  assert.equal(result.status, "interrupted");
  assert.deepEqual(mutations(runtime).map(c => c.method), ["turn/interrupt"]);
});

test("interrupt needs a matching interrupted notification; an RPC ack alone is only requested", async t => {
  const {controls, runtime} = setup(t);
  controls.attach("chat", runtime);
  runtime.omitCompletion = true;
  const pending = controls.act({...steer, action: "interrupt"});
  await new Promise(resolve => setImmediate(resolve));
  runtime.emit("notification", "turn/completed", {threadId: "other", turn: {id: "turn-live", status: "interrupted"}});
  runtime.emit("notification", "turn/completed", {threadId: "chat", turn: {id: "old", status: "interrupted"}});
  assert.equal((await pending).status, "interruptRequested");
  assert.equal(runtime.closes, 0);
});

test("an interrupted event remains authoritative when its owner closes before the interrupt response", async t => {
  const {controls, runtime} = setup(t);
  controls.attach("chat", runtime);
  runtime.closeOnInterrupt = true;
  assert.equal((await controls.act({...steer, action: "interrupt"})).status, "interrupted");
});

test("duplicate controls replay their receipt, including after service restart, and never persist prompt text", async t => {
  const {controls, runtime, dir, store} = setup(t);
  controls.attach("chat", runtime);
  const [first, duplicate] = await Promise.all([controls.act(steer), controls.act(steer)]);
  assert.deepEqual(first, duplicate);
  assert.equal(mutations(runtime).length, 1);
  await assert.rejects(controls.act({...steer, text: "different"}), e => e.statusCode === 409);
  const restarted = new TurnControls({store, dataDir: dir, sharedFactory: () => { throw new Error("must not connect"); }});
  t.after(() => restarted.stop());
  assert.deepEqual(await restarted.act(steer), first);
  assert.equal(readFileSync(join(dir, "control-outbox.json"), "utf8").includes(steer.text), false);
});

test("a response-lost or malformed steering receipt becomes unknown and cannot be automatically dispatched again", async t => {
  const {controls, runtime, dir, store} = setup(t);
  controls.attach("chat", runtime);
  runtime.badReceipt = true;
  await assert.rejects(controls.act(steer), e => e.controlUnknown === true && e.notSubmitted !== true);
  await assert.rejects(controls.act(steer), e => e.controlUnknown === true);
  const restarted = new TurnControls({store, dataDir: dir});
  t.after(() => restarted.stop());
  await assert.rejects(restarted.act(steer), e => e.controlUnknown === true);
  assert.equal(mutations(runtime).length, 1);
});

test("an RPC error after dispatch stays uncertain and does not expose provider diagnostics", async t => {
  const {controls, runtime} = setup(t);
  controls.attach("chat", runtime);
  runtime.failControl = Object.assign(new Error("PRIVATE provider credential"), {code: -32000});
  await assert.rejects(controls.act(steer), e =>
    e.controlUnknown === true && e.notSubmitted !== true && !e.message.includes("PRIVATE"));
  await assert.rejects(controls.act(steer), e => e.controlUnknown === true);
  assert.equal(mutations(runtime).length, 1);
});

test("shared-channel failure is unavailable, backs off, and never attempts to resume a desktop writer", async t => {
  let opens = 0;
  const {controls} = setup(t, {sharedFactory: () => { opens++; throw new Error("PRIVATE daemon token"); }});
  const state = await controls.status("chat");
  assert.equal(state.available, false);
  assert.equal(state.canInterrupt, false);
  assert.equal(JSON.stringify(state).includes("PRIVATE"), false);
  await controls.status("chat");
  await assert.rejects(controls.act(steer), e => e.notSubmitted === true);
  assert.equal(opens, 1);
});

test("a connected shared runtime is read without taking ownership and is closed only as a proxy", async t => {
  const runtime = new Runtime();
  const {controls} = setup(t, {sharedFactory: () => runtime});
  const state = await controls.status("chat");
  assert.equal(state.source, "shared");
  assert.equal((await controls.act(steer)).status, "steered");
  assert.equal(runtime.calls.some(c => /resume|thread\/start|queue\/(?:add|start|update|delete|reorder)/.test(c.method)), false);
  assert.deepEqual(runtime.calls.find(c => c.method === "thread/turns/list").params,
    {threadId: "chat", limit: 1, sortDirection: "desc", itemsView: "notLoaded"});
  await controls.stop();
  assert.equal(runtime.closes, 1);
});

test("stopping the control service does not close a locally owned executing runtime", async t => {
  const {controls, runtime} = setup(t);
  controls.attach("chat", runtime);
  await controls.stop();
  assert.equal(runtime.closes, 0);
  await assert.rejects(controls.act(steer), e => e.notSubmitted === true && e.statusCode === 503);
});

test("shared stored threads without a loaded runtime cannot be interrupted or resumed", async t => {
  const runtime = new Runtime();
  runtime.state = "notLoaded";
  runtime.acceptInput = null;
  const {controls} = setup(t, {sharedFactory: () => runtime});
  assert.equal((await controls.status("chat")).available, false);
  await assert.rejects(controls.act({...steer, action: "interrupt"}), e => e.notSubmitted === true);
  assert.equal(mutations(runtime).length, 0);
  assert.equal(runtime.calls.some(c => c.method === "thread/resume"), false);
});

test("shutdown while checking the runtime prevents a late control dispatch", async t => {
  const {controls, runtime} = setup(t);
  controls.attach("chat", runtime);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const request = runtime.request.bind(runtime);
  runtime.request = (method, params) => {
    if (method === "thread/read") { enter(); return response; }
    return request(method, params);
  };
  const pending = controls.act(steer);
  await entered;
  const stopped = controls.stop();
  release({thread: {id: "chat", status: {type: "active"}, canAcceptDirectInput: true}});
  await assert.rejects(pending, e => e.notSubmitted === true && e.statusCode === 503);
  await stopped;
  assert.equal(mutations(runtime).length, 0);
  assert.equal(runtime.closes, 0);
});

test("a delayed interruption remains observable after the owner closes and upgrades only its own durable receipt", async t => {
  const {controls, runtime, dir, store} = setup(t);
  controls.attach("chat", runtime);
  runtime.omitCompletion = true;
  const request = {...steer, action: "interrupt"};
  assert.equal((await controls.act(request)).status, "interruptRequested");
  runtime.state = "idle";
  runtime.emit("notification", "turn/completed", {
    threadId: "chat", turn: {id: "turn-live", status: "interrupted"},
  });
  await runtime.close();
  const state = await controls.status("chat");
  assert.deepEqual(state.lastTurn, {id: "turn-live", status: "interrupted"});
  assert.equal(state.canInterrupt, false);
  assert.equal((await controls.act(request)).status, "interrupted");
  const restarted = new TurnControls({store, dataDir: dir});
  t.after(() => restarted.stop());
  assert.equal((await restarted.act(request)).status, "interrupted");
  assert.equal(mutations(runtime).length, 1);
});

test("shared idle-turn reads reconcile a delayed interruption even without a broadcast notification", async t => {
  const runtime = new Runtime();
  runtime.omitCompletion = true;
  const {controls} = setup(t, {sharedFactory: () => runtime});
  const request = {...steer, action: "interrupt"};
  assert.equal((await controls.act(request)).status, "interruptRequested");
  runtime.state = "idle";
  runtime.finishedStatus = "interrupted";
  const state = await controls.status("chat");
  assert.equal(state.state, "idle");
  assert.deepEqual(state.lastTurn, {id: "turn-live", status: "interrupted"});
  assert.equal((await controls.act(request)).status, "interrupted");
  assert.equal(mutations(runtime).length, 1);
});

test("matching interrupted notification upgrades a still-sending interrupt before its RPC settles", async t => {
  const {controls, runtime} = setup(t);
  controls.attach("chat", runtime);
  let rejectRpc;
  const gate = new Promise((_, reject) => { rejectRpc = reject; });
  const request = runtime.request.bind(runtime);
  runtime.request = (method, params) => {
    if (method === "turn/interrupt") return gate;
    return request(method, params);
  };
  const pending = controls.act({...steer, action: "interrupt"});
  await new Promise(resolve => setImmediate(resolve));
  runtime.emit("notification", "turn/completed", {
    threadId: "chat", turn: {id: "turn-live", status: "interrupted"},
  });
  rejectRpc(new Error("late response lost"));
  assert.equal((await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error("not settled")), 100)),
  ])).status, "interrupted");
});

function pausedQueue(t, options = {}) {
  const context = setup(t, options);
  context.runtime.state = "idle";
  context.runtime.queued = [
    {id: "queued-one", clientUserMessageId: "first", input: [{type: "text", text: "PRIVATE queued instruction"}]},
    {id: "queued-two", clientUserMessageId: "second", input: [{type: "text", text: "next instruction"}]},
  ];
  context.store.pendingCount = () => context.runtime.queued.length;
  context.controls.attach("chat", context.runtime);
  return context;
}
const resumeQueue = {
  action: "resumeQueue", threadId: "chat", queuedSubmissionId: "queued-one",
  requestId: "resume-queue-request-001", deviceId: "phone",
};
const queueStarts = runtime => runtime.calls.filter(c => c.method === "thread/queue/start");

test("idle queued work exposes its verified head and a separate resume capability without leaking input", async t => {
  const {controls} = pausedQueue(t);
  const state = await controls.status("chat");
  assert.equal(state.canSteer, false);
  assert.equal(state.queue.available, true);
  assert.equal(state.queue.pending, true);
  assert.equal(state.queue.count, 2);
  assert.equal(state.queue.headId, "queued-one");
  assert.equal(state.queue.canResume, true);
  assert.equal(JSON.stringify(state).includes("PRIVATE"), false);
});

test("resuming starts the captured queued item, never sends another continue message or steers", async t => {
  const {controls, runtime} = pausedQueue(t);
  const result = await controls.act(resumeQueue);
  assert.deepEqual(result, {
    status: "queueStarted", requestId: resumeQueue.requestId, queuedSubmissionId: "queued-one",
    turnId: "resumed-turn", turnStatus: "inProgress",
  });
  assert.deepEqual(queueStarts(runtime), [{
    method: "thread/queue/start", params: {threadId: "chat", queuedSubmissionId: "queued-one"},
  }]);
  assert.equal(mutations(runtime).length, 0);
  assert.equal(runtime.calls.some(c => /thread\/resume|queue\/add|settings/.test(c.method)), false);
  assert.equal(runtime.queued[0].id, "queued-two");
});

test("active work, an empty queue, a changed head and malformed resume payloads cannot start a queued item", async t => {
  const {controls, runtime} = pausedQueue(t);
  for (const patch of [{queuedSubmissionId: "old-head"}, {queuedSubmissionId: ""},
    {requestId: "short"}, {text: "继续"}, {turnId: "wrong-turn"}])
    await assert.rejects(controls.act({...resumeQueue, ...patch}), e => e.notSubmitted === true);
  runtime.state = "active";
  assert.equal((await controls.status("chat")).queue.canResume, false);
  await assert.rejects(controls.act(resumeQueue), e => e.notSubmitted === true);
  runtime.state = "idle"; runtime.queued = [];
  assert.equal((await controls.status("chat")).queue.pending, false);
  await assert.rejects(controls.act(resumeQueue), e => e.notSubmitted === true);
  assert.equal(queueStarts(runtime).length, 0);
});

test("a resume receipt replays across restart and duplicate clicks cannot consume the next item", async t => {
  const {controls, runtime, dir, store} = pausedQueue(t);
  const [first, second] = await Promise.all([controls.act(resumeQueue), controls.act(resumeQueue)]);
  assert.deepEqual(second, first);
  const restarted = new TurnControls({store, dataDir: dir});
  t.after(() => restarted.stop());
  assert.deepEqual(await restarted.act(resumeQueue), first);
  await assert.rejects(controls.act({...resumeQueue, queuedSubmissionId: "queued-two"}), e => e.notSubmitted === true);
  assert.equal(queueStarts(runtime).length, 1);
  assert.equal(runtime.queued[0].id, "queued-two");
});

test("a lost or malformed resume confirmation stays unknown without advancing to a later head", async t => {
  const {controls, runtime, dir, store} = pausedQueue(t);
  runtime.badQueueReceipt = true;
  await assert.rejects(controls.act(resumeQueue), e => e.controlUnknown === true);
  await assert.rejects(controls.act(resumeQueue), e => e.controlUnknown === true);
  const restarted = new TurnControls({store, dataDir: dir});
  t.after(() => restarted.stop());
  await assert.rejects(restarted.act(resumeQueue), e => e.controlUnknown === true);
  assert.equal(queueStarts(runtime).length, 1);
  assert.equal(runtime.queued[0].id, "queued-two");
});

test("failed or already-finished started turns return their actual turn status, not a fake running state", async t => {
  const {controls, runtime} = pausedQueue(t);
  runtime.resumeStatus = "failed";
  const result = await controls.act(resumeQueue);
  assert.equal(result.status, "queueStarted");
  assert.equal(result.turnStatus, "failed");
  assert.equal(queueStarts(runtime).length, 1);
});

test("an inaccessible desktop queue reports pending count but never takes over its writer to resume", async t => {
  const {controls, store} = setup(t);
  store.pendingCount = () => 4;
  const state = await controls.status("chat");
  assert.equal(state.queue.count, 4);
  assert.equal(state.queue.pending, true);
  assert.equal(state.queue.canResume, false);
  assert.match(state.queue.reason, /通道|连接/);
  await assert.rejects(controls.act(resumeQueue), e => e.notSubmitted === true);
});

test("queue metadata failure does not disable existing current-turn control", async t => {
  const {controls, runtime, store} = pausedQueue(t);
  runtime.state = "active";
  const request = runtime.request.bind(runtime);
  runtime.request = (method, params) => method === "thread/queue/list"
    ? Promise.reject(new Error("PRIVATE queue read failed")) : request(method, params);
  store.pendingCount = () => 2;
  const state = await controls.status("chat");
  assert.equal(state.canSteer, true);
  assert.equal(state.queue.available, false);
  assert.equal(state.queue.count, 2);
  assert.equal(state.queue.canResume, false);
  assert.equal(JSON.stringify(state).includes("PRIVATE"), false);
});

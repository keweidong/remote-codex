import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { createApiClient } from "../public/api-client.js";
import { SubmissionTracker } from "../public/submissions.js";

function mobile(fetchImpl, storage = new Map()) {
  const nodes = new Map(), timers = new Map(), confirmations = [];
  const makeNode = () => {
    const classes = new Set();
    return {
      value: "", textContent: "", disabled: false, open: false, children: [], style: {}, scrollHeight: 46,
      attributes: {},
      classList: {
        add: (...xs) => xs.forEach(x => classes.add(x)),
        remove: (...xs) => xs.forEach(x => classes.delete(x)),
        contains: x => classes.has(x),
        toggle(x, on) { if (on ?? !classes.has(x)) classes.add(x); else classes.delete(x); },
      },
      replaceChildren(...xs) { this.children = xs; },
      append(...xs) { this.children.push(...xs); },
      after() {}, focus() {}, replaceWith() {},
      setAttribute(k, v) { this.attributes[k] = v; },
      showModal() { this.open = true; }, close() { this.open = false; },
    };
  };
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, makeNode());
    return nodes.get(id);
  };
  let confirmed = true;
  const context = vm.createContext({
    createApiClient, SubmissionTracker,
    document: {
      getElementById: get, createElement: makeNode, createElementNS: makeNode,
      body: makeNode(), hidden: false, addEventListener() {},
    },
    sessionStorage: {
      getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k),
    },
    location: {hash: "", pathname: "/"}, URLSearchParams, crypto: webcrypto,
    Option: function(text, value) { return {text, value}; },
    fetch: fetchImpl, setInterval(fn, delay) { timers.set(delay, fn); }, setTimeout() {}, clearTimeout() {},
    confirm(message) { confirmations.push(message); return confirmed; },
  });
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace(/boot\(\);\s*$/, "");
  vm.runInContext(source, context);
  return {
    get, storage, timers, confirmations,
    confirm(value) { confirmed = value; },
    run: source => vm.runInContext(source, context),
    async select(id = "one") {
      vm.runInContext(`selectThread(${JSON.stringify(id)})`, context);
      await vm.runInContext("loadChat()", context);
      await new Promise(setImmediate);
    },
  };
}

const active = (turnId = "turn-one", overrides = {}) => ({
  available: true, source: "mobile", state: "inProgress", turnId,
  canInterrupt: true, canSteer: true, reason: "", ...overrides,
});
const unavailable = {
  available: false, source: null, state: "unavailable", turnId: null,
  canInterrupt: false, canSteer: false, reason: "桌面会话没有共享控制通道",
};
const catalog = {
  defaultModel: "model-a", defaultEffort: "medium",
  models: [{id: "model-a", name: "Model A", defaultEffort: "medium",
    efforts: [{id: "medium", label: "Medium"}, {id: "high", label: "High"}]}],
};
function fixture() {
  const requests = [], reads = [];
  let control = active(), post;
  return {
    requests, reads,
    status(value) { control = value; },
    onPost(fn) { post = fn; },
    async fetch(path, options = {}) {
      if (options.method === "POST") {
        const body = JSON.parse(options.body);
        requests.push({path, body});
        if (post) return post(path, body);
        return Response.json(path.endsWith("/steer")
          ? {status: "steered", requestId: body.requestId, turnId: body.turnId}
          : path.endsWith("/interrupt")
            ? {status: "interruptRequested", requestId: body.requestId, turnId: body.turnId}
            : {status: "queued", messageId: "queued-message"});
      }
      if (path.endsWith("/control")) {
        reads.push(path);
        return Response.json(control);
      }
      if (path === "/api/models") return Response.json(catalog);
      return Response.json({
        thread: {title: path.split("/").at(-1), projectName: "项目", model: "model-a"},
        messages: [{id: "history", ordinal: 1, role: "assistant", text: "history ready"}],
        status: "inProgress", hasMore: false,
      });
    },
  };
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};

test("queue is default; steering has only text, requestId and captured turnId and retains queue settings", async () => {
  const f = fixture(), ui = mobile(f.fetch);
  await ui.run("loadModels()");
  await ui.select();
  assert.equal(ui.get("queue-mode").attributes["aria-pressed"], "true");
  ui.get("model-select").value = "model-a"; ui.get("model-select").onchange();
  ui.get("effort-select").value = "high"; ui.get("effort-select").onchange();
  await ui.run('send("queued")');
  assert.equal(f.requests[0].path, "/api/threads/one/messages");
  assert.equal(f.requests[0].body.model, "model-a");
  assert.equal(f.requests[0].body.effort, "high");
  ui.get("steer-mode").onclick();
  assert.equal(ui.get("model-select").disabled, true);
  assert.equal(ui.get("effort-select").disabled, true);
  ui.get("message-input").value = "change direction";
  await ui.run('send("change direction")');
  assert.equal(f.requests[1].path, "/api/threads/one/steer");
  assert.deepEqual(Object.keys(f.requests[1].body).sort(), ["requestId", "text", "turnId"]);
  assert.equal(f.requests[1].body.turnId, "turn-one");
  assert.equal(f.requests[1].body.text, "change direction");
  assert.equal(ui.get("message-input").value, "");
  ui.get("queue-mode").onclick();
  assert.equal(ui.get("model-select").disabled, false);
  assert.equal(ui.get("effort-select").value, "high");
});

test("unavailable steering and stale turn never fall back to queue or lose draft", async () => {
  for (const next of [unavailable, active("turn-two"), active(null, {state: "idle", canSteer: false, canInterrupt: false})]) {
    const f = fixture(), ui = mobile(f.fetch);
    await ui.select();
    ui.get("steer-mode").onclick();
    ui.get("message-input").value = "retain";
    f.status(next);
    await ui.run('send("retain")');
    assert.equal(f.requests.length, 0);
    assert.equal(ui.get("message-input").value, "retain");
    assert.equal(ui.get("steer-mode").attributes["aria-pressed"], "true");
    if (!next.canSteer) assert.equal(ui.get("send").disabled, true);
  }
});

test("unsupported desktop control explains the reason while normal queue remains available", async () => {
  const f = fixture(); f.status(unavailable);
  const ui = mobile(f.fetch);
  await ui.select();
  assert.equal(ui.get("steer-mode").disabled, true);
  assert.equal(ui.get("interrupt-turn").disabled, true);
  assert.equal(ui.get("interrupt-turn").classList.contains("hidden"), false);
  assert.match(ui.get("chat-notice").textContent, /共享控制通道/);
  assert.match(ui.get("steer-mode").title, /共享控制通道/);
  assert.equal(ui.get("send").disabled, false);
  await ui.run('send("queue still works")');
  assert.equal(f.requests[0].path, "/api/threads/one/messages");
});

test("unknown steering reload restores draft and retries original request and turn, never queue", async () => {
  const f = fixture(); f.onPost(() => { throw new Error("connection lost"); });
  const first = mobile(f.fetch); await first.select();
  first.get("steer-mode").onclick();
  first.get("message-input").value = "uncertain direction";
  await first.run('send("uncertain direction")');
  assert.equal(first.get("message-input").value, "uncertain direction");
  assert.match(first.get("chat-notice").textContent, /未确认/);
  assert.equal(JSON.parse(first.storage.get("codex-pocket-controls"))[0].action, "steer");
  f.status(active("later-turn"));
  const reload = mobile(f.fetch, first.storage); await reload.select();
  assert.equal(reload.get("message-input").value, "uncertain direction");
  assert.equal(reload.get("steer-mode").attributes["aria-pressed"], "true");
  await reload.run('send("uncertain direction")');
  assert.equal(f.requests[1].path, "/api/threads/one/steer");
  assert.equal(f.requests[1].body.requestId, f.requests[0].body.requestId);
  assert.equal(f.requests[1].body.turnId, "turn-one");
});

test("known pre-dispatch reject forgets the identity but keeps steering draft", async () => {
  const f = fixture();
  f.onPost(() => Response.json({error: "本轮不可插话", notSubmitted: true}, {status: 409}));
  const ui = mobile(f.fetch); await ui.select(); ui.get("steer-mode").onclick();
  ui.get("message-input").value = "keep me";
  await ui.run('send("keep me")');
  assert.equal(ui.get("message-input").value, "keep me");
  assert.deepEqual(JSON.parse(ui.storage.get("codex-pocket-controls")), []);
  assert.match(ui.get("chat-notice").textContent, /不可插话/);
});

test("interrupt cancellation sends nothing; request acceptance is not labelled stopped and preserves draft", async () => {
  const f = fixture(), ui = mobile(f.fetch); await ui.select();
  ui.get("message-input").value = "typed draft";
  ui.confirm(false);
  await ui.get("interrupt-turn").onclick();
  assert.equal(f.requests.length, 0);
  assert.match(ui.confirmations[0], /当前|本轮/);
  assert.match(ui.confirmations[0], /队列|排队/);
  ui.confirm(true);
  await ui.get("interrupt-turn").onclick();
  assert.equal(f.requests[0].path, "/api/threads/one/interrupt");
  assert.deepEqual(Object.keys(f.requests[0].body).sort(), ["requestId", "turnId"]);
  assert.equal(f.requests[0].body.turnId, "turn-one");
  assert.equal(ui.get("message-input").value, "typed draft");
  assert.match(ui.get("chat-notice").textContent, /已请求|等待.*确认/);
  assert.doesNotMatch(ui.get("chat-notice").textContent, /已停止|已中断/);
  await ui.get("interrupt-turn").onclick();
  assert.equal(f.requests.length, 1, "accepted stop cannot be repeatedly dispatched");
});

test("only confirmed interruption is shown as stopped", async () => {
  const f = fixture();
  f.onPost((path, body) => Response.json({status: "interrupted", requestId: body.requestId, turnId: body.turnId}));
  const ui = mobile(f.fetch); await ui.select();
  await ui.get("interrupt-turn").onclick();
  assert.match(ui.get("chat-notice").textContent, /已中断|已停止/);
});

test("unknown interrupt retains request and typed draft across reload", async () => {
  const f = fixture(); f.onPost(() => { throw new Error("lost"); });
  const first = mobile(f.fetch); await first.select();
  first.get("message-input").value = "not part of interrupt";
  await first.get("interrupt-turn").onclick();
  const reload = mobile(f.fetch, first.storage); await reload.select();
  assert.equal(reload.get("message-input").value, "not part of interrupt");
  await reload.get("interrupt-turn").onclick();
  assert.equal(f.requests[1].body.requestId, f.requests[0].body.requestId);
  assert.equal(f.requests[1].body.turnId, f.requests[0].body.turnId);
});

test("slow control does not block history; concurrent reads coalesce and old chat results cannot update new chat", async () => {
  const f = fixture(), slow = deferred();
  let reads = 0;
  const ui = mobile((path, options) => {
    if (path === "/api/threads/one/control") { reads++; return slow.promise; }
    if (path === "/api/threads/two/control") return Promise.resolve(Response.json(unavailable));
    return f.fetch(path, options);
  });
  ui.run('selectThread("one")');
  await ui.run("loadChat()");
  assert.equal(ui.get("messages").children[0].children[1].children[0].textContent, "history ready");
  const again = ui.run("refreshControl()");
  assert.equal(reads, 1);
  await ui.select("two");
  slow.resolve(Response.json(active()));
  await again;
  assert.equal(ui.get("steer-mode").disabled, true);
  assert.match(ui.get("steer-mode").title, /共享控制通道/);
  assert.equal(ui.get("interrupt-turn").disabled, true);
});

test("switching chats during steering preserves both drafts and does not update the other chat notice", async () => {
  const f = fixture(), slow = deferred(); f.onPost(() => slow.promise);
  const ui = mobile(f.fetch); await ui.select();
  ui.get("steer-mode").onclick(); ui.get("message-input").value = "sent draft";
  const send = ui.run('send("sent draft")');
  await new Promise(setImmediate);
  await ui.select("two"); ui.get("message-input").value = "other draft";
  const notice = ui.get("chat-notice").textContent;
  slow.resolve(Response.json({status: "steered", requestId: f.requests[0].body.requestId, turnId: "turn-one"}));
  await send;
  assert.equal(ui.get("message-input").value, "other draft");
  assert.equal(ui.get("chat-notice").textContent, notice);
  await ui.select("one");
  assert.equal(ui.get("message-input").value, "");
});

test("new edits made while steering is in flight survive its acknowledgment", async () => {
  const f = fixture(), slow = deferred(); f.onPost(() => slow.promise);
  const ui = mobile(f.fetch); await ui.select();
  ui.get("steer-mode").onclick(); ui.get("message-input").value = "sent";
  const send = ui.run('send("sent")');
  await new Promise(setImmediate);
  ui.get("message-input").value = "new text";
  slow.resolve(Response.json({status: "steered", requestId: f.requests[0].body.requestId, turnId: "turn-one"}));
  await send;
  assert.equal(ui.get("message-input").value, "new text");
});

test("a refreshed control check cannot send to a chat selected while it was awaiting", async () => {
  const f = fixture(), slow = deferred();
  let block = false;
  const ui = mobile((path, options) => block && path === "/api/threads/one/control"
    ? slow.promise : f.fetch(path, options));
  await ui.select(); ui.get("steer-mode").onclick(); ui.get("message-input").value = "retain";
  block = true;
  const send = ui.run('send("retain")');
  await ui.select("two");
  slow.resolve(Response.json(active()));
  await send;
  assert.equal(f.requests.length, 0);
  await ui.select("one");
  assert.equal(ui.get("message-input").value, "retain");
});

test("visible control polling refreshes capabilities without resetting steering mode", async () => {
  const f = fixture(), ui = mobile(f.fetch); await ui.select();
  ui.get("steer-mode").onclick();
  f.status(active(null, {state: "idle", canInterrupt: false, canSteer: false}));
  await ui.timers.get(5000)();
  assert.equal(ui.get("send").disabled, true);
  assert.equal(ui.get("steer-mode").attributes["aria-pressed"], "true");
  assert.equal(ui.get("continue").disabled, true);
});

test("non-steerable active work can still be interrupted without enabling steering", async () => {
  const f = fixture(); f.status(active("tool-turn", {canSteer: false}));
  const ui = mobile(f.fetch); await ui.select();
  assert.equal(ui.get("steer-mode").disabled, true);
  assert.equal(ui.get("interrupt-turn").disabled, false);
  await ui.get("interrupt-turn").onclick();
  assert.equal(f.requests[0].body.turnId, "tool-turn");
});

test("interrupt rechecks its captured turn and repeated clicks cannot dispatch twice", async () => {
  const f = fixture(), ui = mobile(f.fetch); await ui.select();
  f.status(active("new-turn"));
  await ui.get("interrupt-turn").onclick();
  assert.equal(f.requests.length, 0);
  const slow = deferred(); f.onPost(() => slow.promise);
  const stop = ui.get("interrupt-turn").onclick();
  await new Promise(setImmediate);
  await ui.get("interrupt-turn").onclick();
  assert.equal(f.requests.length, 1);
  slow.resolve(Response.json({status: "interruptRequested",
    requestId: f.requests[0].body.requestId, turnId: "new-turn"}));
  await stop;
});

test("control read failure is unavailable and cannot block queue or erase history", async () => {
  const f = fixture(), ui = mobile((path, options) => {
    if (path.endsWith("/control")) throw new Error("no channel");
    return f.fetch(path, options);
  });
  await ui.select();
  assert.equal(ui.get("steer-mode").disabled, true);
  assert.equal(ui.get("send").disabled, false);
  assert.equal(ui.get("messages").children[0].children[1].children[0].textContent, "history ready");
  await ui.run('send("queue after control failure")');
  assert.equal(f.requests[0].path, "/api/threads/one/messages");
});

test("unknown controls restore the newest draft and queue preferences without rewriting their original request", async () => {
  const f = fixture(); f.onPost(() => { throw new Error("lost"); });
  const first = mobile(f.fetch); await first.run("loadModels()"); await first.select();
  first.get("model-select").value = "model-a"; first.get("model-select").onchange();
  first.get("effort-select").value = "high"; first.get("effort-select").onchange();
  first.get("steer-mode").onclick();
  first.get("message-input").value = "original";
  await first.run('send("original")');
  first.get("message-input").value = "newer draft"; first.get("message-input").oninput();
  const reload = mobile(f.fetch, first.storage); await reload.run("loadModels()"); await reload.select();
  assert.equal(reload.get("message-input").value, "newer draft");
  reload.get("queue-mode").onclick();
  assert.equal(reload.get("effort-select").value, "high");
  assert.equal(JSON.parse(first.storage.get("codex-pocket-controls"))[0].text, "original");
  reload.get("steer-mode").onclick(); reload.get("message-input").value = "original";
  await reload.run('send("original")');
  assert.equal(f.requests[1].body.requestId, f.requests[0].body.requestId);
});

test("mismatched control acknowledgments cannot clear drafts or their unresolved identity", async () => {
  const f = fixture();
  f.onPost(() => Response.json({status: "steered", requestId: "wrong-request", turnId: "wrong-turn"}));
  const ui = mobile(f.fetch); await ui.select(); ui.get("steer-mode").onclick();
  ui.get("message-input").value = "retain mismatched";
  await ui.run('send("retain mismatched")');
  assert.equal(ui.get("message-input").value, "retain mismatched");
  assert.equal(JSON.parse(ui.storage.get("codex-pocket-controls")).length, 1);
  assert.match(ui.get("chat-notice").textContent, /未确认/);
});

test("unknown interrupt reload retains an explicitly selected steering mode", async () => {
  const f = fixture(); f.onPost(() => { throw new Error("lost"); });
  const first = mobile(f.fetch); await first.select();
  first.get("steer-mode").onclick();
  first.get("message-input").value = "steering draft";
  await first.get("interrupt-turn").onclick();
  const reload = mobile(f.fetch, first.storage); await reload.select();
  assert.equal(reload.get("steer-mode").attributes["aria-pressed"], "true");
  assert.equal(reload.get("message-input").value, "steering draft");
});

test("pairing authorization includes eligible running-turn control", () => {
  const ui = mobile(fixture().fetch);
  ui.run('grant = "mock-grant"; pairScreen()');
  assert.match(ui.get("pair-description").textContent, /支持.*执行中|可控制.*执行中/);
  assert.match(ui.get("pair-description").textContent, /插话|控制/);
});

for (const [label, state] of [
  ["idle", active(null, {state: "idle", canSteer: false, canInterrupt: false})],
  ["unavailable", unavailable],
]) {
  test(`unknown steering can manually recover its original receipt while ${label}, only for matching text`, async () => {
    const f = fixture(); f.onPost(() => { throw new Error("lost receipt"); });
    const first = mobile(f.fetch); await first.select();
    first.get("steer-mode").onclick(); first.get("message-input").value = "original steer";
    await first.run('send("original steer")');
    f.status(state);
    const reload = mobile(f.fetch, first.storage); await reload.select();
    assert.equal(reload.get("steer-mode").attributes["aria-pressed"], "true");
    assert.equal(reload.get("send").disabled, false);
    assert.match(reload.get("send").attributes["aria-label"], /上次|核对/);
    await reload.timers.get(5000)();
    assert.equal(f.requests.length, 1, "selection and polling never auto-retry");
    reload.get("message-input").value = "different text"; reload.get("message-input").oninput();
    assert.equal(reload.get("send").disabled, true);
    await reload.run('send("different text")');
    assert.equal(f.requests.length, 1, "an unrelated draft cannot become a new steering action or queued send");
    reload.get("message-input").value = "original steer"; reload.get("message-input").oninput();
    assert.equal(reload.get("send").disabled, false);
    reload.get("queue-mode").onclick();
    reload.get("steer-mode").onclick();
    assert.equal(reload.get("steer-mode").attributes["aria-pressed"], "true");
    f.onPost((path, body) => Response.json({status: "steered", requestId: body.requestId, turnId: body.turnId}));
    await reload.run('send("original steer")');
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.requests[1], f.requests[0]);
    assert.equal(reload.get("message-input").value, "");
    assert.equal(reload.get("send").disabled, true, "receipt recovery does not grant live steering capability");
    assert.equal(reload.get("steer-mode").attributes["aria-pressed"], "true");
    assert.match(reload.get("chat-notice").textContent, /上次|原轮次/);
  });

  test(`unknown interrupt remains an explicitly confirmed original-request check while ${label}`, async () => {
    const f = fixture(); f.onPost(() => { throw new Error("lost receipt"); });
    const first = mobile(f.fetch); await first.select();
    first.get("message-input").value = "retained interrupt draft";
    await first.get("interrupt-turn").onclick();
    f.status(state);
    const reload = mobile(f.fetch, first.storage); await reload.select();
    assert.equal(reload.get("interrupt-turn").classList.contains("hidden"), false);
    assert.equal(reload.get("interrupt-turn").disabled, false);
    assert.match(reload.get("interrupt-turn").attributes["aria-label"], /核对.*上次|上次.*核对/);
    assert.equal(reload.get("message-input").value, "retained interrupt draft");
    await reload.timers.get(5000)();
    assert.equal(f.requests.length, 1);
    reload.confirm(false);
    await reload.get("interrupt-turn").onclick();
    assert.equal(f.requests.length, 1);
    assert.match(reload.confirmations[0], /上次|原请求/);
    assert.match(reload.confirmations[0], /原轮次/);
    assert.match(reload.confirmations[0], /排队消息不会被删除/);
    f.onPost((path, body) => Response.json({status: "interrupted", requestId: body.requestId, turnId: body.turnId}));
    reload.confirm(true);
    await reload.get("interrupt-turn").onclick();
    assert.deepEqual(f.requests[1], f.requests[0]);
    assert.equal(reload.get("message-input").value, "retained interrupt draft");
    assert.match(reload.get("chat-notice").textContent, /原轮次.*已中断/);
    assert.equal(reload.get("interrupt-turn").classList.contains("hidden"), state.state === "unavailable" ? false : true);
    assert.equal(reload.get("interrupt-turn").disabled, true);
  });
}

for (const status of ["interrupted", "completed", "failed"]) {
  test(`accepted interrupt reconciles a verified matching ${status} completion without changing the active turn`, async () => {
    const f = fixture(), ui = mobile(f.fetch); await ui.select();
    ui.get("message-input").value = "keep this draft";
    await ui.get("interrupt-turn").onclick();
    assert.match(ui.get("chat-notice").textContent, /等待.*确认/);
    f.status(active("new-running-turn", {lastTurn: {id: "turn-one", status}}));
    await ui.run("refreshControl()");
    const notice = ui.get("chat-notice").textContent;
    if (status === "interrupted") assert.match(notice, /原轮次.*已中断/);
    else {
      assert.match(notice, /原轮次.*已结束/);
      assert.doesNotMatch(notice, /已中断|已停止/);
      assert.match(notice, status === "completed" ? /完成/ : /失败/);
    }
    assert.doesNotMatch(notice, /当前轮次已中断/);
    assert.equal(ui.get("interrupt-turn").disabled, false, "a different active turn remains independently controllable");
    assert.equal(ui.get("message-input").value, "keep this draft");
    assert.equal(f.requests.length, 1, "reconciliation does not dispatch another action");
    ui.get("message-input").value = "queued after reconciliation";
    await ui.run('send("queued after reconciliation")');
    const queueNotice = ui.get("chat-notice").textContent;
    await ui.run("refreshControl()");
    assert.equal(ui.get("chat-notice").textContent, queueNotice, "a settled stop cannot overwrite a later notice on each poll");
  });
}

test("stop reconciliation ignores missing, unrelated or nonterminal lastTurn data", async () => {
  const f = fixture(), ui = mobile(f.fetch); await ui.select();
  await ui.get("interrupt-turn").onclick();
  const requested = ui.get("chat-notice").textContent;
  for (const lastTurn of [undefined, {id: "other-turn", status: "interrupted"},
    {id: "turn-one", status: "inProgress"}, {status: "interrupted"}]) {
    f.status({...unavailable, lastTurn});
    await ui.run("refreshControl()");
    assert.equal(ui.get("chat-notice").textContent, requested);
  }
  f.status({...unavailable, lastTurn: {id: "turn-one", status: "interrupted"}});
  await ui.run("refreshControl()");
  assert.match(ui.get("chat-notice").textContent, /原轮次.*已中断/);
});

test("delayed stop reconciliation updates only its original chat, never the selected peer's draft or notice", async () => {
  const f = fixture(), slow = deferred();
  let delay = false;
  const ui = mobile((path, options) => delay && path === "/api/threads/one/control"
    ? slow.promise : f.fetch(path, options));
  await ui.select(); ui.get("message-input").value = "one draft";
  await ui.get("interrupt-turn").onclick();
  delay = true;
  const refresh = ui.run("refreshControl()");
  await ui.select("two"); ui.get("message-input").value = "two draft";
  const peerNotice = ui.get("chat-notice").textContent;
  slow.resolve(Response.json({...unavailable, lastTurn: {id: "turn-one", status: "interrupted"}}));
  await refresh;
  assert.equal(ui.get("chat-notice").textContent, peerNotice);
  assert.equal(ui.get("message-input").value, "two draft");
  assert.equal(ui.get("interrupt-turn").disabled, false);
  delay = false;
  await ui.select("one");
  assert.match(ui.get("chat-notice").textContent, /原轮次.*已中断/);
  assert.equal(ui.get("message-input").value, "one draft");
});

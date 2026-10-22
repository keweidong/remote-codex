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

const queue = (overrides = {}) => ({
  available: true, pending: true, count: 4, headId: "original-head",
  canResume: true, reason: "", ...overrides,
});
const idle = (overrides = {}) => ({
  available: true, source: "shared", state: "idle", turnId: null,
  canInterrupt: false, canSteer: false, reason: "", queue: queue(), ...overrides,
});
const unsupported = queue({
  available: false, headId: null, canResume: false,
  reason: "桌面独占的会话尚未接入队列控制通道，请在桌面点击继续。",
});
const receipt = body => ({
  status: "queueStarted", requestId: body.requestId, queuedSubmissionId: body.queuedSubmissionId,
  turnId: "started-turn", turnStatus: "inProgress",
});
function fixture() {
  const posts = [], reads = [];
  let state = idle(), post;
  return {
    posts, reads,
    status(value) { state = value; },
    onPost(fn) { post = fn; },
    async fetch(path, options = {}) {
      if (options.method === "POST") {
        const body = JSON.parse(options.body);
        posts.push({path, body});
        if (post) return post(path, body);
        return Response.json(path.endsWith("/queue/resume") ? receipt(body)
          : {status: "queued", messageId: "mock-message"});
      }
      if (path.endsWith("/control")) {
        reads.push(path);
        return Response.json(state);
      }
      if (path === "/api/models") return Response.json({
        defaultModel: "model-a", defaultEffort: "medium",
        models: [{id: "model-a", name: "Model A", defaultEffort: "medium",
          efforts: [{id: "medium", label: "Medium"}, {id: "high", label: "High"}]}],
      });
      return Response.json({
        thread: {title: path.split("/").at(-1), projectName: "项目", model: "model-a"},
        messages: [], status: "completed", hasMore: false,
      });
    },
  };
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};
function draft(ui, text) {
  ui.get("message-input").value = text;
  ui.get("message-input").oninput();
}

test("queue band shows count or unknown count without inventing a paused state", async () => {
  const f = fixture(), ui = mobile(f.fetch);
  await ui.select();
  assert.equal(ui.get("queue-status").classList.contains("hidden"), false);
  assert.match(ui.get("queue-summary").textContent, /4/);
  assert.doesNotMatch(ui.get("queue-summary").textContent, /暂停/);
  assert.equal(ui.get("resume-queue").disabled, false);
  f.status(idle({queue: queue({count: null})}));
  await ui.run("refreshControl()");
  assert.match(ui.get("queue-summary").textContent, /待执行/);
  assert.doesNotMatch(ui.get("queue-summary").textContent, /null|暂停/);
  assert.equal(f.posts.length, 0);
});

test("unsupported queue exposes honest visible reason, never falls back, while normal send works", async () => {
  const f = fixture(); f.status(idle({
    available: false, source: null, state: "unavailable", queue: unsupported,
  }));
  const ui = mobile(f.fetch); await ui.select();
  assert.equal(ui.get("resume-queue").disabled, true);
  assert.match(ui.get("queue-reason").textContent, /桌面独占.*桌面点击继续/);
  await ui.get("resume-queue").onclick();
  assert.equal(f.posts.length, 0);
  assert.equal(ui.get("send").disabled, false);
  await ui.run('send("ordinary queue")');
  assert.equal(f.posts[0].path, "/api/threads/one/messages");
});

test("resume confirms existing task and posts only request and original queue head without touching draft/settings/mode", async () => {
  const f = fixture(), ui = mobile(f.fetch);
  await ui.run("loadModels()"); await ui.select();
  ui.get("model-select").value = "model-a"; ui.get("model-select").onchange();
  ui.get("effort-select").value = "high"; ui.get("effort-select").onchange();
  draft(ui, "not a queue item");
  const reads = f.reads.length;
  await ui.get("resume-queue").onclick();
  assert.match(ui.confirmations[0], /已有|现有|原有/);
  assert.match(ui.confirmations[0], /不会.*继续|不.*新增/);
  assert.ok(f.reads.length > reads, "a new dispatch refreshes capabilities");
  assert.equal(f.posts[0].path, "/api/threads/one/queue/resume");
  assert.deepEqual(Object.keys(f.posts[0].body).sort(), ["queuedSubmissionId", "requestId"]);
  assert.equal(f.posts[0].body.queuedSubmissionId, "original-head");
  assert.equal(typeof f.posts[0].body.requestId, "string");
  assert.equal(ui.get("message-input").value, "not a queue item");
  assert.equal(ui.get("model-select").value, "model-a");
  assert.equal(ui.get("effort-select").value, "high");
  assert.equal(ui.get("queue-mode").attributes["aria-pressed"], "true");
  assert.match(ui.get("chat-notice").textContent, /首.*已启动|首.*开始/);
  assert.doesNotMatch(ui.get("chat-notice").textContent, /全部.*完成/);
});

test("cancel has no POST and legacy continue remains a literal message, not queue resume", async () => {
  const f = fixture(), ui = mobile(f.fetch); await ui.select();
  draft(ui, "keep on cancel"); ui.confirm(false);
  await ui.get("resume-queue").onclick();
  assert.equal(f.posts.length, 0);
  assert.equal(ui.get("message-input").value, "keep on cancel");
  await ui.get("continue").onclick();
  assert.equal(f.posts[0].path, "/api/threads/one/messages");
  assert.equal(f.posts[0].body.text, "继续");
});

for (const [name, state] of [
  ["active", idle({state: "inProgress", turnId: "running", queue: queue({canResume: false, reason: "请等待当前轮次结束。"})})],
  ["empty", idle({queue: queue({pending: false, count: 0, headId: null, canResume: false})})],
  ["missing-head", idle({queue: queue({headId: null})})],
  ["legacy-service", idle({queue: undefined})],
]) test(`${name} cannot trigger a new queue resume or fallback`, async () => {
  const f = fixture(); f.status(state);
  const ui = mobile(f.fetch); await ui.select();
  assert.equal(ui.get("resume-queue").disabled, true);
  await ui.get("resume-queue").onclick();
  assert.equal(f.posts.length, 0);
  if (name === "active") assert.match(ui.get("queue-reason").textContent, /等待/);
  if (name === "empty" || name === "legacy-service")
    assert.equal(ui.get("queue-status").classList.contains("hidden"), true);
});

test("head changed in preflight aborts and asks for fresh confirmation without losing the draft", async () => {
  const f = fixture(), ui = mobile(f.fetch); await ui.select();
  draft(ui, "retain on changed head");
  f.status(idle({queue: queue({headId: "later-head"})}));
  await ui.get("resume-queue").onclick();
  assert.equal(f.posts.length, 0);
  assert.match(ui.get("chat-notice").textContent, /变化.*确认|变化.*操作/);
  assert.equal(ui.get("message-input").value, "retain on changed head");
  await ui.get("resume-queue").onclick();
  assert.equal(f.posts[0].body.queuedSubmissionId, "later-head");
});

test("busy guard debounces clicks and shares exclusion with existing turn controls", async () => {
  const f = fixture(), slow = deferred(); f.onPost(() => slow.promise);
  const ui = mobile(f.fetch); await ui.select();
  const first = ui.get("resume-queue").onclick();
  await new Promise(setImmediate);
  assert.equal(ui.get("resume-queue").disabled, true);
  assert.equal(ui.get("send").disabled, true);
  await ui.get("resume-queue").onclick();
  await ui.get("interrupt-turn").onclick();
  assert.equal(f.posts.length, 1);
  assert.equal(ui.confirmations.length, 1);
  slow.resolve(Response.json(receipt(f.posts[0].body)));
  await first;
});

for (const [name, state] of [
  ["later-head", idle({queue: queue({headId: "later-head"})})],
  ["empty", idle({queue: queue({pending: false, count: 0, headId: null, canResume: false})})],
  ["unsupported", idle({queue: unsupported})],
]) test(`lost response reload restores draft/preferences and manually checks same IDs even with ${name}`, async () => {
  const f = fixture(); f.onPost(() => { throw new Error("lost response"); });
  const first = mobile(f.fetch); await first.run("loadModels()"); await first.select();
  first.get("model-select").value = "model-a"; first.get("model-select").onchange();
  first.get("effort-select").value = "high"; first.get("effort-select").onchange();
  draft(first, "original typed draft");
  await first.get("resume-queue").onclick();
  assert.match(first.get("chat-notice").textContent, /未确认/);
  const saved = JSON.parse(first.storage.get("codex-pocket-queue-resume"))[0];
  assert.equal(saved.queuedSubmissionId, "original-head");
  assert.equal(saved.text, "", "queue ID is not disguised as message text");
  draft(first, "newest typed draft");
  f.status(state);
  const reload = mobile(f.fetch, first.storage); await reload.run("loadModels()"); await reload.select();
  assert.equal(reload.get("message-input").value, "newest typed draft");
  assert.equal(reload.get("model-select").value, "model-a");
  assert.equal(reload.get("effort-select").value, "high");
  assert.equal(reload.get("resume-queue").disabled, false);
  assert.equal(reload.get("queue-status").classList.contains("hidden"), false);
  assert.match(reload.get("queue-summary").textContent, /4|0/, "known queue count remains visible during recovery");
  assert.match(reload.get("queue-resume-label").textContent, /核对恢复结果/);
  await reload.timers.get(5000)();
  assert.equal(f.posts.length, 1, "selection, reload, and polling never resume automatically");
  f.onPost((path, body) => Response.json(receipt(body)));
  await reload.get("resume-queue").onclick();
  assert.deepEqual(f.posts[1], f.posts[0], "recovery never targets the next head");
  assert.equal(reload.get("message-input").value, "newest typed draft");
  assert.deepEqual(JSON.parse(reload.storage.get("codex-pocket-queue-resume")), []);
});

for (const field of ["requestId", "queuedSubmissionId"]) test(`mismatched ${field} keeps unresolved original identity`, async () => {
  const f = fixture();
  f.onPost((path, body) => Response.json({...receipt(body), [field]: "wrong"}));
  const ui = mobile(f.fetch); await ui.select(); draft(ui, "keep mismatch");
  await ui.get("resume-queue").onclick();
  assert.match(ui.get("chat-notice").textContent, /未确认/);
  const pending = JSON.parse(ui.storage.get("codex-pocket-queue-resume"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].queuedSubmissionId, "original-head");
  assert.equal(ui.get("message-input").value, "keep mismatch");
});

test("known notSubmitted reject forgets pending identity but retains draft", async () => {
  const f = fixture();
  f.onPost(() => Response.json({error: "队列状态已变化", notSubmitted: true}, {status: 409}));
  const ui = mobile(f.fetch); await ui.select(); draft(ui, "keep rejected");
  await ui.get("resume-queue").onclick();
  assert.deepEqual(JSON.parse(ui.storage.get("codex-pocket-queue-resume")), []);
  assert.equal(ui.get("message-input").value, "keep rejected");
  assert.match(ui.get("chat-notice").textContent, /队列状态已变化/);
});

for (const [status, expected] of [["failed", /失败/], ["interrupted", /中断/], ["completed", /首.*完成/]]) {
  test(`a ${status} started turn is not described as still running`, async () => {
    const f = fixture();
    f.onPost((path, body) => Response.json({...receipt(body), turnStatus: status}));
    const ui = mobile(f.fetch); await ui.select();
    await ui.get("resume-queue").onclick();
    assert.match(ui.get("chat-notice").textContent, expected);
    assert.doesNotMatch(ui.get("chat-notice").textContent, /正在执行|全部.*完成/);
  });
}

test("switching during a resume response preserves both drafts/preferences and the peer notice", async () => {
  const f = fixture(), slow = deferred(); f.onPost(() => slow.promise);
  const ui = mobile(f.fetch); await ui.run("loadModels()"); await ui.select();
  draft(ui, "one draft");
  ui.get("effort-select").value = "high"; ui.get("effort-select").onchange();
  const resume = ui.get("resume-queue").onclick();
  await new Promise(setImmediate);
  await ui.select("two"); draft(ui, "two draft");
  const notice = ui.get("chat-notice").textContent;
  slow.resolve(Response.json(receipt(f.posts[0].body)));
  await resume;
  assert.equal(ui.get("message-input").value, "two draft");
  assert.equal(ui.get("chat-notice").textContent, notice);
  await ui.select("one");
  assert.equal(ui.get("message-input").value, "one draft");
  assert.equal(ui.get("effort-select").value, "high");
  assert.match(ui.get("chat-notice").textContent, /首.*已启动|首.*开始/);
  await ui.select("two");
  assert.equal(ui.get("message-input").value, "two draft");
});

test("switching during preflight cannot dispatch to either chat", async () => {
  const f = fixture(), slow = deferred();
  let blocked = false;
  const ui = mobile((path, options) => blocked && path === "/api/threads/one/control"
    ? slow.promise : f.fetch(path, options));
  await ui.select(); draft(ui, "one preflight draft");
  blocked = true;
  const resume = ui.get("resume-queue").onclick();
  await ui.select("two"); draft(ui, "two preflight draft");
  slow.resolve(Response.json(idle()));
  await resume;
  assert.equal(f.posts.length, 0);
  assert.equal(ui.get("message-input").value, "two preflight draft");
  blocked = false;
  await ui.select("one");
  assert.equal(ui.get("message-input").value, "one preflight draft");
});

test("logout clears unresolved queue identities and saved control drafts", async () => {
  const f = fixture(); f.onPost(() => { throw new Error("lost"); });
  const ui = mobile(f.fetch); await ui.select(); draft(ui, "private draft");
  await ui.get("resume-queue").onclick();
  assert.ok(ui.storage.get("codex-pocket-queue-resume"));
  f.onPost(() => Response.json({ok: true}));
  await ui.get("logout").onclick();
  assert.equal(ui.storage.has("codex-pocket-queue-resume"), false);
  assert.equal(ui.storage.has("codex-pocket-control-drafts"), false);
});

test("a newer draft typed during response loss is what reload restores", async () => {
  const f = fixture(), slow = deferred(); f.onPost(() => slow.promise);
  const first = mobile(f.fetch); await first.select(); draft(first, "before request");
  const resume = first.get("resume-queue").onclick();
  await new Promise(setImmediate);
  draft(first, "edited during response");
  slow.resolve(new Response("", {status: 502}));
  await resume;
  const reload = mobile(f.fetch, first.storage); await reload.select();
  assert.equal(reload.get("message-input").value, "edited during response");
  assert.match(reload.get("queue-resume-label").textContent, /核对/);
});

test("recovery preserves steering mode and coexists with an unresolved original steer", async () => {
  const f = fixture();
  f.status(idle({state: "inProgress", turnId: "steer-turn", canSteer: true, canInterrupt: true,
    queue: queue({canResume: false})}));
  f.onPost(() => { throw new Error("lost"); });
  const first = mobile(f.fetch); await first.select();
  first.get("steer-mode").onclick(); draft(first, "original steer");
  await first.run('send("original steer")');
  f.status(idle());
  await first.run("refreshControl()");
  draft(first, "independent latest draft");
  await first.get("resume-queue").onclick();
  const reload = mobile(f.fetch, first.storage); await reload.select();
  assert.equal(reload.get("steer-mode").attributes["aria-pressed"], "true");
  assert.equal(reload.get("message-input").value, "independent latest draft");
  assert.equal(reload.get("send").disabled, true);
  assert.equal(JSON.parse(reload.storage.get("codex-pocket-controls"))[0].text, "original steer");
  f.onPost((path, body) => Response.json(receipt(body)));
  await reload.get("resume-queue").onclick();
  assert.equal(reload.get("steer-mode").attributes["aria-pressed"], "true");
  assert.equal(reload.get("message-input").value, "independent latest draft");
  assert.equal(JSON.parse(reload.storage.get("codex-pocket-controls"))[0].turnId, "steer-turn");
});

test("a normal confirmed send while resume is unresolved does not resurrect its sent draft on reload", async () => {
  const f = fixture(); f.onPost(() => { throw new Error("lost resume"); });
  const first = mobile(f.fetch); await first.select(); draft(first, "ordinary message draft");
  await first.get("resume-queue").onclick();
  f.onPost(() => Response.json({status: "queued", messageId: "ordinary-message"}));
  await first.run('send("ordinary message draft")');
  assert.equal(first.get("message-input").value, "");
  const reload = mobile(f.fetch, first.storage); await reload.select();
  assert.equal(reload.get("message-input").value, "");
  assert.match(reload.get("queue-resume-label").textContent, /核对/);
  assert.equal(JSON.parse(reload.storage.get("codex-pocket-queue-resume"))[0].queuedSubmissionId, "original-head");
});

test("a late confirmed send clears only its saved draft while queue recovery remains unresolved", async () => {
  const f = fixture(); f.onPost(() => { throw new Error("lost resume"); });
  const first = mobile(f.fetch); await first.select(); draft(first, "one sent draft");
  await first.get("resume-queue").onclick();
  const slow = deferred(); f.onPost(() => slow.promise);
  const send = first.run('send("one sent draft")');
  await first.select("two"); draft(first, "two unsent draft");
  slow.resolve(Response.json({status: "queued", messageId: "ordinary-message"}));
  await send;
  assert.equal(first.get("message-input").value, "two unsent draft");
  await first.select("one");
  assert.equal(first.get("message-input").value, "");
  const reload = mobile(f.fetch, first.storage); await reload.select();
  assert.equal(reload.get("message-input").value, "");
  assert.equal(JSON.parse(reload.storage.get("codex-pocket-queue-resume"))[0].queuedSubmissionId, "original-head");
});

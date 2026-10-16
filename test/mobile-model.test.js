import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { createApiClient } from "../public/api-client.js";
import { SubmissionTracker } from "../public/submissions.js";

function mobile(fetchImpl, storage = new Map()) {
  const nodes = new Map();
  const makeNode = () => {
    const classes = new Set();
    return {
      value: "", textContent: "", disabled: false, open: false, children: [],
      classList: {add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)), contains: x => classes.has(x), toggle(x, on) { if (on ?? !classes.has(x)) classes.add(x); else classes.delete(x); }},
      replaceChildren(...xs) { this.children = xs; }, append(...xs) { this.children.push(...xs); }, add(x) { this.children.push(x); },
      showModal() { this.open = true; }, close() { this.open = false; }, after() {}, setAttribute() {}, focus() {}, replaceWith() {},
    };
  };
  const get = id => {
    if (!nodes.has(id)) {
      const node = makeNode();
      if (["model-select", "effort-select", "new-model", "new-effort"].includes(id)) {
        let value = "";
        Object.defineProperty(node, "value", {
          get: () => value,
          set: next => { value = node.children.some(o => o.value === next) ? next : ""; },
        });
      }
      nodes.set(id, node);
    }
    return nodes.get(id);
  };
  const context = vm.createContext({
    createApiClient, SubmissionTracker,
    document: {getElementById: get, createElement: makeNode, body: makeNode(), hidden: false},
    sessionStorage: {getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k)},
    location: {hash: "", pathname: "/"}, URLSearchParams, crypto: webcrypto,
    Option: function(text, value) { return {text, value}; },
    fetch: fetchImpl, setInterval() {}, setTimeout() {}, clearTimeout() {},
  });
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace(/boot\(\);\s*$/, "");
  vm.runInContext(source, context);
  return {get, run: source => vm.runInContext(source, context), storage};
}

const catalog = {
  models: [
    {id: "model-a", name: "Model A", defaultEffort: "medium", efforts: [{id: "low", label: "Low"}, {id: "medium", label: "Medium"}]},
    {id: "model-b", name: "Model B", defaultEffort: "high", efforts: [{id: "high", label: "High"}, {id: "xhigh", label: "Extra high"}]},
  ], defaultModel: "model-a", defaultEffort: "medium",
};
const projects = [{id: "project", name: "项目", paths: ["local"], count: 1}];
function fixture({offline = false, catalogFails = false, busy = false} = {}) {
  const requests = [];
  const fetchImpl = async (path, options) => {
    if (path === "/api/models") return catalogFails ? Response.json({error: "不可用"}, {status: 503}) : Response.json(catalog);
    if (path === "/api/projects") return Response.json({projects});
    if (options.method === "POST") {
      requests.push({path, body: JSON.parse(options.body)});
      if (offline) throw new Error("offline");
      if (busy) return Response.json({error: "桌面占用，请先释放", notSubmitted: true}, {status: 409});
      return Response.json(path.includes("/projects/") ? {status: "created", threadId: "new"} : {status: "started", messageId: "message", requestId: "request", notice: "已启动。"});
    }
    if (path.includes("/api/threads?")) return Response.json({threads: []});
    return Response.json({thread: {title: "会话", projectName: "项目", model: "model-a", reasoningEffort: "low"}, messages: [], status: "completed", hasMore: false});
  };
  return {fetchImpl, requests};
}

test("model catalog drives efforts; polling preserves choices and actual metadata", async () => {
  const f = fixture(); const ui = mobile(f.fetchImpl);
  await ui.run("loadModels();");
  ui.run('selected = "chat"');
  await ui.run("loadChat()");
  assert.deepEqual(ui.get("effort-select").children.map(o => o.value), ["", "low", "medium"]);
  ui.get("model-select").value = "model-b"; ui.get("model-select").onchange();
  assert.deepEqual(ui.get("effort-select").children.map(o => o.value), ["", "high", "xhigh"]);
  assert.match(ui.get("effort-select").children[0].text, /high/);
  ui.get("effort-select").value = "xhigh"; ui.get("effort-select").onchange();
  const effortOption = ui.get("effort-select").children[1];
  await ui.run("loadChat()");
  assert.equal(ui.get("model-select").value, "model-b");
  assert.equal(ui.get("effort-select").value, "xhigh");
  assert.equal(ui.get("effort-select").children[1], effortOption, "unchanged polls leave native select options intact");
  assert.match(ui.get("thread-meta").textContent, /model-a/);
  assert.doesNotMatch(ui.get("thread-meta").textContent, /model-b/);
});

test("send includes explicit options and recognizes started; inherited send keeps old payload", async () => {
  const f = fixture(); const ui = mobile(f.fetchImpl);
  await ui.run("loadModels()"); ui.run('selected = "chat"');
  ui.get("model-select").value = "model-b"; ui.get("model-select").onchange();
  ui.get("effort-select").value = "high";
  await ui.run('send("chosen")');
  assert.equal(f.requests[0].body.model, "model-b");
  assert.equal(f.requests[0].body.effort, "high");
  assert.match(ui.get("chat-notice").textContent, /已开始执行/);
  ui.get("model-select").value = ""; ui.get("model-select").onchange();
  await ui.run('send("inherited")');
  assert.deepEqual(Object.keys(f.requests[1].body).sort(), ["requestId", "text"]);
});

test("new-thread options and unconfirmed selections survive reload with the request id", async () => {
  const f = fixture({offline: true}); const first = mobile(f.fetchImpl);
  await first.run("loadProjects(); loadModels()"); first.run("openNewThread()");
  first.get("new-model").value = "model-b"; first.get("new-model").onchange();
  first.get("new-effort").value = "xhigh"; first.get("new-message").value = "create this";
  await first.run("createThread()");
  const reloaded = mobile(f.fetchImpl, first.storage);
  await reloaded.run("loadProjects(); loadModels()"); reloaded.run("openNewThread()");
  assert.equal(reloaded.get("new-model").value, "model-b");
  assert.equal(reloaded.get("new-effort").value, "xhigh");
  await reloaded.run("createThread()");
  assert.equal(f.requests[0].body.model, "model-b");
  assert.equal(f.requests[0].body.effort, "xhigh");
  assert.equal(f.requests[1].body.requestId, f.requests[0].body.requestId);
});

test("thread preferences survive switching and unresolved send settings survive reload", async () => {
  const f = fixture({offline: true}); const ui = mobile(f.fetchImpl);
  await ui.run("loadModels()"); await ui.run('selectThread("one"); loadChat()');
  ui.get("model-select").value = "model-b"; ui.get("model-select").onchange();
  ui.get("effort-select").value = "xhigh"; ui.get("effort-select").onchange();
  ui.get("message-input").value = "keep";
  await ui.run('send("keep")');
  await ui.run('selectThread("two"); loadChat()');
  assert.equal(ui.get("model-select").value, "");
  await ui.run('selectThread("one"); loadChat()');
  assert.equal(ui.get("model-select").value, "model-b");
  assert.equal(ui.get("effort-select").value, "xhigh");
  const reloaded = mobile(f.fetchImpl, ui.storage); await reloaded.run("loadModels()");
  await reloaded.run('selectThread("one"); loadChat()');
  assert.equal(reloaded.get("message-input").value, "keep");
  assert.equal(reloaded.get("model-select").value, "model-b");
  assert.equal(reloaded.get("effort-select").value, "xhigh");
});

test("unresolved settings survive opening a chat while its catalog is still loading", async () => {
  const f = fixture({offline: true}); const ui = mobile(f.fetchImpl);
  ui.run('submissions.get("chat", "pending", uuid, {model: "model-b", effort: "xhigh"})');
  await ui.run('selectThread("chat"); loadChat()');
  await ui.run("loadModels()");
  assert.equal(ui.get("model-select").value, "model-b");
  assert.equal(ui.get("effort-select").value, "xhigh");
  ui.run('selectThread("other")');
  await ui.run("loadModels()");
  ui.run('selectThread("chat")');
  assert.equal(ui.get("model-select").value, "model-b");
});

test("an inherited model uses that model's efforts and fallback default", async () => {
  const f = fixture(); const ui = mobile(f.fetchImpl);
  await ui.run("loadModels()");
  ui.run('selected = "chat"; threadDetails.set("chat", {model: "model-b"}); renderSettings("chat")');
  assert.deepEqual(ui.get("effort-select").children.map(o => o.value), ["", "high", "xhigh"]);
  assert.match(ui.get("effort-select").children[0].text, /high/);
  ui.get("effort-select").value = "xhigh";
  await ui.run('send("effort only")');
  assert.equal(f.requests[0].body.effort, "xhigh");
  assert.equal("model" in f.requests[0].body, false);
});

test("an effort-only unresolved send is restored after the actual inherited model loads", async () => {
  const f = fixture();
  const ui = mobile(async (path, options) => path === "/api/threads/chat"
    ? Response.json({thread: {title: "会话", projectName: "项目", model: "model-b", reasoningEffort: "high"}, messages: [], status: "completed", hasMore: false})
    : f.fetchImpl(path, options));
  ui.run('submissions.get("chat", "pending", uuid, {effort: "xhigh"})');
  await ui.run("loadModels()");
  await ui.run('selectThread("chat"); loadChat()');
  assert.equal(ui.get("model-select").value, "");
  assert.equal(ui.get("effort-select").value, "xhigh");
});

test("catalog failure permits inherited creation and sending, while conflict retains draft", async () => {
  const f = fixture({catalogFails: true}); const ui = mobile(f.fetchImpl);
  await ui.run("loadModels()");
  assert.equal(ui.get("model-select").disabled, true);
  assert.match(ui.get("model-notice").textContent, /模型.*不可用|模型.*失败/);
  ui.run('selected = "chat"'); await ui.run('send("inherit")');
  assert.deepEqual(Object.keys(f.requests[0].body).sort(), ["requestId", "text"]);
  await ui.run("loadProjects()"); ui.run("openNewThread()"); ui.get("new-message").value = "new";
  await ui.run("createThread()");
  assert.deepEqual(Object.keys(f.requests[1].body).sort(), ["requestId", "text"]);
  const busy = fixture({busy: true}); const conflict = mobile(busy.fetchImpl);
  await conflict.run("loadModels()"); conflict.run('selected = "chat"');
  conflict.get("message-input").value = "draft"; conflict.get("model-select").value = "model-b";
  await conflict.run('send("draft")');
  assert.equal(conflict.get("message-input").value, "draft");
  assert.equal(conflict.get("model-select").value, "model-b");
  assert.equal(conflict.run('submissions.latest("chat")'), null);
  assert.match(conflict.get("chat-notice").textContent, /桌面占用/);
});

test("explicitly rejected creation keeps draft and selections without an unresolved request", async () => {
  const f = fixture({busy: true}); const ui = mobile(f.fetchImpl);
  await ui.run("loadProjects(); loadModels()"); ui.run("openNewThread()");
  ui.get("new-model").value = "model-b"; ui.get("new-model").onchange();
  ui.get("new-effort").value = "xhigh"; ui.get("new-message").value = "draft";
  await ui.run("createThread()");
  assert.equal(ui.get("new-message").value, "draft");
  assert.equal(ui.get("new-model").value, "model-b");
  assert.equal(ui.get("new-effort").value, "xhigh");
  assert.equal(ui.run("creations.latest()"), null);
  assert.equal(ui.get("new-thread-dialog").open, true);
  assert.match(ui.get("new-thread-error").textContent, /桌面占用/);
});

test("rejected explicit send followed by inherited success leaves no draft to restore", async () => {
  const f = fixture(); const requests = [];
  const ui = mobile(async (path, options) => {
    if (options.method === "POST") {
      const body = JSON.parse(options.body); requests.push(body);
      if (body.model) return Response.json({error: "桌面占用", notSubmitted: true}, {status: 409});
    }
    return f.fetchImpl(path, options);
  });
  await ui.run("loadModels()"); ui.run('selected = "chat"');
  ui.get("message-input").value = "draft";
  ui.get("model-select").value = "model-b"; ui.get("model-select").onchange();
  await ui.run('send("draft")');
  ui.get("model-select").value = ""; ui.get("model-select").onchange();
  await ui.run('send("draft")');
  assert.equal(ui.run('submissions.latest("chat")'), null);
  const reload = mobile(f.fetchImpl, ui.storage); await reload.run("loadModels()");
  await reload.run('selectThread("chat"); loadChat()');
  assert.equal(reload.get("message-input").value, "");
  assert.notEqual(requests[0].requestId, requests[1].requestId);
});

test("API exposes only a literal notSubmitted flag on JSON HTTP failures", async () => {
  for (const flag of [true, false, "true", undefined]) {
    const api = createApiClient({fetchImpl: async () => Response.json({error: "模型不可用", notSubmitted: flag}, {status: 409})});
    await assert.rejects(api("/api/threads/chat/messages", {method: "POST"}), e => {
      assert.equal(e.notSubmitted, flag === true);
      assert.equal(e.submissionUnknown, false);
      return true;
    });
  }
});

test("API accepts started confirmations while rejecting incomplete results", async () => {
  const api = createApiClient({fetchImpl: async () => Response.json({status: "started", messageId: "m", requestId: "r"})});
  assert.equal((await api("/api/threads/chat/messages", {method: "POST"})).status, "started");
  const invalid = createApiClient({fetchImpl: async () => Response.json({status: "started"})});
  await assert.rejects(invalid("/api/threads/chat/messages", {method: "POST"}), /未确认/);
});

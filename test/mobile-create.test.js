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
      classList: {
        add: (...names) => names.forEach(n => classes.add(n)),
        remove: (...names) => names.forEach(n => classes.delete(n)),
        contains: n => classes.has(n),
        toggle(n, on) { if (on ?? !classes.has(n)) classes.add(n); else classes.delete(n); },
      },
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); },
      add(child) { this.children.push(child); },
      showModal() { this.open = true; }, close() { this.open = false; },
      after() {}, setAttribute() {}, focus() {}, replaceWith() {},
    };
  };
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, makeNode());
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

const projects = [
  {id: "p1", name: "已有项目", count: 2, paths: ["project-one"]},
  {id: "p2", name: "空项目", count: 0, paths: ["project-two"]},
  {id: "__unassigned__", name: "未分组", count: 1, paths: []},
];

test("creation includes empty projects and defaults to the selected project", async () => {
  const ui = mobile(async () => Response.json({projects}));
  await ui.run("loadProjects()");
  assert.ok(ui.get("project-select").children.some(o => o.value === "p2"));
  ui.get("project-select").value = "p2";
  ui.run("openNewThread()");
  assert.equal(ui.get("new-thread-dialog").open, true);
  assert.equal(ui.get("new-project").value, "p2");
  assert.equal(ui.get("new-project").children.some(o => o.value === "__unassigned__"), false);
});

test("confirmed creation opens the new thread even if refreshing history fails", async () => {
  let posts = 0;
  const ui = mobile(async (path, options) => {
    if (options.method === "POST") {
      posts++;
      return Response.json({status: "created", threadId: "new-thread"});
    }
    if (path === "/api/projects") return Response.json({projects});
    return new Response("gateway", {status: 502});
  });
  await ui.run("loadProjects()");
  ui.get("project-select").value = "p2";
  ui.get("search").value = "old search";
  ui.run("openNewThread()");
  ui.get("new-message").value = "first message";
  await ui.run("createThread()");
  assert.equal(posts, 1);
  assert.equal(ui.run("selected"), "new-thread");
  assert.equal(ui.get("new-thread-dialog").open, false);
  assert.equal(ui.get("search").value, "");
  assert.equal(ui.get("new-message").value, "");
  assert.equal(ui.run("creations.latest()"), null);
  assert.match(ui.get("chat-notice").textContent, /新会话已创建/);
});

test("uncertain creation retains its text and reuses its request id after reload", async () => {
  const requests = [];
  const fetchImpl = async (path, options) => {
    if (options.method === "POST") {
      requests.push(JSON.parse(options.body));
      throw new Error("offline");
    }
    return Response.json({projects});
  };
  const first = mobile(fetchImpl);
  await first.run("loadProjects()");
  first.get("project-select").value = "p2";
  first.run("openNewThread()");
  first.get("new-message").value = "keep this first message";
  await first.run("createThread()");
  assert.equal(first.get("new-message").value, "keep this first message");
  assert.match(first.get("new-thread-error").textContent, /未确认/);
  const reloaded = mobile(fetchImpl, first.storage);
  await reloaded.run("loadProjects()");
  reloaded.run("openNewThread()");
  assert.equal(reloaded.get("new-project").value, "p2");
  assert.equal(reloaded.get("new-message").value, "keep this first message");
  await reloaded.run("createThread()");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].requestId, requests[1].requestId);
});

test("whitespace-only text cannot submit and an empty project list disables creation", async () => {
  let posts = 0;
  const ui = mobile(async (_, options) => {
    if (options.method === "POST") posts++;
    return Response.json({projects: []});
  });
  await ui.run("loadProjects()");
  assert.equal(ui.get("new-thread").disabled, true);
  ui.get("new-message").value = "  ";
  await ui.run("createThread()");
  assert.equal(posts, 0);
});

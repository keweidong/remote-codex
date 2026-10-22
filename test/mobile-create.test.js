import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { createApiClient } from "../public/api-client.js";
import { SubmissionTracker } from "../public/submissions.js";

function mobile(fetchImpl, storage = new Map()) {
  const nodes = new Map();
  const intervals = new Map();
  const makeNode = (tag = "div") => {
    const classes = new Set();
    return {
      tagName: tag, attributes: {}, value: "", textContent: "", disabled: false, open: false, children: [], style: {}, scrollHeight: 46,
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
      after() {}, setAttribute(name, value) { this.attributes[name] = value; }, focus() {}, replaceWith() {},
    };
  };
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, makeNode());
    return nodes.get(id);
  };
  const context = vm.createContext({
    createApiClient, SubmissionTracker,
    document: {getElementById: get, createElement: makeNode, createElementNS: (_, tag) => makeNode(tag), body: makeNode(), hidden: false},
    sessionStorage: {getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k)},
    location: {hash: "", pathname: "/"}, URLSearchParams, crypto: webcrypto,
    Option: function(text, value) { return {text, value}; },
    fetch: fetchImpl, setInterval(fn, ms) { intervals.set(ms, fn); }, setTimeout() {}, clearTimeout() {},
    matchMedia: () => ({matches: true, addEventListener() {}}),
  });
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace(/boot\(\);\s*$/, "");
  vm.runInContext(source, context);
  return {get, run: source => vm.runInContext(source, context), storage, intervals};
}

const projects = [
  {id: "p1", name: "已有项目", count: 2, paths: ["project-one"]},
  {id: "p2", name: "空项目", count: 0, paths: ["project-two"]},
  {id: "__unassigned__", name: "未分组", count: 1, paths: []},
];

test("creation includes empty projects and defaults to the selected project", async () => {
  const ui = mobile(async () => Response.json({projects}));
  await ui.run("loadProjects()");
  ui.run('openNewThread("p2")');
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
  ui.run('preferredProject = "p2"');
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
  first.run('preferredProject = "p2"');
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

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

test("project rows include empty projects, separate sessions by id and preserve collapsed state", async () => {
  const ui = mobile(async () => Response.json({projects}));
  await ui.run("loadProjects()");
  ui.run(`threads = [
    {id:"one", projectId:"p1", title:"First", projectName:"已有项目", status:"completed"},
    {id:"two", projectId:"__unassigned__", title:"Loose", projectName:"未分组", status:"unknown"}
  ]; renderThreads()`);
  const groups = ui.get("thread-list").children;
  assert.equal(groups.length, 3);
  const first = descendants(groups[0]);
  const toggle = first.find(n => n.className === "project-toggle");
  assert.equal(toggle.attributes["aria-expanded"], "true");
  assert.equal(first.filter(n => n.className?.startsWith("thread-card")).some(n => n.textContent === "First"), true);
  assert.equal(first.some(n => n.textContent === "Loose"), false);
  assert.equal(descendants(groups[2]).some(n => n.textContent === "Loose"), true);
  const empty = descendants(groups[1]);
  assert.ok(empty.some(n => n.className === "project-add icon-button"));
  assert.equal(descendants(groups[2]).some(n => n.className === "project-add icon-button"), false);
  await toggle.onclick();
  ui.run("renderThreads()");
  const collapsed = descendants(ui.get("thread-list").children[0]);
  assert.equal(collapsed.find(n => n.className === "project-toggle").attributes["aria-expanded"], "false");
  assert.ok(collapsed.find(n => n.className === "project-threads").classList.contains("hidden"));
});

test("expanding a project queries its own sessions and row add chooses that project", async () => {
  const calls = [];
  const ui = mobile(async path => {
    if (path === "/api/projects") return Response.json({projects});
    calls.push(path);
    const id = new URL("http://local" + path).searchParams.get("projectId");
    return Response.json({threads: id === "p2"
      ? [{id:"older", projectId:"p2", projectName:"空项目", title:"Older project chat", status:"completed"}] : []});
  });
  await ui.run("loadProjects()");
  const second = descendants(ui.get("thread-list").children[1]);
  await second.find(n => n.className === "project-toggle").onclick();
  assert.ok(calls.some(path => path.includes("projectId=p2")));
  assert.ok(descendants(ui.get("thread-list")).some(n => n.textContent === "Older project chat"));
  descendants(ui.get("thread-list").children[1]).find(n => n.className === "project-add icon-button").onclick();
  assert.equal(ui.get("new-project").value, "p2");
});

test("sidebar open and close buttons preserve the selected conversation and draft", () => {
  const ui = mobile(async () => Response.json({projects}));
  ui.run('selected = "one"; setSidebar(false)');
  ui.get("message-input").value = "unsent";
  ui.get("sidebar-toggle").onclick();
  assert.equal(ui.get("workspace").classList.contains("sidebar-open"), true);
  assert.equal(ui.get("sidebar-toggle").attributes["aria-expanded"], "true");
  ui.get("sidebar-backdrop").onclick();
  assert.equal(ui.get("workspace").classList.contains("sidebar-open"), false);
  assert.equal(ui.get("sidebar-toggle").attributes["aria-expanded"], "false");
  assert.equal(ui.get("message-input").value, "unsent");
  assert.equal(ui.run("selected"), "one");
});

test("search temporarily expands matching projects and clearing it restores their collapsed state", async () => {
  const ui = mobile(async path => path === "/api/projects" ? Response.json({projects})
    : Response.json({threads: new URL("http://local" + path).searchParams.get("projectId") === "p1"
      ? [{id: "one", title: "First", projectId: "p1", projectName: "已有项目", status: "completed"}] : []}));
  await ui.run("loadProjects()");
  await ui.run("loadThreads()");
  await descendants(ui.get("thread-list").children[0]).find(n => n.className === "project-toggle").onclick();
  ui.get("search").value = "First";
  await ui.run("loadThreads()");
  assert.equal(ui.get("thread-list").children.length, 1);
  assert.equal(descendants(ui.get("thread-list")).find(n => n.className === "project-toggle").attributes["aria-expanded"], "true");
  ui.get("search").value = "";
  await ui.run("loadThreads()");
  assert.equal(ui.get("thread-list").children.length, 3);
  assert.equal(descendants(ui.get("thread-list")).find(n => n.className === "project-toggle").attributes["aria-expanded"], "false");
});

test("a late search response cannot replace newer project-group results", async () => {
  const finishOld = [];
  const ui = mobile(async path => {
    if (path === "/api/projects") return Response.json({projects});
    if (path.includes("search=older")) return new Promise(resolve => { finishOld.push(resolve); });
    return Response.json({threads: [{id: "new", title: "Newest", projectId: "p1", projectName: "已有项目", status: "completed"}]});
  });
  await ui.run("loadProjects()");
  ui.get("search").value = "older";
  const previous = ui.run("loadThreads()");
  ui.get("search").value = "newer";
  await ui.run("loadThreads()");
  for (const finish of finishOld)
    finish(Response.json({threads: [{id: "old", title: "Outdated", projectId: "p2", projectName: "空项目", status: "completed"}]}));
  await previous;
  const nodes = descendants(ui.get("thread-list"));
  assert.equal(nodes.some(n => n.textContent === "Newest"), true);
  assert.equal(nodes.some(n => n.textContent === "Outdated"), false);
});

test("a failed project does not discard another expanded project's successful result", async () => {
  const ui = mobile(async path => {
    if (path === "/api/projects") return Response.json({projects});
    if (path.includes("projectId=p1")) return Response.json({error: "Project unavailable"}, {status: 503});
    return Response.json({threads: [{id: "two", title: "Healthy project chat", projectId: "p2", projectName: "空项目", status: "completed"}]});
  });
  await ui.run("loadProjects()");
  ui.run('expandedProjects.add("p2")');
  await ui.run("loadThreads()");
  assert.ok(descendants(ui.get("thread-list")).some(n => n.textContent === "Healthy project chat"));
  assert.ok(descendants(ui.get("thread-list")).some(n => n.textContent.includes("Project unavailable")));
});

test("overlapping refreshes share a slow project request without starving fast project results", async () => {
  let completeSlow, slowCalls = 0;
  const ui = mobile(async path => {
    if (path === "/api/projects") return Response.json({projects});
    if (path.includes("projectId=p1")) {
      slowCalls++;
      return new Promise(resolve => { completeSlow = resolve; });
    }
    return Response.json({threads: [{id: "two", title: "Fast chat", projectId: "p2", projectName: "空项目", status: "completed"}]});
  });
  await ui.run("loadProjects()");
  ui.run('expandedProjects.add("p2")');
  const first = ui.run("loadThreads()");
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(descendants(ui.get("thread-list")).some(n => n.textContent === "Fast chat"));
  const second = ui.run("loadThreads()");
  assert.equal(slowCalls, 1);
  completeSlow(Response.json({threads: [{id: "one", title: "Slow chat", projectId: "p1", projectName: "已有项目", status: "completed"}]}));
  await Promise.all([first, second]);
  assert.ok(descendants(ui.get("thread-list")).some(n => n.textContent === "Slow chat"));
});

test("search queries each project so older matches are not hidden behind the global recent limit", async () => {
  const calls = [];
  const ui = mobile(async path => {
    if (path === "/api/projects") return Response.json({projects});
    calls.push(path);
    const id = new URL("http://local" + path).searchParams.get("projectId");
    return Response.json({threads: id === "p2"
      ? [{id: "old", title: "Older matching session", projectId: "p2", projectName: "空项目", status: "completed"}] : []});
  });
  await ui.run("loadProjects()");
  ui.get("search").value = "matching";
  await ui.run("loadThreads()");
  assert.ok(calls.some(path => path.includes("projectId=p2")));
  assert.ok(descendants(ui.get("thread-list")).some(n => n.textContent === "Older matching session"));
});

test("hidden sidebar pauses list polling and opening it refreshes the project groups", async () => {
  let reads = 0;
  const ui = mobile(async path => {
    if (path === "/api/projects") return Response.json({projects});
    reads++;
    return Response.json({threads: []});
  });
  await ui.run("loadProjects()");
  ui.run("setSidebar(false)");
  ui.intervals.get(12000)();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0);
  ui.get("sidebar-toggle").onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  ui.intervals.get(12000)();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2);
});

test("refresh keeps known nonmatching projects hidden while their requests are pending", async () => {
  let refreshing = false, finishPending;
  const ui = mobile(async path => {
    if (path === "/api/projects") return Response.json({projects});
    const id = new URL("http://local" + path).searchParams.get("projectId");
    if (refreshing && id === "p2") return new Promise(resolve => { finishPending = resolve; });
    return Response.json({threads: id === "p1"
      ? [{id: "one", title: "Needle result", projectId: "p1", projectName: "已有项目", status: "completed"}] : []});
  });
  await ui.run("loadProjects()");
  ui.get("search").value = "needle";
  await ui.run("loadThreads()");
  assert.equal(ui.get("thread-list").children.length, 1);
  refreshing = true;
  const pending = ui.run("loadThreads()");
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(ui.get("thread-list").children.length, 1,
      "a known empty project must not flash into unchanged search results");
  } finally {
    finishPending(Response.json({threads: []}));
    await pending;
  }
});

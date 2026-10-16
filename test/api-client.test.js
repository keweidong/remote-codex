import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createApiClient } from "../public/api-client.js";

const postPath = "/api/threads/fixture/messages";
const post = { method: "POST", body: "{}" };
const unknown = "提交结果未确认，请检查桌面队列，勿重复发送";

test("new session network failures are reported as uncertain creation", async () => {
  const api = createApiClient({ fetchImpl: async () => { throw new Error("offline"); } });
  await assert.rejects(api("/api/projects/p1/threads", post), e => {
    assert.equal(e.submissionUnknown, true);
    assert.match(e.message, /新会话创建结果未确认/);
    return true;
  });
});

test("new session requires a valid creation acknowledgment", async () => {
  for (const result of [{}, {status: "created", threadId: ""}, {status: "created", threadId: "../bad"}]) {
    const api = createApiClient({ fetchImpl: async () => Response.json(result) });
    await assert.rejects(api("/api/projects/p1/threads", post), e => e.submissionUnknown === true);
  }
  const result = {status: "created", threadId: "new-thread", requestId: "request", projectId: "p1"};
  const api = createApiClient({ fetchImpl: async () => Response.json(result) });
  assert.deepEqual(await api("/api/projects/p1/threads", post), result);
});

test("HTML 502 preserves response metadata without displaying its body", async () => {
  const api = createApiClient({
    fetchImpl: async () =>
      new Response("<html>PRIVATE GATEWAY BODY</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
  });
  await assert.rejects(api(postPath, post), (e) => {
    assert.equal(e.status, 502);
    assert.equal(e.contentType, "text/html");
    assert.equal(e.phase, "parse");
    assert.equal(e.submissionUnknown, true);
    assert.ok(e.message.includes(unknown));
    assert.match(e.message, /HTTP 502/);
    assert.doesNotMatch(e.message, /PRIVATE|<html>/);
    return true;
  });
});

test("an empty HTTP response cannot confirm a submission", async () => {
  const api = createApiClient({
    fetchImpl: async () => new Response("", { status: 400 }),
  });
  await assert.rejects(api(postPath, post), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.phase, "parse");
    assert.equal(e.submissionUnknown, true);
    assert.match(e.message, /空响应/);
    return true;
  });
});

test("body transfer failures retain HTTP metadata and their own phase", async () => {
  const response = new Response("unused", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  response.text = async () => {
    throw new TypeError("terminated");
  };
  const api = createApiClient({ fetchImpl: async () => response });
  await assert.rejects(api(postPath, post), (e) => {
    assert.equal(e.phase, "body");
    assert.equal(e.status, 200);
    assert.equal(e.contentType, "application/json");
    assert.ok(e.message.includes(unknown));
    return true;
  });
});

test("JSON business errors retain the server explanation", async () => {
  const api = createApiClient({
    fetchImpl: async () =>
      Response.json(
        { error: "Codex 未确认提交（退出码 1）。" },
        { status: 502 },
      ),
  });
  await assert.rejects(api(postPath, post), (e) => {
    assert.equal(e.phase, "http");
    assert.equal(e.status, 502);
    assert.equal(e.contentType, "application/json");
    assert.equal(e.submissionUnknown, false);
    assert.match(e.message, /Codex 未确认提交（退出码 1）/);
    return true;
  });
});

test("network failures distinguish submission uncertainty from history refresh", async () => {
  const api = createApiClient({
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  await assert.rejects(api(postPath, post), (e) => {
    assert.equal(e.phase, "network");
    assert.equal(e.status, null);
    assert.equal(e.contentType, "");
    assert.ok(e.message.includes(unknown));
    return true;
  });
  await assert.rejects(api("/api/threads/fixture?before=40"), (e) => {
    assert.match(e.message, /^历史刷新失败：/);
    assert.equal(e.submissionUnknown, false);
    return true;
  });
});

test("successful JSON preserves queue confirmation and optional notice", async () => {
  let request;
  const expected = {
    status: "queued",
    messageId: "message-1",
    notice: "在桌面打开会话后处理。",
  };
  const api = createApiClient({
    fetchImpl: async (path, options) => {
      request = { path, options };
      return Response.json(expected);
    },
  });
  assert.deepEqual(await api(postPath, post), expected);
  assert.equal(request.path, postPath);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.headers["Content-Type"], "application/json");
});

test("a JSON success without a queue confirmation remains unconfirmed", async () => {
  const api = createApiClient({
    fetchImpl: async () => Response.json({ ok: true }),
  });
  await assert.rejects(api(postPath, post), (e) => {
    assert.equal(e.phase, "response");
    assert.equal(e.status, 200);
    assert.ok(e.message.includes(unknown));
    return true;
  });
});

test("JSON 401 preserves the pairing-screen callback", async () => {
  let rejected = 0;
  const api = createApiClient({
    fetchImpl: async () =>
      Response.json({ error: "配对已失效" }, { status: 401 }),
    onUnauthorized: () => {
      rejected++;
    },
  });
  await assert.rejects(api("/api/session"), /配对已失效/);
  assert.equal(rejected, 1);
  await assert.rejects(api("/api/pair", post), /配对已失效/);
  assert.equal(rejected, 1);
});

test("confirmed sends survive follow-up history and polling failures", async () => {
  const nodes = new Map();
  const makeNode = () => ({
    textContent: "",
    value: "hello",
    disabled: false,
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    after() {},
    setAttribute() {},
  });
  const getNode = (id) => {
    if (!nodes.has(id)) nodes.set(id, makeNode());
    return nodes.get(id);
  };
  const intervals = new Map();
  const acknowledged = [];
  class Tracker {
    get() {
      return { requestId: "fixture-request" };
    }
    acknowledge(id) {
      acknowledged.push(id);
    }
  }
  const context = vm.createContext({
    createApiClient,
    SubmissionTracker: Tracker,
    document: {
      getElementById: getNode,
      createElement: makeNode,
      hidden: false,
    },
    sessionStorage: {},
    location: { hash: "", pathname: "/" },
    URLSearchParams,
    fetch: async (_, options) =>
      options.method === "POST"
        ? Response.json({
            status: "queued",
            messageId: "fixture-message",
            notice: "桌面等待处理。",
          })
        : new Response("<html>gateway</html>", {
            status: 502,
            headers: { "Content-Type": "text/html" },
          }),
    setInterval: (fn, ms) => intervals.set(ms, fn),
    setTimeout() {},
    clearTimeout() {},
  });
  const source = readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  )
    .replace(/^import .*;\r?\n/gm, "")
    .replace(/boot\(\);\s*$/, "");
  vm.runInContext(source, context);
  await vm.runInContext('selected = "fixture"; send("hello");', context);
  assert.deepEqual(acknowledged, ["fixture-request"]);
  assert.match(getNode("chat-notice").textContent, /已提交到桌面队列/);
  assert.match(getNode("chat-notice").textContent, /桌面等待处理/);
  assert.doesNotMatch(getNode("chat-notice").textContent, /刷新失败|响应无效/);
  assert.match(
    vm.runInContext("historyNotice.textContent", context),
    /^历史刷新失败：/,
  );
  await intervals.get(2500)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(getNode("chat-notice").textContent, /已提交到桌面队列/);
  assert.doesNotMatch(getNode("chat-notice").textContent, /刷新失败|响应无效/);
  assert.match(
    vm.runInContext("historyNotice.textContent", context),
    /^历史刷新失败：/,
  );
});

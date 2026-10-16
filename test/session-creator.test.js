import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./fixtures.js";
import { createCodexStore } from "../src/codex-store.js";
import { SessionCreator } from "../src/session-creator.js";
import { appServerFixture } from "./app-server-fixture.js";

const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function setupCreator(t, script, options = {}) {
  const { dir, cleanup } = fixture(t);
  const store = createCodexStore({ codexHome: dir });
  const cli = join(dir, "fixture-cli.cjs");
  writeFileSync(cli, script);
  const creator = new SessionCreator({
    store, dataDir: join(dir, "remote-state"), executable: process.execPath,
    prefixArgs: [cli], codexHome: dir, ...options,
  });
  t.after(async () => {
    await creator.stop();
    store.close();
    cleanup();
  });
  return { creator, dir, store, cli };
}

const input = { projectId: "p1", text: "hello", requestId, deviceId: "phone" };

test("a started session continues past its startup deadline and occupies a running slot", async (t) => {
  const { creator } = setupCreator(t,
    appServerFixture(),
    { startTimeoutMs: 1500, maxRunning: 1 });
  assert.equal((await creator.create(input)).threadId, "new-session");
  await assert.rejects(creator.create({ ...input, requestId: "bbbbbbbb-bbbb-bbbb" }), e => e.statusCode === 429);
  await new Promise(resolve => setTimeout(resolve, 1650));
  assert.equal(creator.children.size, 1, "startup timeout must not terminate the first turn");
  assert.equal([...creator.children][0].killed, false);
});

test("passes the configured Codex home and permits registered non-Git directories", async (t) => {
  const { creator, dir } = setupCreator(t,
    appServerFixture());
  await creator.create(input);
  const launch = JSON.parse(readFileSync(join(dir, "launch.json"), "utf8"));
  assert.equal(launch.home, dir);
  assert.deepEqual(launch.args, ["app-server", "--stdio"]);
});

test("replays persisted creation after restart without launching again", async (t) => {
  const { creator, dir, store } = setupCreator(t,
    appServerFixture());
  const result = await creator.create(input);
  const restarted = new SessionCreator({ store, dataDir: join(dir, "remote-state"), executable: "missing-cli" });
  assert.deepEqual(await restarted.create(input), result);
  assert.equal(restarted.children.size, 0);
});

test("timeouts block repeat creation across service restarts", async (t) => {
  const { creator, dir, store } = setupCreator(t, 'setInterval(() => {}, 1000);', { startTimeoutMs: 100 });
  await assert.rejects(creator.create(input), e => e.statusCode === 504);
  const restarted = new SessionCreator({ store, dataDir: join(dir, "remote-state"), executable: "missing-cli" });
  await assert.rejects(restarted.create(input), e => e.statusCode === 409);
});

test("creates a persistent session with one safe prompt and coalesces duplicates", async (t) => {
  const { dir, cleanup } = fixture(t);
  const store = createCodexStore({ codexHome: dir });
  const cli = join(dir, "fake-codex.cjs");
  writeFileSync(cli, appServerFixture());
  const creator = new SessionCreator({
    store,
    dataDir: join(dir, "remote-state"),
    executable: process.execPath,
    prefixArgs: [cli],
  });
  t.after(async () => {
    await creator.stop();
    store.close();
    cleanup();
  });

  const text = "--help & echo injected; $(secret)\n中文";
  const [first, second] = await Promise.all([
    creator.create({ projectId: "p1", text, requestId, deviceId: "phone" }),
    creator.create({ projectId: "p1", text, requestId, deviceId: "phone" }),
  ]);
  assert.deepEqual(second, first);
  assert.equal(first.status, "created");
  assert.equal(first.threadId, "new-session");
  const requests = JSON.parse(readFileSync(join(dir, "requests.json"), "utf8"));
  const started = requests.filter(r => r.method === "thread/start");
  assert.equal(started.length, 1);
  assert.equal(started[0].params.projectId, "p1");
  assert.equal(started[0].params.cwd, dir);
  assert.equal(started[0].params.ephemeral, false);
  assert.equal(requests[0].params.capabilities.experimentalApi, true);
  assert.deepEqual(requests.find(r => r.method === "turn/start").params.input, [{type:"text",text,text_elements:[]}]);
  await assert.rejects(
    creator.create({
      projectId: "p1",
      text: "different",
      requestId,
      deviceId: "phone",
    }),
    (e) => e.statusCode === 409,
  );
});

test("refuses a source that desktop default lists would hide", async (t) => {
  const {creator, dir} = setupCreator(t, appServerFixture({source: "exec"}));
  await assert.rejects(creator.create(input), e => e.statusCode === 502);
  const requests = JSON.parse(readFileSync(join(dir, "requests.json"), "utf8"));
  assert.equal(requests.some(r => r.method === "turn/start"), false);
});

test("a failed first turn keeps the allocated thread id and blocks another creation", async (t) => {
  const {creator, dir} = setupCreator(t, appServerFixture({failTurn: true}));
  await assert.rejects(creator.create(input));
  const records = JSON.parse(readFileSync(join(dir, "remote-state", "new-threads.json"), "utf8"));
  assert.equal(Object.values(records)[0].threadId, "new-session");
  await assert.rejects(creator.create(input), e => e.statusCode === 409);
  assert.equal(readFileSync(join(dir,"calls.txt"),"utf8"), "spawn\n");
});

test("completed first turn releases its app-server process", async (t) => {
  const {creator} = setupCreator(t, appServerFixture({complete:true}));
  await creator.create(input);
  const children = [...creator.children];
  await Promise.all(children.map(child => new Promise(resolve => child.once("close",resolve))));
  assert.equal(creator.children.size, 0);
});

test("a completed turn response releases the process without a separate notification", {timeout: 4000}, async (t) => {
  const {creator} = setupCreator(t, appServerFixture({turnStatus: "completed"}));
  await creator.create(input);
  const children = [...creator.children];
  await Promise.all(children.map(child => new Promise(resolve => child.once("close",resolve))));
  assert.equal(creator.children.size, 0);
});

test("a failed turn response never confirms successful creation", async (t) => {
  const {creator} = setupCreator(t, appServerFixture({turnStatus: "failed"}));
  await assert.rejects(creator.create(input), e => e.statusCode === 502);
  await assert.rejects(creator.create(input), e => e.statusCode === 409);
});

test("completion arriving before the start response does not lose confirmation", async (t) => {
  const {creator} = setupCreator(t, appServerFixture({completeBeforeReply: true}));
  assert.equal((await creator.create(input)).status, "created");
});

test("rejects unknown projects before spawning the CLI", async (t) => {
  const { dir, cleanup } = fixture(t);
  const store = createCodexStore({ codexHome: dir });
  const creator = new SessionCreator({
    store,
    dataDir: join(dir, "remote-state"),
    executable: process.execPath,
  });
  t.after(async () => {
    await creator.stop();
    store.close();
    cleanup();
  });
  await assert.rejects(
    creator.create({
      projectId: "missing",
      text: "hello",
      requestId,
      deviceId: "phone",
    }),
    (e) => e.statusCode === 404,
  );
});

test("records failed creation as unknown and prevents an automatic duplicate", async (t) => {
  const { dir, cleanup } = fixture(t);
  const store = createCodexStore({ codexHome: dir });
  const cli = join(dir, "failing-codex.cjs");
  writeFileSync(cli, "process.stderr.write('provider unavailable'); process.exit(7);");
  const creator = new SessionCreator({
    store,
    dataDir: join(dir, "remote-state"),
    executable: process.execPath,
    prefixArgs: [cli],
  });
  t.after(async () => {
    await creator.stop();
    store.close();
    cleanup();
  });
  await assert.rejects(
    creator.create({
      projectId: "p1",
      text: "start",
      requestId,
      deviceId: "phone",
    }),
    (e) => e.statusCode === 502 && /状态未知/.test(e.message),
  );
  await assert.rejects(
    creator.create({
      projectId: "p1",
      text: "start",
      requestId,
      deviceId: "phone",
    }),
    (e) => e.statusCode === 409,
  );
});

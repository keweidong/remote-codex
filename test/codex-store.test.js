import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCodexStore } from "../src/codex-store.js";
import { fixture, threadId } from "./fixtures.js";

test("existing desktop project attribution excludes spawned agents and reads without altering DBs", (t) => {
  const { dir, cleanup } = fixture(t);
  const before = readFileSync(join(dir, "state_5.sqlite"));
  const store = createCodexStore({ codexHome: dir });
  t.after(() => {
    store.close();
    cleanup();
  });
  assert.deepEqual(
    store.listThreads({ projectId: "p1" }).map((x) => x.id),
    [threadId],
  );
  assert.equal(
    store.listThreads({ search: "Desktop" })[0].title,
    "Desktop title",
  );
  assert.equal(store.listProjects()[0].count, 1);
  assert.deepEqual(readFileSync(join(dir, "state_5.sqlite")), before);
  assert.throws(
    () => store.requireThread("missing"),
    (e) => e.statusCode === 404,
  );
});
test("history exposes only chat text and pages chronologically without reasoning/tool secrets", (t) => {
  const { dir, cleanup } = fixture(t);
  const store = createCodexStore({ codexHome: dir });
  t.after(() => {
    store.close();
    cleanup();
  });
  const latest = store.getThread(threadId, { limit: 2 });
  assert.deepEqual(
    latest.messages.map((x) => x.text),
    ["progress", "done"],
  );
  assert.equal(latest.hasMore, true);
  const earlier = store.getThread(threadId, {
    limit: 2,
    before: latest.nextBefore,
  });
  assert.deepEqual(
    earlier.messages.map((x) => x.text),
    ["hello"],
  );
  const all = JSON.stringify(store.getThread(threadId));
  assert.equal(all.includes("PRIVATE_"), false);
  assert.equal(all.includes("private-image"), false);
  assert.equal(latest.status, "completed");
});

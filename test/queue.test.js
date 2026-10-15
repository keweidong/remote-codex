import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, threadId } from "./fixtures.js";
import { createCodexStore } from "../src/codex-store.js";
import { Queue } from "../src/queue.js";

test("queue treats shell-looking text as a single value and coalesces duplicate submissions", async (t) => {
  const { dir, cleanup } = fixture(t);
  const store = createCodexStore({ codexHome: dir });
  t.after(() => {
    store.close();
    cleanup();
  });
  const cli = join(dir, "fake-cli.cjs"),
    output = join(dir, "args.jsonl");
  writeFileSync(
    cli,
    `require('node:fs').appendFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(2))+'\\n');console.log('Queued message message-1 for thread ${threadId}');`,
  );
  const q = new Queue({
    store,
    dataDir: dir,
    executable: process.execPath,
    prefixArgs: [cli],
  });
  const text = "--help & echo injected; $(secret)\n中文";
  const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const results = await Promise.all([
    q.send({ threadId, text, requestId, deviceId: "phone" }),
    q.send({ threadId, text, requestId, deviceId: "phone" }),
  ]);
  assert.equal(results[0].status, "queued");
  assert.equal(results[1].messageId, "message-1");
  const rows = readFileSync(output, "utf8").trim().split("\n");
  assert.equal(rows.length, 1);
  assert.ok(JSON.parse(rows[0]).includes("--message=" + text));
  await assert.rejects(
    q.send({ threadId, text: "different", requestId, deviceId: "phone" }),
    (e) => e.statusCode === 409,
  );
});

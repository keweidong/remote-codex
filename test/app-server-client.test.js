import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerClient } from "../src/app-server-client.js";

function setup(t, source, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codex-app-server-test-"));
  const script = join(dir, "server.cjs");
  writeFileSync(script, `
    const { createInterface } = require("node:readline");
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    const lines = createInterface({ input: process.stdin });
    ${source}
  `);
  const client = new AppServerClient({
    executable: process.execPath, prefixArgs: [script], cwd: dir,
    codexHome: dir, timeoutMs: 2000, ...options,
  });
  t.after(async () => {
    await client.close();
    assert.ok(dir.startsWith(join(tmpdir(), "codex-app-server-test-")));
    rmSync(dir, { recursive: true, force: true });
  });
  return { client, dir };
}

test("initializes once before requests and uses the selected CLI home and directory", async (t) => {
  const { client, dir } = setup(t, `
    const received = [];
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      received.push(message);
      if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fixture" } });
      if (message.method === "inspect") send({ id: message.id, result: {
        received, args: process.argv.slice(2), home: process.env.CODEX_HOME, cwd: process.cwd(),
      }});
    });
  `);
  assert.deepEqual(await Promise.all([client.initialize(), client.initialize()]), [
    { userAgent: "fixture" }, { userAgent: "fixture" },
  ]);
  const result = await client.request("inspect", {});
  assert.deepEqual(result.args, ["app-server", "--stdio"]);
  assert.equal(result.home, dir);
  assert.equal(result.cwd, dir);
  assert.deepEqual(result.received.map(({ method }) => method), ["initialize", "initialized", "inspect"]);
  assert.deepEqual(result.received[0].params, {
    clientInfo: { name: "codex_remote_web", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
});

test("proxy transport attaches to an existing control socket without starting a new app-server owner", async t => {
  const {client} = setup(t, `
    lines.on("line", line => {
      const m = JSON.parse(line);
      send({id:m.id,result:{args:process.argv.slice(2)}});
    });
  `, {transport: "proxy"});
  const result = await client.request("inspect");
  assert.deepEqual(result.args, ["app-server", "proxy"]);
});

test("correlates out-of-order responses and preserves split UTF-8 notifications", async (t) => {
  const { client } = setup(t, `
    let first;
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (!first) { first = message; return; }
      send({ id: message.id, result: message.params });
      const bytes = Buffer.from(JSON.stringify({ method: "turn/completed", params: { text: "中文🙂" } }) + "\\n");
      const split = bytes.indexOf(Buffer.from("中")) + 1;
      process.stdout.write(bytes.subarray(0, split));
      setTimeout(() => {
        process.stdout.write(bytes.subarray(split));
        send({ id: first.id, result: first.params });
      }, 20);
    });
  `);
  const notification = once(client, "notification");
  const text = "--help & echo injected; $(secret)\\n中文";
  const [first, second] = await Promise.all([
    client.request("first", { text }), client.request("second", { value: 2 }),
  ]);
  assert.deepEqual(first, { text });
  assert.deepEqual(second, { value: 2 });
  assert.deepEqual(await notification, ["turn/completed", { text: "中文🙂" }]);
});

test("rejects server requests without accepting approvals", async (t) => {
  const { client } = setup(t, `
    let original;
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "start") {
        original = message;
        send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { command: "private command" } });
      } else if (message.id === "approval-1") send({ id: original.id, result: message });
    });
  `);
  const rejected = once(client, "serverRequestRejected");
  const reply = await client.request("start", {});
  assert.equal(reply.id, "approval-1");
  assert.equal(reply.error.code, -32601);
  assert.equal(Object.hasOwn(reply, "result"), false);
  assert.deepEqual(await rejected, ["item/commandExecution/requestApproval"]);
});

test("returns explicit RPC error text and code without copying private error data", async (t) => {
  const { client } = setup(t, `
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      send({ id: message.id, error: { code: -32602, message: "Unknown project", data: { secret: "PRIVATE_DATA" } } });
    });
  `);
  await assert.rejects(client.request("project/read", { id: "missing" }), (error) => {
    assert.equal(error.code, -32602);
    assert.match(error.message, /Unknown project/);
    assert.equal(JSON.stringify(error).includes("PRIVATE_DATA"), false);
    assert.equal(Object.hasOwn(error, "data"), false);
    return true;
  });
});

test("times out individual requests without killing an active session", async (t) => {
  const { client } = setup(t, `
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "ping") send({ id: message.id, result: "pong" });
    });
  `, { timeoutMs: 300 });
  await assert.rejects(client.request("silent", {}), (error) => error.code === "ETIMEDOUT" && error.statusCode === 504);
  assert.equal(await client.request("ping", {}), "pong");
  assert.equal(client.child.killed, false);
});

test("close rejects pending requests, stops the owned process, and is idempotent", async (t) => {
  const { client } = setup(t, 'lines.on("line", () => {});');
  const pending = assert.rejects(client.request("silent", {}), (error) => error.code === "ECLOSED");
  let closedCount = 0;
  client.on("closed", () => { closedCount += 1; });
  await Promise.all([client.close(), client.close(), pending]);
  assert.equal(closedCount, 1);
  assert.ok(client.child.exitCode !== null || client.child.signalCode !== null);
  await assert.rejects(client.request("later", {}), (error) => error.code === "ECLOSED");
});

test("process failure rejects pending requests without exposing stderr", async (t) => {
  const { client } = setup(t, `
    lines.on("line", () => {
      process.stderr.write("PRIVATE_PROVIDER_TOKEN");
      process.exit(7);
    });
  `);
  const closed = once(client, "closed");
  await assert.rejects(client.request("start", {}), (error) => {
    assert.match(error.message, /7/);
    assert.equal(error.message.includes("PRIVATE_PROVIDER_TOKEN"), false);
    return true;
  });
  assert.equal((await closed)[0].message.includes("PRIVATE_PROVIDER_TOKEN"), false);
});

test("spawn failure rejects promptly and close still settles", async (t) => {
  const { client } = setup(t, "", { executable: join(tmpdir(), "codex-missing-executable-for-test") });
  await assert.rejects(client.request("initialize", {}), (error) => error.code === "ESPAWN" && error.statusCode === 503);
  await client.close();
});

test("synchronous spawn failures use the same safe transport error", async (t) => {
  const { client } = setup(t, "", { executable: "" });
  await assert.rejects(client.request("initialize", {}), (error) => error.code === "ESPAWN" && error.statusCode === 503);
  await client.close();
});

test("close terminates a process that ignores the end of stdin", async (t) => {
  const { client } = setup(t, `
    setInterval(() => {}, 1000);
    lines.on("line", (line) => send({ id: JSON.parse(line).id, result: "ready" }));
  `);
  await client.request("ping", {});
  await client.close();
  assert.equal(client.child.killed, true);
  assert.ok(client.child.exitCode !== null || client.child.signalCode !== null);
});

test("malformed protocol output closes safely without returning the raw body", async (t) => {
  const { client } = setup(t, 'lines.on("line", () => process.stdout.write("PRIVATE_BAD_BODY\\n"));');
  await assert.rejects(client.request("start", {}), (error) => {
    assert.equal(error.code, "EPROTOCOL");
    assert.equal(error.message.includes("PRIVATE_BAD_BODY"), false);
    return true;
  });
});

test("bounds unterminated stdout lines and closes the noisy process", async (t) => {
  const { client } = setup(t, 'lines.on("line", () => process.stdout.write("x".repeat(9 * 1024 * 1024)));');
  await assert.rejects(client.request("start", {}), (error) => error.code === "EPROTOCOL");
  await client.close();
  assert.equal(client.child.killed, true);
});

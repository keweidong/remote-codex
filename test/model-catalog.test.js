import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalog } from "../src/model-catalog.js";

const model = (id, levels, defaultEffort, extra = {}) => ({
  id: `preset-${id}`, model: id, displayName: `Name ${id}`, hidden: false,
  supportedReasoningEfforts: levels.map((reasoningEffort) => ({ reasoningEffort, description: "detail" })),
  defaultReasoningEffort: defaultEffort, ...extra,
});

function setup(t, { pages, config, fail, delay = 0, ...options } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codex-model-catalog-"));
  const script = join(dir, "server.cjs");
  const log = join(dir, "requests.jsonl");
  const data = {
    pages: pages ?? [{ data: [model("alpha", ["low", "high"], "low", { isDefault: true }), model("beta", ["medium"], "medium")], nextCursor: null }],
    config: config ?? { model: "alpha", model_reasoning_effort: "high", api_key: "fixture-secret" }, fail, delay,
  };
  writeFileSync(script, `
    const fs = require("node:fs");
    const { createInterface } = require("node:readline");
    const data = ${JSON.stringify(data)};
    const log = ${JSON.stringify(log)};
    fs.appendFileSync(log, JSON.stringify({ method: "spawn", args: process.argv.slice(2), home: process.env.CODEX_HOME, cwd: process.cwd() }) + "\\n");
    let initialized = false;
    createInterface({ input: process.stdin }).on("line", (line) => {
      const request = JSON.parse(line);
      fs.appendFileSync(log, line + "\\n");
      if (request.method === "initialized") { initialized = true; return; }
      if (request.method === "initialize") {
        process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n"); return;
      }
      if (!initialized) process.exit(10);
      if (data.fail === "hang") return;
      setTimeout(() => {
        let response;
        if (data.fail) response = { error: { code: -1, message: "fixture-secret " + data.fail } };
        else if (request.method === "model/list") response = { result: data.pages[Number(request.params.cursor ?? 0)] };
        else if (request.method === "config/read") response = { result: { config: data.config, layers: [{ secret: "fixture-secret" }] } };
        else process.exit(11);
        process.stdout.write(JSON.stringify({ id: request.id, ...response }) + "\\n");
      }, data.delay);
    });
  `);
  const catalog = new ModelCatalog({ executable: process.execPath, prefixArgs: [script], codexHome: dir, cwd: dir, timeoutMs: 2000, ...options });
  t.after(async () => {
    await catalog.stop();
    assert.ok(dir.startsWith(join(tmpdir(), "codex-model-catalog-")));
    rmSync(dir, { recursive: true, force: true });
  });
  return { catalog, dir, requests: () => readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) };
}

test("empty selection and malformed options do not start a child", async () => {
  const catalog = new ModelCatalog({ executable: "does-not-exist-catalog-fixture" });
  assert.deepEqual(await catalog.normalize(), {});
  assert.deepEqual(await catalog.normalize({ model: " ", effort: "" }), {});
  for (const options of [null, [], "alpha", { model: 1 }, { effort: false }, { model: {} }, { model: "alpha\n" }, { other: "x" }])
    await assert.rejects(catalog.normalize(options), { statusCode: 400 });
  await catalog.stop();
});

test("reads official paginated catalog, filters hidden/invalid models, and exposes only safe fields", async (t) => {
  const { catalog, dir, requests } = setup(t, { pages: [
    { data: [model("alpha", ["low", "high"], "low"), model("hidden", ["low"], "low", { hidden: true }), { model: null }], nextCursor: "1" },
    { data: [model("beta", ["medium"], "medium"), model("alpha", ["low"], "low")], nextCursor: null },
  ] });
  const result = await catalog.list();
  assert.deepEqual(result.models.map(({ id, name, efforts }) => [id, name, efforts.map(({ id }) => id)]), [
    ["alpha", "Name alpha", ["low", "high"]], ["beta", "Name beta", ["medium"]],
  ]);
  assert.equal(result.defaultModel, "alpha");
  assert.equal(result.defaultEffort, "high");
  assert.equal(result.models[0].defaultEffort, "low");
  assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
  const calls = requests();
  assert.deepEqual(calls[0], { method: "spawn", args: ["app-server", "--stdio"], home: dir, cwd: dir });
  assert.deepEqual(calls.filter(({ method }) => method === "model/list").map(({ params }) => params), [
    { includeHidden: false }, { includeHidden: false, cursor: "1" },
  ]);
  assert.deepEqual(calls.find(({ method }) => method === "config/read").params, { includeLayers: false });
});

test("normalization validates model-specific efforts and selects model defaults", async (t) => {
  const { catalog } = setup(t);
  assert.deepEqual(await catalog.normalize({ model: "beta" }), { model: "beta", effort: "medium" });
  assert.deepEqual(await catalog.normalize({ model: " alpha ", effort: " high " }), { model: "alpha", effort: "high" });
  assert.deepEqual(await catalog.normalize({ effort: "medium" }, { currentModel: "beta" }), { model: "beta", effort: "medium" });
  assert.deepEqual(await catalog.normalize({ effort: "high" }), { model: "alpha", effort: "high" });
  for (const options of [{ model: "unknown" }, { model: "beta", effort: "high" }, { model: "alpha", effort: "ultra" }])
    await assert.rejects(catalog.normalize(options), { statusCode: 400 });
  await assert.rejects(catalog.normalize({ effort: "low" }, { currentModel: "unknown" }), { statusCode: 400 });
});

test("honors configured default model and ignores unsupported configured effort", async (t) => {
  const { catalog } = setup(t, { config: { model: "beta", model_reasoning_effort: "high" } });
  const result = await catalog.list();
  assert.equal(result.defaultModel, "beta");
  assert.equal(result.defaultEffort, "medium");
});

test("uses catalog default when configured model is unavailable; permits only advertised future effort IDs", async (t) => {
  const { catalog } = setup(t, {
    config: { model: "unavailable", model_reasoning_effort: "high" },
    pages: [{ data: [model("alpha", [], "none"), model("beta", ["future-effort"], "future-effort", { isDefault: true })] }],
  });
  assert.equal((await catalog.list()).defaultModel, "beta");
  assert.deepEqual(await catalog.normalize({ model: "alpha" }), { model: "alpha" });
  assert.deepEqual(await catalog.normalize({ model: "beta" }), { model: "beta", effort: "future-effort" });
  await assert.rejects(catalog.normalize({ model: "alpha", effort: "none" }), { statusCode: 400 });
});

test("coalesces concurrent reads, caches results, and protects cache from caller mutations", async (t) => {
  const { catalog, requests } = setup(t, { delay: 20 });
  const results = await Promise.all(Array.from({ length: 8 }, () => catalog.list()));
  results[0].models[0].efforts.length = 0;
  assert.equal((await catalog.list()).models[0].efforts.length, 2);
  assert.equal(requests().filter(({ method }) => method === "spawn").length, 1);
});

test("expired cache refreshes through a new owned child", async (t) => {
  const { catalog, requests } = setup(t, { ttlMs: 0 });
  await catalog.list();
  await catalog.list();
  assert.equal(requests().filter(({ method }) => method === "spawn").length, 2);
});

test("catalog failures are sanitized 503 responses and not cached", async (t) => {
  const { catalog, requests } = setup(t, { fail: "provider error" });
  for (let i = 0; i < 2; i++) await assert.rejects(catalog.list(), (error) => error.statusCode === 503 && !error.message.includes("fixture-secret"));
  assert.equal(requests().filter(({ method }) => method === "spawn").length, 2);
});

test("rejects empty catalogs and repeated pagination cursors", async (t) => {
  const empty = setup(t, { pages: [{ data: [] }] });
  await assert.rejects(empty.catalog.list(), { statusCode: 503 });
  const loop = setup(t, { pages: [{ data: [model("alpha", ["low"], "low")], nextCursor: "0" }] });
  await assert.rejects(loop.catalog.list(), { statusCode: 503 });
});

test("stop closes the pending child and rejects subsequent reads", async (t) => {
  const { catalog } = setup(t, { fail: "hang" });
  const pending = assert.rejects(catalog.list(), { statusCode: 503 });
  await catalog.stop();
  await pending;
  await assert.rejects(catalog.list(), { statusCode: 503 });
});

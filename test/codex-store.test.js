import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
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

test("migrated desktop projects use canonical IDs for listing, assignments, and creation lookup", (t) => {
  const { dir, cleanup } = fixture(t);
  const projectRoot = join(dir, "workspace");
  const db = new DatabaseSync(join(dir, "state_5.sqlite"));
  db.prepare("INSERT INTO projects VALUES(?,?,?)").run("p2", "Separate project", 1);
  db.prepare("INSERT INTO project_roots VALUES(?,?,?)").run("p2", projectRoot, 0);
  db.prepare("UPDATE threads SET cwd=? WHERE id=?").run("/outside-project", threadId);
  db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?)").run(
    "canonical-thread", "Canonical chat", projectRoot, "p1", 0, 3000,
    "fixture-model", "/root", "cli",
  );
  db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?)").run(
    "separate-thread", "Separate chat", projectRoot, "p2", 0, 4000,
    "fixture-model", "/root", "cli",
  );
  db.close();
  const metadataPath = join(dir, ".codex-global-state.json");
  writeFileSync(metadataPath, JSON.stringify({
    "local-projects": {
      "legacy-p1": { name: "Desktop project name", rootPaths: [projectRoot] },
    },
    "app-server-project-id-by-legacy-project-id-by-host": {
      [`local:${dir}-other`]: { "legacy-p1": "p2" },
      [`local:${dir}`]: { "legacy-p1": "p1" },
    },
    "thread-project-assignments": {
      [threadId]: { projectId: "legacy-p1" },
      "separate-thread": { projectId: "legacy-p1" },
    },
  }));
  const beforeState = readFileSync(join(dir, "state_5.sqlite"));
  const beforeMetadata = readFileSync(metadataPath);
  const store = createCodexStore({ codexHome: dir });
  t.after(() => { store.close(); cleanup(); });

  assert.deepEqual(store.listProjects(), [
    { id: "p1", name: "Desktop project name", paths: [projectRoot], count: 2 },
    { id: "p2", name: "Separate project", paths: [projectRoot], count: 1 },
  ]);
  assert.equal(store.requireThread(threadId).projectId, "p1");
  assert.equal(store.requireThread("separate-thread").projectId, "p2");
  assert.deepEqual(store.listThreads({ projectId: "p1" }).map((x) => x.id), [
    "canonical-thread", threadId,
  ]);
  assert.deepEqual(store.listThreads({ projectId: "legacy-p1" }).map((x) => x.id), [
    "canonical-thread", threadId,
  ]);
  assert.deepEqual(store.requireProject("legacy-p1"), {
    id: "p1", name: "Desktop project name", paths: [projectRoot],
  });
  assert.deepEqual(readFileSync(join(dir, "state_5.sqlite")), beforeState);
  assert.deepEqual(readFileSync(metadataPath), beforeMetadata);
});

for (const host of [null, "other-home", "remote"]) {
  test(`legacy-only project remains independent when mapping host is ${host || "absent"}`, (t) => {
    const { dir, cleanup } = fixture(t);
    const mappingHost = host === "remote" ? `remote:${dir}` : `local:${dir}-other`;
    writeFileSync(join(dir, ".codex-global-state.json"), JSON.stringify({
      "local-projects": {
        "legacy-p1": { name: "Independent project", rootPaths: [dir] },
      },
      ...(host ? {
        "app-server-project-id-by-legacy-project-id-by-host": {
          [mappingHost]: { "legacy-p1": "p1" },
        },
      } : {}),
      "thread-project-assignments": { [threadId]: { projectId: "legacy-p1" } },
    }));
    const store = createCodexStore({ codexHome: dir });
    t.after(() => { store.close(); cleanup(); });

    assert.deepEqual(store.listProjects().map(({ id, count }) => ({ id, count })), [
      { id: "p1", count: 0 },
      { id: "legacy-p1", count: 1 },
    ]);
    assert.equal(store.requireProject("legacy-p1").id, "legacy-p1");
    assert.equal(store.requireThread(threadId).projectId, "legacy-p1");
  });
}

test("legacy assignments resolve without local project details using the current home's normalized path", (t) => {
  const { dir, cleanup } = fixture(t);
  const db = new DatabaseSync(join(dir, "state_5.sqlite"));
  db.prepare("UPDATE threads SET cwd=? WHERE id=?").run("/outside-project", threadId);
  db.close();
  writeFileSync(join(dir, ".codex-global-state.json"), JSON.stringify({
    "app-server-project-id-by-legacy-project-id-by-host": {
      [`local:${dir.toUpperCase().replaceAll("\\", "/")}/`]: { "legacy-p1": "p1" },
    },
    "thread-project-assignments": { [threadId]: { projectId: "legacy-p1" } },
  }));
  const store = createCodexStore({ codexHome: dir });
  t.after(() => { store.close(); cleanup(); });

  assert.equal(store.requireThread(threadId).projectId, "p1");
  assert.equal(store.requireProject("legacy-p1").id, "p1");
  assert.deepEqual(store.listProjects(), [
    { id: "p1", name: "Project One", paths: [dir], count: 1 },
  ]);
});

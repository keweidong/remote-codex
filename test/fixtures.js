import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const threadId = "11111111-1111-4111-8111-111111111111";
export function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "codex-remote-fixture-"));
  const cleanup = () => {
    if (!dir.startsWith(join(tmpdir(), "codex-remote-fixture-")))
      throw new Error("Unsafe fixture cleanup");
    rmSync(dir, { recursive: true, force: true });
  };
  const db = new DatabaseSync(join(dir, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,project_id TEXT,archived INTEGER,updated_at_ms INTEGER,model TEXT,agent_path TEXT,source TEXT);
  CREATE TABLE projects(id TEXT,name TEXT,position INTEGER); CREATE TABLE project_roots(project_id TEXT,path TEXT,position INTEGER);
  CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT);`);
  db.prepare("INSERT INTO projects VALUES(?,?,?)").run("p1", "Project One", 0);
  db.prepare("INSERT INTO project_roots VALUES(?,?,?)").run("p1", dir, 0);
  db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?)").run(
    threadId,
    "Fixture chat",
    dir,
    null,
    0,
    1000,
    "fixture-model",
    "/root",
    "cli",
  );
  db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?)").run(
    "child",
    "Secret subagent",
    dir,
    "p1",
    0,
    2000,
    "fixture-model",
    "/root/child",
    "cli",
  );
  db.prepare("INSERT INTO thread_spawn_edges VALUES(?,?,?)").run(
    threadId,
    "child",
    "completed",
  );
  db.close();
  writeFileSync(
    join(dir, ".codex-global-state.json"),
    JSON.stringify({
      "thread-project-assignments": { [threadId]: { projectId: "p1" } },
      "electron-persisted-atom-state": {
        "thread-descriptions-v1": { [threadId]: "Desktop title" },
      },
    }),
  );
  const hist = new DatabaseSync(join(dir, "thread_history_1.sqlite"));
  hist.exec(`CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_json TEXT,item_type TEXT);
  CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,status TEXT,error_json TEXT);`);
  const add = (ord, item) =>
    hist
      .prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)")
      .run(
        threadId,
        "turn1",
        "item" + ord,
        ord,
        ord * 1000,
        JSON.stringify(item),
        item.type,
      );
  add(1, {
    type: "userMessage",
    content: [
      { type: "text", text: "hello" },
      { type: "image", url: "private-image" },
    ],
  });
  add(2, { type: "reasoning", content: ["PRIVATE_REASONING"] });
  add(3, { type: "mcpToolCall", arguments: { token: "PRIVATE_TOOL_SECRET" } });
  add(4, { type: "agentMessage", text: "progress", phase: "commentary" });
  add(5, { type: "agentMessage", text: "done", phase: "final" });
  hist
    .prepare("INSERT INTO thread_turns VALUES(?,?,?,?,?)")
    .run(threadId, "turn1", 1, "completed", null);
  hist.close();
  return { dir, cleanup };
}

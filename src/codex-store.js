import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { error } from "./auth.js";

const cleanPath = (p) =>
  String(p || "")
    .replace(/^\\\\\?\\/, "")
    .replaceAll("\\", "/")
    .replace(/\/$/, "")
    .toLowerCase();
const text = (value) => (typeof value === "string" ? value : "");
export function createCodexStore({ codexHome }) {
  const statePath = join(codexHome, "state_5.sqlite"),
    historyPath = join(codexHome, "thread_history_1.sqlite");
  if (!existsSync(statePath))
    throw error("未找到 Codex 会话数据库，请先启动 Codex Desktop。", 503);
  const db = new DatabaseSync(statePath, { readOnly: true });
  db.exec("PRAGMA busy_timeout=2000");
  const history = existsSync(historyPath)
    ? new DatabaseSync(historyPath, { readOnly: true })
    : null;
  history?.exec("PRAGMA busy_timeout=2000");
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name),
  );
  const historyTables = new Set(
    history
      ?.prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name) || [],
  );
  let metaTime = -1,
    meta = {};
  function metadata() {
    try {
      const path = join(codexHome, ".codex-global-state.json"),
        mtime = statSync(path).mtimeMs;
      if (mtime !== metaTime) {
        meta = JSON.parse(readFileSync(path, "utf8"));
        metaTime = mtime;
      }
    } catch {}
    return meta;
  }
  function projects() {
    const result = new Map();
    if (tables.has("projects"))
      for (const p of db
        .prepare("SELECT * FROM projects ORDER BY position")
        .all())
        result.set(p.id, { id: p.id, name: p.name, paths: [] });
    if (tables.has("project_roots"))
      for (const r of db
        .prepare("SELECT * FROM project_roots ORDER BY position")
        .all())
        result.get(r.project_id)?.paths.push(r.path);
    for (const [id, p] of Object.entries(metadata()["local-projects"] || {})) {
      if (!p || typeof p !== "object") continue;
      const roots = (Array.isArray(p.rootPaths) ? p.rootPaths : []).filter(
        (x) => typeof x === "string",
      );
      const found = result.get(id);
      result.set(id, {
        id,
        name: p.name || found?.name || id,
        paths: roots.length ? roots : found?.paths || [],
      });
    }
    return result;
  }
  function rawRows() {
    return db
      .prepare(
        `SELECT * FROM threads WHERE archived=0 ${tables.has("thread_spawn_edges") ? "AND id NOT IN (SELECT child_thread_id FROM thread_spawn_edges)" : ""} ORDER BY updated_at_ms DESC LIMIT 5000`,
      )
      .all()
      .filter((r) => !r.agent_path || r.agent_path === "/root");
  }
  function state(id) {
    if (!historyTables.has("thread_turns")) return "unknown";
    return (
      history
        .prepare(
          "SELECT status FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1",
        )
        .get(id)?.status || "unknown"
    );
  }
  function projectFor(row, ps) {
    const assigned = metadata()["thread-project-assignments"]?.[row.id];
    const id = row.project_id || assigned?.projectId;
    if (id && ps.has(id)) return ps.get(id);
    const root = cleanPath(row.cwd);
    let match = null,
      longest = -1;
    for (const p of ps.values())
      for (const path of p.paths) {
        const key = cleanPath(path);
        if (
          key &&
          (root === key || root.startsWith(key + "/")) &&
          key.length > longest
        ) {
          match = p;
          longest = key.length;
        }
      }
    return match;
  }
  function projectThread(row, ps) {
    const p = projectFor(row, ps);
    const desc =
      metadata()["electron-persisted-atom-state"]?.["thread-descriptions-v1"]?.[
        row.id
      ];
    return {
      id: row.id,
      title: text(desc) || text(row.title) || text(row.name) || "未命名会话",
      cwd: row.cwd,
      projectId: p?.id || "__unassigned__",
      projectName: p?.name || "未分组",
      updatedAt: row.updated_at_ms || row.updated_at * 1000 || 0,
      status: state(row.id),
      model: row.model || "",
    };
  }
  function requireThread(id) {
    if (typeof id !== "string" || id.length > 128)
      throw error("找不到这个会话。", 404);
    const row = db
      .prepare("SELECT * FROM threads WHERE id=? AND archived=0")
      .get(id);
    if (
      !row ||
      (row.agent_path && row.agent_path !== "/root") ||
      (tables.has("thread_spawn_edges") &&
        db
          .prepare("SELECT 1 FROM thread_spawn_edges WHERE child_thread_id=?")
          .get(id))
    )
      throw error("找不到这个会话。", 404);
    return projectThread(row, projects());
  }
  function listThreads({ projectId = "", search = "", limit = 100 } = {}) {
    const ps = projects(),
      term = String(search).toLowerCase().slice(0, 200);
    return rawRows()
      .map((r) => projectThread(r, ps))
      .filter(
        (r) =>
          (!projectId || r.projectId === projectId) &&
          (!term ||
            [r.title, r.projectName, r.cwd].some((v) =>
              String(v).toLowerCase().includes(term),
            )),
      )
      .slice(0, Math.min(Math.max(Number(limit) || 100, 1), 500));
  }
  function listProjects() {
    const ps = projects();
    const counts = new Map();
    for (const row of rawRows()) {
      const id = projectFor(row, ps)?.id || "__unassigned__";
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    const values = [...ps.values()].map((p) => ({
      ...p,
      count: counts.get(p.id) || 0,
    }));
    if (counts.has("__unassigned__"))
      values.push({
        id: "__unassigned__",
        name: "未分组",
        paths: [],
        count: counts.get("__unassigned__"),
      });
    return values;
  }
  function getThread(id, { limit = 80, before } = {}) {
    const thread = requireThread(id);
    const status = thread.status;
    if (!historyTables.has("thread_items"))
      return {
        thread,
        messages: [],
        status,
        hasMore: false,
        nextBefore: null,
        activity: "",
        warning: "当前 Codex 版本没有可读取的分页历史，请在桌面查看历史。",
      };
    const size = Math.min(Math.max(Number(limit) || 80, 1), 200);
    const cursor =
      before === undefined ? Number.MAX_SAFE_INTEGER : Number(before);
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw error("历史分页参数无效。");
    const rows = history
      .prepare(
        "SELECT item_id,rollout_ordinal,created_at_ms,item_json FROM thread_items WHERE thread_id=? AND item_type IN ('userMessage','agentMessage') AND rollout_ordinal<? ORDER BY rollout_ordinal DESC LIMIT ?",
      )
      .all(id, cursor, size + 1);
    const hasMore = rows.length > size;
    const selected = rows.slice(0, size).reverse();
    const messages = [];
    for (const row of selected) {
      let item;
      try {
        item = JSON.parse(row.item_json);
      } catch {
        continue;
      }
      let body = "";
      let role = "assistant";
      if (item.type === "userMessage") {
        role = "user";
        body = (item.content || [])
          .filter((x) => x.type === "text")
          .map((x) => text(x.text))
          .join("\n");
      } else if (item.type === "agentMessage") body = text(item.text);
      else continue;
      messages.push({
        id: row.item_id,
        role,
        text: body.slice(0, 150000),
        phase: text(item.phase),
        createdAt: row.created_at_ms,
        ordinal: row.rollout_ordinal,
      });
    }
    const last = history
      .prepare(
        "SELECT item_type FROM thread_items WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1",
      )
      .get(id);
    const labels = {
      commandExecution: "执行命令",
      mcpToolCall: "调用工具",
      fileChange: "修改文件",
      webSearch: "检索资料",
      reasoning: "处理中",
      agentMessage: "生成回复",
      userMessage: "处理消息",
    };
    return {
      thread,
      messages,
      status,
      hasMore,
      nextBefore: hasMore ? selected[0]?.rollout_ordinal : null,
      activity:
        status === "inProgress" ? labels[last?.item_type] || "处理中" : "",
      warning: "",
    };
  }
  return {
    listProjects,
    listThreads,
    getThread,
    requireThread,
    close() {
      history?.close();
      db.close();
    },
  };
}

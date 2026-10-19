import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { createCodexStore } from "./codex-store.js";
import { createApp } from "./server.js";
import { Queue } from "./queue.js";
import { SessionCreator } from "./session-creator.js";
import {ModelCatalog} from './model-catalog.js';
import {ConfiguredTurns} from './configured-turn.js';
import { saveJson } from "./auth.js";

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const dataDir =
  process.env.CODEX_REMOTE_DATA ||
  join(process.env.LOCALAPPDATA || homedir(), "CodexRemoteWeb");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const tokenPath = join(dataDir, "admin-key");
if (!existsSync(tokenPath))
  writeFileSync(tokenPath, randomBytes(32).toString("base64url"), {
    mode: 0o600,
  });
const adminToken = readFileSync(tokenPath, "utf8").trim();
if (adminToken.length < 32) throw new Error("管理凭据无效");
const runtimePath = join(dataDir, "runtime.json");
// A hard kill leaves runtime.json pointing at a dead pid. Drop that record so
// the launcher never trusts it. EPERM means the process exists, so keep it.
function staleRuntime(file) {
  let record;
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
  if (!record || typeof record.pid !== "number" || record.pid === process.pid)
    return false;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
}
if (staleRuntime(runtimePath)) {
  try {
    unlinkSync(runtimePath);
  } catch {}
}
const cloudflaredPath =
  process.env.CLOUDFLARED_PATH ||
  join(
    homedir(),
    ".dsh",
    "profiles",
    "desktop",
    "node_modules",
    "cloudflared",
    "bin",
    "cloudflared.exe",
  );
const store = createCodexStore({ codexHome });
const models=new ModelCatalog({executable:process.env.CODEX_CLI_PATH||'codex',codexHome,cwd:resolve(import.meta.dirname,'..')});
const configuredTurns=new ConfiguredTurns({store,executable:process.env.CODEX_CLI_PATH||'codex',codexHome});
const queue = new Queue({
  store,
  dataDir,
  executable: process.env.CODEX_CLI_PATH || "codex",
  models,
  configuredTurns,
});
const creator = new SessionCreator({
  store,
  dataDir,
  codexHome,
  executable: process.env.CODEX_CLI_PATH || "codex",
  models,
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await app.stop();
  store.close();
  try {
    unlinkSync(runtimePath);
  } catch {}
  process.exit(0);
};
const app = createApp({
  store,
  queue,
  creator,
  models,
  dataDir,
  adminToken,
  cloudflaredPath,
  onShutdown: stop,
});
try {
  const urls = await app.start({
    adminPort: Number(process.env.CODEX_REMOTE_ADMIN_PORT) || 8765,
    phonePort: Number(process.env.CODEX_REMOTE_PHONE_PORT) || 8766,
    phoneHost: process.env.CODEX_REMOTE_HOST || "0.0.0.0",
  });
  saveJson(runtimePath, {
    pid: process.pid,
    projectDir: resolve(import.meta.dirname, ".."),
    ...urls,
    startedAt: Date.now(),
  });
  console.log(`Codex Remote Web ready: ${urls.adminUrl}`);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (e) {
  store.close();
  console.error(`启动失败：${e.message}`);
  process.exitCode = 1;
}

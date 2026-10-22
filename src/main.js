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
import { TurnControls } from "./turn-controls.js";
import { saveJson } from "./auth.js";
import { Relay } from "./relay.js";

// The cloudflared npm package ships the platform binary via postinstall; when
// it was installed with --ignore-scripts the binary is missing and install()
// downloads it on demand. Both imports are optional so a machine that already
// provides cloudflared elsewhere keeps working without the package.
let cloudflaredNpmBin = "",
  installCloudflared = null;
try {
  const cf = await import("cloudflared");
  cloudflaredNpmBin = typeof cf.bin === "string" ? cf.bin : "";
  installCloudflared = typeof cf.install === "function" ? cf.install : null;
} catch {}

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
const dshCloudflared = join(
  homedir(),
  ".dsh",
  "profiles",
  "desktop",
  "node_modules",
  "cloudflared",
  "bin",
  "cloudflared.exe",
);
function pickCloudflared() {
  // Explicit configuration wins; then the npm-package binary (also the target
  // of the background download below); then the DSH-bundled copy for machines
  // that happen to have DeepSeek Harness installed.
  if (process.env.CLOUDFLARED_PATH) return process.env.CLOUDFLARED_PATH;
  if (cloudflaredNpmBin && existsSync(cloudflaredNpmBin))
    return cloudflaredNpmBin;
  if (existsSync(dshCloudflared)) return dshCloudflared;
  return cloudflaredNpmBin || dshCloudflared;
}
const cloudflaredPath = pickCloudflared();
// A fresh machine has no binary yet: download it in the background (~55 MB,
// one time) instead of blocking startup. Tunnel availability is checked live,
// so the admin page picks the binary up as soon as it lands, and the
// retryAutostart hook below reconnects a fixed-domain tunnel that skipped its
// boot autostart while the download was still running.
let cloudflaredReady = Promise.resolve(true);
if (
  !process.env.CLOUDFLARED_PATH &&
  installCloudflared &&
  !existsSync(cloudflaredPath)
) {
  console.log("首次运行：正在后台下载 cloudflared（约 55 MB，仅一次）…");
  cloudflaredReady = installCloudflared()
    .then(() => true)
    .catch((e) => {
      console.error(`cloudflared 后台下载失败：${e?.message || e}`);
      return false;
    });
}
const relay = new Relay({ dataDir });
const store = createCodexStore({ codexHome });
const controls = new TurnControls({
  store, dataDir, executable: process.env.CODEX_CLI_PATH || "codex",
  codexHome, cwd: resolve(import.meta.dirname, ".."),
});
const models=new ModelCatalog({executable:process.env.CODEX_CLI_PATH||'codex',codexHome,cwd:resolve(import.meta.dirname,'..')});
const configuredTurns=new ConfiguredTurns({store,executable:process.env.CODEX_CLI_PATH||'codex',codexHome,controls});
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
  controls,
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
  controls,
  dataDir,
  adminToken,
  cloudflaredPath,
  relay,
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
  cloudflaredReady.then((ok) => {
    if (ok) app.retryAutostart();
  });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (e) {
  store.close();
  console.error(`启动失败：${e.message}`);
  process.exitCode = 1;
}

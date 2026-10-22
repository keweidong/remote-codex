import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { AuthStore, error, equalSecret } from "./auth.js";
import { Tunnel, loadTunnelConfig } from "./tunnel.js";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const capabilities = {
  read: true,
  send: true,
  create: true,
  continue: true,
  interrupt: false,
  steer: false,
  queueResume: false,
  approvals: false,
  statusSource: "persisted-history",
  modelSelection:true,
};
function json(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
function cookie(req, name) {
  try {
    const pair = (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(name + "="));
    return pair ? decodeURIComponent(pair.slice(name.length + 1)) : "";
  } catch {
    return "";
  }
}
function setCookie(
  res,
  name,
  value,
  { secure = false, maxAge = 30 * 86400 } = {},
) {
  res.setHeader(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`,
  );
}
function requireOrigin(req, extraOrigins = []) {
  const origin = req.headers.origin,
    host = req.headers.host;
  if (
    !origin ||
    ![`http://${host}`, `https://${host}`, ...extraOrigins].includes(origin)
  )
    throw error("请求来源无效，请刷新当前页面后重试。", 403);
  if (
    !(req.headers["content-type"] || "")
      .toLowerCase()
      .startsWith("application/json")
  )
    throw error("请求必须使用 JSON。", 415);
}
async function body(req) {
  let value = "";
  for await (const chunk of req) {
    value += chunk;
    if (Buffer.byteLength(value) > 40000) throw error("请求内容过大。", 413);
  }
  try {
    return JSON.parse(value || "{}");
  } catch {
    throw error("请求格式无效。");
  }
}
function headers(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
}
export function createApp({
  store,
  queue,
  creator,
  models,
  controls,
  dataDir,
  adminToken,
  cloudflaredPath,
  cloudflaredPrefixArgs = [],
  relay = null,
  onShutdown,
}) {
  const auth = new AuthStore({ dataDir });
  const appCapabilities = {...capabilities, interrupt: !!controls, steer: !!controls, queueResume: !!controls};
  const adminSessions = new Map(),
    limits = new Map();
  let adminPort,
    phonePort,
    phoneHost,
    tunnel,
    servers = [];
  let stopping=false,stopPromise;
  function rate(key, max = 20) {
    const now = Date.now();
    if (limits.size > 2000)
      for (const [k, v] of limits) if (v.until < now) limits.delete(k);
    let record = limits.get(key);
    if (!record || record.until < now) {
      record = { count: 0, until: now + 60000 };
      limits.set(key, record);
    }
    if (++record.count > max)
      throw error("尝试过于频繁，请一分钟后再试。", 429);
  }
  function bases() {
    const localUrl = `http://127.0.0.1:${phonePort}`;
    const lanUrls = [];
    if (phoneHost === "0.0.0.0")
      for (const values of Object.values(networkInterfaces()))
        for (const item of values || [])
          if (item.family === "IPv4" && !item.internal)
            lanUrls.push(`http://${item.address}:${phonePort}`);
    return { localUrl, lanUrls: [...new Set(lanUrls)] };
  }
  // A relayed phone is served from the stable instance origin, so mutating
  // requests carry that Origin while the wire Host is the trycloudflare
  // target; the same-origin check must accept exactly our own relay origin.
  const relayOrigins = () => (relay ? relay.allowedOrigins() : []);
  const relaySnapshot = () =>
    relay
      ? relay.snapshot()
      : { status: "disabled", url: "", error: "", configured: false, base: "", domain: "" };
  function admin(req) {
    const token = cookie(req, "crw_admin");
    if (
      !token ||
      !adminSessions.has(token) ||
      adminSessions.get(token) < Date.now()
    )
      throw error("请通过启动脚本打开电脑管理页。", 401);
  }
  function device(req) {
    const value = auth.authenticate(cookie(req, "crw_device"));
    if (!value)
      throw error("需要先在电脑上扫码配对，或设备授权已被撤销。", 401);
    return value;
  }
  async function staticFile(res, file) {
    try {
      const content = await readFile(join(publicDir, file));
      const type = file.endsWith(".html")
        ? "text/html"
        : file.endsWith(".js")
          ? "text/javascript"
          : "text/css";
      res.writeHead(200, { "Content-Type": type + "; charset=utf-8" });
      res.end(content);
    } catch {
      throw error("页面资源不存在。", 404);
    }
  }
  function handler(surface) {
    return async (req, res) => {
      headers(res);
      try {
        if(stopping)throw error('服务正在停止，请稍后重试。',503);
        const host = req.headers.host || "";
        if (
          surface === "admin" &&
          ![`127.0.0.1:${adminPort}`, `localhost:${adminPort}`].includes(host)
        )
          throw error("管理页仅接受本机地址。", 403);
        const path = new URL(req.url, "http://localhost").pathname;
        const url = new URL(req.url, "http://localhost");
        if (req.method === "GET") {
          const assets =
            surface === "admin"
              ? {
                  "/": "admin.html",
                  "/admin.js": "admin.js",
                  "/style.css": "style.css",
                }
              : {
                  "/": "index.html",
                  "/app.js": "app.js",
                  "/api-client.js": "api-client.js",
                  "/submissions.js": "submissions.js",
                  "/style.css": "style.css",
                };
          if (assets[path]) return await staticFile(res, assets[path]);
        }
        if (surface === "admin") {
          if (req.method === "POST" && path === "/admin/login") {
            requireOrigin(req);
            rate("admin-login");
            const input = await body(req);
            if (
              typeof input.token !== "string" ||
              input.token.length > 128 ||
              !equalSecret(input.token, adminToken)
            )
              throw error("管理凭据无效，请重新运行启动脚本。", 401);
            for (const [k, v] of adminSessions)
              if (v < Date.now()) adminSessions.delete(k);
            const session = randomBytes(32).toString("base64url");
            adminSessions.set(session, Date.now() + 12 * 3600000);
            setCookie(res, "crw_admin", session, { maxAge: 12 * 3600 });
            return json(res, 200, { ok: true });
          }
          admin(req);
          if (req.method === "GET" && path === "/admin/status")
            return json(res, 200, {
              ready: true,
              phonePort,
              ...bases(),
              tunnel: tunnel.snapshot(),
              relay: relaySnapshot(),
              devices: auth.list(),
              capabilities: appCapabilities,
            });
          if (!["POST", "DELETE"].includes(req.method))
            throw error("接口不存在。", 404);
          requireOrigin(req);
          const input = await body(req);
          if (path === "/admin/pair" && req.method === "POST") {
            const allowed = [
              bases().localUrl,
              ...bases().lanUrls,
              tunnel.snapshot().url,
              relay ? relay.runningUrl() : "",
            ].filter(Boolean);
            if (!allowed.includes(input.baseUrl))
              throw error("请选择当前可用的访问地址。");
            const grant = auth.createGrant();
            const link = `${input.baseUrl}/#pair=${grant.token}`;
            return json(res, 200, {
              url: link,
              qr: await QRCode.toDataURL(link, { width: 300, margin: 2 }),
              expiresAt: grant.expiresAt,
            });
          }
          if (path.startsWith("/admin/devices/") && req.method === "DELETE") {
            auth.revoke(
              decodeURIComponent(path.slice("/admin/devices/".length)),
            );
            return json(res, 200, { ok: true });
          }
          if (path === "/admin/tunnel" && req.method === "POST") {
            if (!["start", "stop"].includes(input.action))
              throw error("操作无效。");
            auth.grant = null;
            return json(
              res,
              200,
              input.action === "start" ? tunnel.start() : tunnel.stop(),
            );
          }
          if (path === "/admin/tunnel-config" && req.method === "POST") {
            rate("tunnel-config", 10);
            // The address may change, so any outstanding QR code dies with it.
            auth.grant = null;
            return json(res, 200, tunnel.setConfig(input || {}));
          }
          if (
            path === "/admin/shutdown" &&
            req.method === "POST" &&
            onShutdown
          ) {
            json(res, 200, { ok: true });
            setTimeout(onShutdown, 100);
            return;
          }
          throw error("接口不存在。", 404);
        }
        // The mobile listener never contains management endpoints or admin assets.
        if (!path.startsWith("/api/")) throw error("接口不存在。", 404);
        if (path === "/api/pair" && req.method === "POST") {
          requireOrigin(req, relayOrigins());
          rate("pair:" + req.socket.remoteAddress);
          const input = await body(req);
          // Remember which address this phone paired through, so the admin list
          // can say why a device stopped working after the address changed.
          const proto =
            req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
          // Through the relay the wire Host is the trycloudflare target; the
          // device list should record the stable instance origin the phone
          // actually bookmarked, which the Worker echoes in X-Forwarded-Host.
          const relayHost = relay ? relay.runningHost() : "";
          const forwardedHost = String(
            req.headers["x-forwarded-host"] || "",
          ).slice(0, 200);
          const recordHost =
            relayHost && forwardedHost.toLowerCase() === relayHost
              ? relayHost
              : (req.headers.host || "").slice(0, 200);
          const paired = auth.pair(
            input.token,
            input.name,
            `${proto}://${recordHost}`,
          );
          setCookie(res, "crw_device", paired.token, {
            secure: req.headers["x-forwarded-proto"] === "https",
          });
          return json(res, 200, { device: paired.device });
        }
        const paired = device(req);
        rate("device:" + paired.id, 240);
        if (req.method === "GET" && path === "/api/session")
          return json(res, 200, { device: paired, capabilities: appCapabilities });
        if(req.method==='GET'&&path==='/api/models'){
          if(!models)throw error('模型目录服务暂不可用，请在电脑重启服务。',503);
          return json(res,200,await models.list());
        }
        if (req.method === "GET" && path === "/api/projects")
          return json(res, 200, { projects: store.listProjects() });
        if (req.method === "GET" && path === "/api/threads")
          return json(res, 200, {
            threads: store.listThreads({
              projectId: url.searchParams.get("projectId") || "",
              search: url.searchParams.get("search") || "",
            }),
          });
        const projectMatch = path.match(/^\/api\/projects\/([^/]+)\/threads$/);
        if (projectMatch && req.method === "POST") {
          requireOrigin(req, relayOrigins());
          if (!creator) throw error("新建会话暂不可用，请在电脑重启服务。", 503);
          const input = await body(req);
          return json(res, 201, await creator.create({
            projectId: decodeURIComponent(projectMatch[1]),
            text: input?.text,
            requestId: input?.requestId,
            deviceId: paired.id,
            model:input?.model,
            effort:input?.effort,
          }));
        }
        const controlMatch = path.match(/^\/api\/threads\/([a-zA-Z0-9_-]{1,128})\/(control|steer|interrupt|queue\/resume)$/);
        if (controlMatch) {
          const [, threadId, action] = controlMatch;
          if (action === "control" && req.method === "GET") {
            store.requireThread(threadId);
            return json(res, 200, controls ? await controls.status(threadId) : {
              available: false, state: "unavailable", source: null, turnId: null,
              canInterrupt: false, canSteer: false, reason: "控制服务未启用，请在电脑重启服务。",
            });
          }
          if (action !== "control" && req.method === "POST") {
            requireOrigin(req, relayOrigins());
            rate("control:" + paired.id, 30);
            store.requireThread(threadId);
            const input = await body(req);
            if (!input || typeof input !== "object" || Array.isArray(input) ||
              input.model !== undefined || input.effort !== undefined ||
              (action === "queue/resume" && (input.text !== undefined || input.turnId !== undefined)))
              throw Object.assign(error("控制请求格式无效，引导不能同时切换模型设置。"), {notSubmitted: true});
            if (!controls) throw Object.assign(error("控制服务未启用，请在电脑重启服务。", 503), {notSubmitted: true});
            return json(res, 200, await controls.act({
              action: action === "queue/resume" ? "resumeQueue" : action,
              threadId, text: input.text, turnId: input.turnId, queuedSubmissionId: input.queuedSubmissionId,
              requestId: input.requestId, deviceId: paired.id,
            }));
          }
          throw error("接口不存在。", 404);
        }
        const match = path.match(
          /^\/api\/threads\/([a-zA-Z0-9_-]{1,128})(\/messages)?$/,
        );
        if (match && !match[2] && req.method === "GET")
          return json(
            res,
            200,
            store.getThread(match[1], {
              before: url.searchParams.has("before")
                ? Number(url.searchParams.get("before"))
                : undefined,
            }),
          );
        if (match && match[2] && req.method === "POST") {
          requireOrigin(req, relayOrigins());
          const input = await body(req);
          return json(
            res,
            200,
            await queue.send({
              threadId: match[1],
              text: input.text,
              requestId: input.requestId,
              deviceId: paired.id,
              model:input?.model,
              effort:input?.effort,
            }),
          );
        }
        if (path === "/api/logout" && req.method === "POST") {
          requireOrigin(req, relayOrigins());
          await body(req);
          auth.revoke(paired.id);
          setCookie(res, "crw_device", "", { maxAge: 0 });
          return json(res, 200, { ok: true });
        }
        throw error("接口不存在。", 404);
      } catch (e) {
        if (res.headersSent) {
          res.end();
          return;
        }
        json(res, e.statusCode || 500, {
          error: e.statusCode
            ? e.message
            : "服务读取失败，请在电脑上检查运行状态。",
          ...(e.notSubmitted===true?{notSubmitted:true}:{}),
          ...(e.controlUnknown===true?{controlUnknown:true}:{}),
        });
      }
    };
  }
  function listen(server, port, host) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve(server.address().port);
      });
    });
  }
  return {
    auth,
    /**
     * Called after the background cloudflared download lands: a fixed-domain
     * tunnel whose boot autostart was skipped (binary absent at that moment)
     * reconnects here without a service restart.
     */
    retryAutostart() {
      if (
        tunnel &&
        !tunnel.child &&
        !tunnel.retryTimer &&
        tunnel.shouldAutostart()
      )
        tunnel.start();
    },
    async start(options = {}) {
      phoneHost = options.phoneHost || "0.0.0.0";
      const adminServer = createServer(handler("admin")),
        phoneServer = createServer(handler("phone"));
      servers = [adminServer, phoneServer];
      for (const server of servers) {
        server.requestTimeout = 30000;
        server.headersTimeout = 10000;
        server.maxHeadersCount = 50;
        server.on("clientError", (_, socket) =>
          socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"),
        );
      }
      try {
        adminPort = await listen(
          adminServer,
          options.adminPort ?? 8765,
          "127.0.0.1",
        );
        phonePort = await listen(
          phoneServer,
          options.phonePort ?? 8766,
          phoneHost,
        );
      } catch (e) {
        await Promise.all(
          servers.map((s) => new Promise((r) => s.close(() => r()))),
        );
        throw e;
      }
      tunnel = new Tunnel({
        executable: cloudflaredPath,
        port: phonePort,
        dataDir,
        config: loadTunnelConfig(dataDir),
        prefixArgs: cloudflaredPrefixArgs,
        onUrl: (url) => {
          if (relay) relay.onTunnelUrl(url);
        },
      });
      // A fixed hostname never changes, so restoring it at boot is exactly what
      // keeps an existing pairing usable. A random quick-tunnel URL is never
      // auto-started: it would hand out an address that dies with the process.
      if (tunnel.shouldAutostart()) tunnel.start();
      return {
        adminUrl: `http://127.0.0.1:${adminPort}`,
        phoneUrl: `http://127.0.0.1:${phonePort}`,
      };
    },
    async stop() {
      if(stopPromise)return stopPromise;
      stopping=true;
      stopPromise=(async()=>{
        const listeners=servers.map(s=>new Promise(resolve=>{s.close(()=>resolve());s.closeIdleConnections();}));
        tunnel?.stop();
        relay?.stop();
        await Promise.all([queue?.stop?.(),creator?.stop(),models?.stop?.(),controls?.stop?.()]);
        await Promise.all(listeners);
      })();
      return stopPromise;
    },
  };
}

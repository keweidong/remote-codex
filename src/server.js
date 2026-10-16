import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { AuthStore, error, equalSecret } from "./auth.js";
import { Tunnel } from "./tunnel.js";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const capabilities = {
  read: true,
  send: true,
  continue: true,
  interrupt: false,
  approvals: false,
  statusSource: "persisted-history",
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
function requireOrigin(req) {
  const origin = req.headers.origin,
    host = req.headers.host;
  if (!origin || ![`http://${host}`, `https://${host}`].includes(origin))
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
  dataDir,
  adminToken,
  cloudflaredPath,
  onShutdown,
}) {
  const auth = new AuthStore({ dataDir });
  const adminSessions = new Map(),
    limits = new Map();
  let adminPort,
    phonePort,
    phoneHost,
    tunnel,
    servers = [];
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
              devices: auth.list(),
              capabilities,
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
          requireOrigin(req);
          rate("pair:" + req.socket.remoteAddress);
          const input = await body(req);
          const paired = auth.pair(input.token, input.name);
          setCookie(res, "crw_device", paired.token, {
            secure: req.headers["x-forwarded-proto"] === "https",
          });
          return json(res, 200, { device: paired.device });
        }
        const paired = device(req);
        rate("device:" + paired.id, 240);
        if (req.method === "GET" && path === "/api/session")
          return json(res, 200, { device: paired, capabilities });
        if (req.method === "GET" && path === "/api/projects")
          return json(res, 200, { projects: store.listProjects() });
        if (req.method === "GET" && path === "/api/threads")
          return json(res, 200, {
            threads: store.listThreads({
              projectId: url.searchParams.get("projectId") || "",
              search: url.searchParams.get("search") || "",
            }),
          });
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
          requireOrigin(req);
          const input = await body(req);
          return json(
            res,
            200,
            await queue.send({
              threadId: match[1],
              text: input.text,
              requestId: input.requestId,
              deviceId: paired.id,
            }),
          );
        }
        if (path === "/api/logout" && req.method === "POST") {
          requireOrigin(req);
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
      tunnel = new Tunnel({ executable: cloudflaredPath, port: phonePort });
      return {
        adminUrl: `http://127.0.0.1:${adminPort}`,
        phoneUrl: `http://127.0.0.1:${phonePort}`,
      };
    },
    async stop() {
      tunnel?.stop();
      await Promise.all(
        servers.map(
          (s) =>
            new Promise((r) => {
              s.closeIdleConnections();
              s.close(() => r());
            }),
        ),
      );
    },
  };
}

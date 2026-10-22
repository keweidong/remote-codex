import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fixture, threadId } from "./fixtures.js";
import { createCodexStore } from "../src/codex-store.js";
import { createApp } from "../src/server.js";

// Prefer a local Playwright install; Codex's bundled runtime is the fallback.
const require = createRequire(import.meta.url);
let playwrightModule = process.env.PLAYWRIGHT_MODULE;
if (!playwrightModule) {
  try { playwrightModule = pathToFileURL(require.resolve("playwright")).href; }
  catch {
    playwrightModule = pathToFileURL(join(homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs")).href;
  }
}
const { chromium } = await import(playwrightModule);
const bundledBrowser = join(process.env.LOCALAPPDATA || join(homedir(), "AppData/Local"),
  "ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe");
const { dir, cleanup } = fixture();
const projectDb = new DatabaseSync(join(dir, "state_5.sqlite"));
projectDb.prepare("INSERT INTO projects VALUES(?,?,?)").run("p2", "手机端项目列表测试", 1);
projectDb.prepare("INSERT INTO project_roots VALUES(?,?,?)").run("p2", join(dir, "project-two"), 0);
for (let i = 3; i <= 12; i++) {
  projectDb.prepare("INSERT INTO projects VALUES(?,?,?)").run(
    "p" + i, `移动端布局验收项目 ${i} - 用于检查较长项目名称的省略显示`, i - 1);
  projectDb.prepare("INSERT INTO project_roots VALUES(?,?,?)").run("p" + i, join(dir, "project-" + i), 0);
}
projectDb.close();
const store = createCodexStore({ codexHome: dir });
const requests = [], creationRequests = [];
const app = createApp({
  store, dataDir: join(dir, "remote"), adminToken: "layout-test",
  queue: { async send(body) {
    requests.push(body);
    return { status: "queued", messageId: "layout-message" };
  }},
  creator: { stop() {}, async create(body) {
    creationRequests.push(body);
    const db = new DatabaseSync(join(dir, "state_5.sqlite"));
    db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?)").run(
      "browser-project-created", body.text, join(dir, "project-two"), body.projectId,
      0, Date.now(), "fixture-model", "/root", "vscode");
    db.close();
    return {status: "created", threadId: "browser-project-created"};
  }},
  models: { async list() {
    return {
      defaultModel: "fixture-model", defaultEffort: "medium",
      models: [
        { id: "fixture-model", name: "Fixture Model", defaultEffort: "medium",
          efforts: [{ id: "medium", label: "Medium" }] },
        { id: "another-model", name: "Another Model", defaultEffort: "high",
          efforts: [{ id: "high", label: "High" }] },
      ],
    };
  }},
});
const noControl = {
  available: false, source: null, state: "unavailable", turnId: null,
  canSteer: false, canInterrupt: false, reason: "桌面会话没有共享控制通道",
};
async function controlFixture(browser, phoneUrl) {
  const context = await browser.newContext({viewport: {width: 320, height: 568}, isMobile: true, hasTouch: true});
  const page = await context.newPage(), posts = [], errors = [];
  let state = {available: true, source: "mobile", state: "inProgress",
    turnId: "mock-turn-one", canSteer: true, canInterrupt: true, reason: ""};
  let loseSteer = false, interruptStatus = "interruptRequested";
  const thread = {id: "mock-control", projectId: "mock-project", projectName: "Mock project",
    title: "Mock current-turn controls", status: "inProgress", model: "fixture-model"};
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    const interval = window.setInterval.bind(window);
    window.setInterval = (...args) => {
      if (args[1] === 5000) window.__testRefreshControls = args[0];
      return interval(...args);
    };
  });
  // Every API call in this context is mocked, including auth and history.
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data;
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      posts.push({path, body});
      if (path.endsWith("/steer")) {
        if (loseSteer) return route.abort("failed");
        data = {status: "steered", requestId: body.requestId, turnId: body.turnId};
      } else if (path.endsWith("/interrupt")) {
        data = {status: interruptStatus, requestId: body.requestId, turnId: body.turnId};
      } else if (path.endsWith("/messages")) data = {status: "queued", messageId: "mock-message"};
    } else if (path === "/api/session") data = {device: {name: "Mock phone"}};
    else if (path === "/api/projects") data = {
      projects: [{id: "mock-project", name: "Mock project", paths: ["mock-only"], count: 1}],
    };
    else if (path === "/api/models") data = {
      defaultModel: "fixture-model", defaultEffort: "medium",
      models: [{id: "fixture-model", name: "Fixture Model", defaultEffort: "medium",
        efforts: [{id: "medium", label: "Medium"}]}],
    };
    else if (path === "/api/threads") data = {threads: [thread]};
    else if (path.endsWith("/control")) data = state;
    else if (path === "/api/threads/mock-control") data = {
      thread, status: "inProgress", hasMore: false,
      messages: [{id: "mock-history", ordinal: 1, role: "assistant", text: "Isolated control fixture"}],
    };
    return route.fulfill({status: data ? 200 : 404, json: data || {error: "Unmocked fixture route"}});
  });
  try {
    await page.goto(phoneUrl);
    await page.locator(".thread-card").click();
    await page.waitForFunction(() => !document.querySelector("#steer-mode").disabled);
    assert.equal(await page.locator("#queue-mode").getAttribute("aria-pressed"), "true");
    for (const [width, height] of [[320, 568], [568, 320], [1440, 900]]) {
      await page.setViewportSize({width, height});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.ok((await page.locator(".composer-area").boundingBox()).height <= 110);
      for (const selector of ["#interrupt-turn", ".compose-modes", "#send", "#message-input"]) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y + box.height <= height);
      }
      await page.screenshot({path: `artifacts/layout-controls-${width}x${height}.png`});
    }
    await page.setViewportSize({width: 320, height: 568});
    await page.locator("#chat-settings summary").click();
    await page.locator("#model-select").selectOption("fixture-model");
    await page.locator("#effort-select").selectOption("medium");
    await page.locator("#chat-settings summary").click();
    await page.locator("#message-input").fill("default queued");
    await page.locator("#send").click();
    await page.locator("#chat-notice").filter({hasText: "已提交到桌面队列"}).waitFor();
    assert.equal(posts[0].path, "/api/threads/mock-control/messages");
    assert.equal(posts[0].body.model, "fixture-model");
    await page.locator("#steer-mode").click();
    assert.equal(await page.locator("#model-select").isDisabled(), true);
    await page.locator("#message-input").fill("same-turn steering");
    await page.locator("#send").click();
    await page.locator("#chat-notice").filter({hasText: /上次插话|已插话/}).waitFor();
    assert.deepEqual(Object.keys(posts[1].body).sort(), ["requestId", "text", "turnId"]);
    assert.equal(posts[1].body.turnId, "mock-turn-one");
    await page.locator("#message-input").fill("keep on unavailable");
    state = noControl;
    await page.evaluate(() => window.__testRefreshControls());
    assert.equal(await page.locator("#send").isDisabled(), true);
    assert.equal(await page.locator("#steer-mode").getAttribute("aria-pressed"), "true");
    assert.match(await page.locator("#steer-mode").getAttribute("title"), /共享控制通道/);
    assert.equal(await page.locator("#message-input").inputValue(), "keep on unavailable");
    assert.equal(posts.length, 2);
    state = {...state, available: true, source: "mobile", state: "inProgress",
      turnId: "mock-turn-two", canSteer: true, canInterrupt: true, reason: ""};
    await page.evaluate(() => window.__testRefreshControls());
    loseSteer = true;
    await page.locator("#message-input").fill("uncertain steering");
    await page.locator("#send").click();
    await page.locator("#chat-notice").filter({hasText: "未确认"}).waitFor();
    assert.equal(posts.length, 3);
    state = {...state, turnId: "mock-later-turn"};
    loseSteer = false;
    await page.reload();
    await page.locator(".thread-card").click();
    await page.waitForFunction(() => !document.querySelector("#steer-mode").disabled);
    assert.equal(await page.locator("#message-input").inputValue(), "uncertain steering");
    assert.equal(await page.locator("#steer-mode").getAttribute("aria-pressed"), "true");
    await page.locator("#send").click();
    await page.locator("#chat-notice").filter({hasText: /上次插话|已插话/}).waitFor();
    assert.equal(posts[3].body.requestId, posts[2].body.requestId);
    assert.equal(posts[3].body.turnId, "mock-turn-two");
    await page.locator("#message-input").fill("interrupt keeps this draft");
    page.once("dialog", dialog => dialog.dismiss());
    await page.locator("#interrupt-turn").click();
    assert.equal(posts.length, 4);
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#interrupt-turn").click();
    await page.locator("#chat-notice").filter({hasText: "已请求停止"}).waitFor();
    assert.equal(await page.locator("#interrupt-turn").isDisabled(), true);
    assert.equal(await page.locator("#message-input").inputValue(), "interrupt keeps this draft");
    assert.deepEqual(Object.keys(posts[4].body).sort(), ["requestId", "turnId"]);
    assert.equal(posts[4].body.turnId, "mock-later-turn");
    state = {...state, turnId: "mock-final-turn"};
    interruptStatus = "interrupted";
    await page.evaluate(() => window.__testRefreshControls());
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#interrupt-turn").click();
    await page.locator("#chat-notice").filter({hasText: "当前轮次已中断"}).waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS: isolated mocked control fixture; compact 320/568/1440px controls; queue default; exact steering payload; unavailable no fallback; unknown reload original IDs; stop cancel/requested/confirmed; retained drafts.");
  } finally {
    await context.close();
  }
}
async function queueResumeFixture(browser, phoneUrl) {
  const context = await browser.newContext({viewport: {width: 320, height: 568}, isMobile: true, hasTouch: true});
  const page = await context.newPage(), posts = [], errors = [];
  const readyQueue = {available: true, pending: true, count: 4, headId: "mock-original-head",
    canResume: true, reason: ""};
  let queue = readyQueue, loseResponse = false;
  const thread = {id: "mock-queue", projectId: "mock-project", projectName: "Mock project",
    title: "Mock queue resume", status: "completed", model: "fixture-model"};
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    const interval = window.setInterval.bind(window);
    window.setInterval = (...args) => {
      if (args[1] === 5000) window.__testRefreshControls = args[0];
      return interval(...args);
    };
  });
  // All APIs are isolated: this fixture never reaches a real queue/control endpoint.
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data;
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      posts.push({path, body});
      if (path.endsWith("/queue/resume")) {
        if (loseResponse) return route.abort("failed");
        data = {status: "queueStarted", requestId: body.requestId,
          queuedSubmissionId: body.queuedSubmissionId, turnId: "mock-started-turn", turnStatus: "inProgress"};
      } else if (path.endsWith("/messages")) data = {status: "queued", messageId: "mock-message"};
    } else if (path === "/api/session") data = {device: {name: "Mock phone"}};
    else if (path === "/api/projects") data = {
      projects: [{id: "mock-project", name: "Mock project", paths: ["mock-only"], count: 1}],
    };
    else if (path === "/api/models") data = {
      defaultModel: "fixture-model", defaultEffort: "medium",
      models: [{id: "fixture-model", name: "Fixture Model", defaultEffort: "medium",
        efforts: [{id: "medium", label: "Medium"}]}],
    };
    else if (path === "/api/threads") data = {threads: [thread]};
    else if (path.endsWith("/control")) data = {
      available: true, source: "shared", state: "idle", turnId: null,
      canSteer: false, canInterrupt: false, reason: "", queue,
    };
    else if (path === "/api/threads/mock-queue") data = {
      thread, status: "completed", hasMore: false,
      messages: [{id: "mock-history", ordinal: 1, role: "assistant", text: "Isolated queue fixture"}],
    };
    return route.fulfill({status: data ? 200 : 404, json: data || {error: "Unmocked fixture route"}});
  });
  try {
    await page.goto(phoneUrl);
    await page.locator(".thread-card").click();
    await page.locator("#queue-status").waitFor();
    await page.waitForFunction(() => !document.querySelector("#resume-queue").disabled);
    assert.match(await page.locator("#queue-summary").textContent(), /4/);
    assert.equal(await page.locator("#continue").getAttribute("aria-label"), "发送“继续”消息");
    for (const [width, height] of [[320, 568], [568, 320], [1440, 900]]) {
      await page.setViewportSize({width, height});
      const composer = await page.locator(".composer-area").boundingBox();
      assert.ok(composer.height <= 110);
      const band = await page.locator("#queue-status").boundingBox();
      const messages = await page.locator("#messages-scroll").boundingBox();
      assert.ok(band.y + band.height <= messages.y + 1);
      assert.ok(messages.height >= 65);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({path: `artifacts/layout-queue-ready-${width}x${height}.png`});
      queue = {...readyQueue, available: false, canResume: false, headId: null,
        reason: "桌面独占的会话尚未接入队列控制通道，请在桌面点击继续。"};
      await page.evaluate(() => window.__testRefreshControls());
      assert.equal(await page.locator("#resume-queue").isDisabled(), true);
      assert.equal(await page.locator("#queue-reason").isVisible(), true);
      assert.match(await page.locator("#queue-reason").textContent(), /桌面独占/);
      const reasonFits = await page.locator("#queue-reason").evaluate(node =>
        node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth);
      assert.equal(reasonFits, true, "unsupported reason is readable, not truncated");
      assert.ok((await page.locator("#messages-scroll").boundingBox()).height >= 65);
      assert.ok((await page.locator(".composer-area").boundingBox()).height <= 110);
      await page.screenshot({path: `artifacts/layout-queue-unavailable-${width}x${height}.png`});
      queue = readyQueue;
      await page.evaluate(() => window.__testRefreshControls());
    }
    await page.setViewportSize({width: 320, height: 568});
    await page.locator("#message-input").fill("keep resume draft");
    page.once("dialog", dialog => dialog.dismiss());
    await page.locator("#resume-queue").click();
    assert.equal(posts.length, 0);
    loseResponse = true;
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#resume-queue").click();
    await page.locator("#chat-notice").filter({hasText: "未确认"}).waitFor();
    assert.deepEqual(Object.keys(posts[0].body).sort(), ["queuedSubmissionId", "requestId"]);
    queue = {...readyQueue, headId: "mock-next-head"};
    loseResponse = false;
    await page.reload();
    await page.locator(".thread-card").click();
    await page.getByRole("button", {name: "核对恢复结果", exact: true}).waitFor();
    assert.equal(await page.locator("#message-input").inputValue(), "keep resume draft");
    assert.equal(posts.length, 1);
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#resume-queue").click();
    await page.locator("#chat-notice").filter({hasText: /首.*已启动|首.*开始/}).waitFor();
    assert.deepEqual(posts[1], posts[0]);
    assert.equal(await page.locator("#message-input").inputValue(), "keep resume draft");
    assert.deepEqual(errors, []);
    console.log("PASS: isolated queue resume; 320x568/568x320/1440x900 ready and unsupported screenshots; visible honest reason; compact composer; cancel; exact payload; lost-response reload uses original IDs and retains draft.");
  } finally {
    await context.close();
  }
}
let browser;
try {
  const { phoneUrl } = await app.start({ adminPort: 0, phonePort: 0, phoneHost: "127.0.0.1" });
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      (process.platform === "win32" && existsSync(bundledBrowser) ? bundledBrowser : undefined),
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.route("**/api/threads/*/control", route => route.fulfill({json: noControl}));
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    const interval = window.setInterval.bind(window);
    window.setInterval = (...args) => {
      if (args[1] === 12000) window.__testRefreshThreads = args[0];
      return interval(...args);
    };
  });
  mkdirSync("artifacts", { recursive: true });
  await page.goto(`${phoneUrl}/#pair=${app.auth.createGrant().token}`);
  await page.getByRole("button", { name: "确认配对" }).click();
  await page.locator(".thread-card").waitFor();
  assert.equal(await page.locator(".project-group").count(), 12);
  assert.equal(await page.locator("#thread-list").evaluate(node => node.scrollHeight > node.clientHeight),
    true, "many projects scroll within the sidebar");
  assert.equal(await page.locator("#project-toggle-p3 .project-name").evaluate(node =>
    node.scrollWidth > node.clientWidth && getComputedStyle(node).textOverflow === "ellipsis"),
    true, "long project names are truncated within their row");
  const previousCard = await page.locator(".thread-card").elementHandle();
  await page.locator(".thread-card").focus();
  const refreshedList = page.waitForResponse(response =>
    response.url().includes("/api/threads?") && response.url().includes("projectId=p1"));
  await page.evaluate(() => window.__testRefreshThreads());
  await refreshedList;
  await page.waitForFunction(node => !node.isConnected, previousCard);
  assert.equal(await page.locator(".thread-card").evaluate(node => node === document.activeElement),
    true, "periodic refresh preserves the focused session row");
  await previousCard.dispose();
  await page.locator("#project-add-p2").click();
  assert.equal(await page.locator("#new-project").inputValue(), "p2");
  await page.locator("#cancel-new-thread").click();
  await page.locator("#project-toggle-p1").click();
  assert.equal(await page.locator(".thread-card").isVisible(), false);
  await page.locator("#refresh-list").click();
  await page.waitForFunction(() => document.querySelector("#project-toggle-p1")?.getAttribute("aria-expanded") === "false");
  await page.locator("#search").fill("Desktop");
  await page.locator(".thread-card").waitFor({state: "visible"});
  await page.locator("#search").fill("");
  await page.waitForFunction(() => document.querySelector("#project-toggle-p1")?.getAttribute("aria-expanded") === "false");
  await page.locator("#project-toggle-p1").click();
  await page.locator(".thread-card").waitFor({state: "visible"});

  async function fits() {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const selector of ["#send", "#message-input", ".composer-area", ".conversation-heading"]) {
      const box = await page.locator(selector).boundingBox();
      const size = page.viewportSize();
      assert.ok(box && box.x >= 0 && box.x + box.width <= size.width + 1 &&
        box.y >= 0 && box.y + box.height <= size.height + 1,
        `${selector} fits ${size.width}x${size.height}: ${JSON.stringify(box)}`);
    }
    const header = await page.locator(".conversation-heading").boundingBox();
    const messages = await page.locator("#messages-scroll").boundingBox();
    const composer = await page.locator(".composer-area").boundingBox();
    assert.ok(header.y + header.height <= messages.y + 1);
    assert.ok(messages.y + messages.height <= composer.y + 1);
    assert.ok(messages.height >= 65, "messages retain usable space");
  }

  for (const [width, height] of [[390, 844], [320, 568], [390, 430], [844, 390], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    if (await page.locator("#sidebar-toggle").getAttribute("aria-expanded") !== "true")
      await page.locator("#sidebar-toggle").click();
    assert.equal(await page.locator(".chat-sidebar").isVisible(), true);
    await page.screenshot({ path: `artifacts/layout-list-${width}x${height}.png` });
    await page.locator(".thread-card").first().click();
    await page.locator("#thread-title").filter({ hasText: "Desktop title" }).waitFor();
    if (width <= 760) assert.equal(await page.locator(".chat-sidebar").isVisible(), false);
    assert.equal(await page.locator("#chat-settings").getAttribute("open"), null);
    await fits();
    const composer = await page.locator(".composer-area").boundingBox();
    assert.ok(composer.height <= 110, `collapsed composer stays compact: ${JSON.stringify(composer)}`);
    await page.screenshot({ path: `artifacts/layout-chat-${width}x${height}.png` });
    await page.locator("#chat-settings summary").click();
    await page.locator("#model-select").selectOption("another-model");
    await page.locator("#effort-select").selectOption("high");
    assert.match(await page.locator("#model-summary").textContent(), /Another Model.*High/);
    await fits();
    await page.screenshot({ path: `artifacts/layout-settings-${width}x${height}.png` });
    await page.locator("#chat-settings summary").click();
    if (width > 760) {
      await page.locator("#sidebar-toggle").click();
      assert.equal(await page.locator(".chat-sidebar").isVisible(), false);
      assert.equal((await page.locator("#conversation").boundingBox()).width, width);
      await fits();
      await page.screenshot({path: `artifacts/layout-sidebar-hidden-${width}.png`});
      await page.locator("#sidebar-toggle").click();
    }
  }
  await page.setViewportSize({ width: 568, height: 320 });
  await page.locator(".thread-card").first().click();
  await page.locator("#chat-settings summary").click();
  await page.locator("#message-input").fill("multiline draft\n".repeat(12));
  await fits();
  await page.screenshot({ path: "artifacts/layout-short-landscape.png" });
  await page.locator("#chat-settings summary").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#message-input").fill("long draft\n".repeat(30));
  assert.ok((await page.locator("#message-input").boundingBox()).height <= 144);
  await page.locator("#sidebar-toggle").click();
  await page.locator("#sidebar-backdrop").click({position: {x: 380, y: 100}});
  assert.equal(await page.locator("#sidebar-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator("#message-input").inputValue(), "long draft\n".repeat(30));
  await page.locator("#sidebar-toggle").click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#sidebar-toggle").getAttribute("aria-expanded"), "false");
  await page.locator("#sidebar-toggle").click();
  await page.locator(".thread-card").first().click();
  assert.equal((await page.locator("#message-input").boundingBox()).height, 144,
    "a long draft restored from the hidden mobile conversation grows after it is shown");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.locator("#chat-notice").filter({ hasText: "已提交到桌面队列" }).waitFor();
  assert.equal(await page.locator("#message-input").inputValue(), "");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].threadId, threadId);
  assert.equal(requests[0].model, "another-model");
  await page.locator("#continue").click();
  await page.waitForFunction(() => !document.getElementById("continue").disabled);
  assert.equal(requests[1].text, "继续");
  await page.locator("#sidebar-toggle").click();
  await page.locator("#search").fill("not-a-thread");
  await page.locator(".empty-list").waitFor();
  await page.locator("#search").fill("");
  await page.locator(".thread-card").waitFor();
  await page.locator("#new-thread").click();
  await page.locator("#new-thread-dialog").waitFor();
  await page.setViewportSize({ width: 320, height: 568 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: "artifacts/layout-new-thread-320.png" });
  await page.locator("#cancel-new-thread").click();
  await page.locator("#project-add-p2").click();
  await page.locator("#new-message").fill("从项目列表新建会话");
  await page.locator("#create-thread").click();
  await page.locator("#new-thread-dialog").waitFor({state: "hidden"});
  await page.locator("#thread-title").filter({hasText: "从项目列表新建会话"}).waitFor();
  assert.equal(creationRequests.length, 1);
  assert.equal(creationRequests[0].projectId, "p2");
  assert.equal(await page.locator("#sidebar-toggle").getAttribute("aria-expanded"), "false");
  await page.locator("#sidebar-toggle").click();
  assert.equal(await page.locator("#project-toggle-p2").getAttribute("aria-expanded"), "true");
  assert.match(await page.locator("#project-threads-p2").textContent(), /从项目列表新建会话/);
  await page.screenshot({path: "artifacts/layout-project-drawer-320.png"});
  assert.deepEqual(errors, []);
  console.log("PASS: 12 project groups/long names; periodic focus restoration; collapse/refresh/search; per-project creation; mobile drawer/backdrop/Escape; desktop full-width toggle; 320/390/568/844/1440px layouts; drafts; send/continue; no page errors.");
  await controlFixture(browser, phoneUrl);
  await queueResumeFixture(browser, phoneUrl);
} finally {
  await browser?.close();
  await app.stop();
  store.close();
  cleanup();
}

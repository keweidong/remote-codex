import { SubmissionTracker } from "./submissions.js";
import { createApiClient } from "./api-client.js";
const $ = (id) => document.getElementById(id);
const submissions = new SubmissionTracker(sessionStorage);
const creations = new SubmissionTracker(sessionStorage, "codex-pocket-new-threads");
const historyNotice = document.createElement("p");
historyNotice.className = "notice small";
historyNotice.setAttribute("role", "status");
$("chat-notice").after(historyNotice);
let selected = null,
  projects = [],
  creating = false,
  pendingThread = null,
  threads = [],
  messages = [],
  nextBefore = null,
  hasMore = false,
  sending = false,
  signature = "",
  listEpoch = 0,
  chatEpoch = 0;
const drafts = new Map();
const modelPreferences = new Map(), creationPreferences = new Map();
const threadDetails = new Map();
let modelCatalog = null, modelCatalogError = "正在读取模型列表…";
function settingsNodes(kind) {
  return kind === "new"
    ? {model: $("new-model"), effort: $("new-effort"), notice: $("new-model-notice")}
    : {model: $("model-select"), effort: $("effort-select"), notice: $("model-notice")};
}
function readSettings(kind) {
  const nodes = settingsNodes(kind);
  return modelCatalog
    ? {model: nodes.model.value || "", effort: nodes.effort.value || ""}
    : {model: "", effort: ""};
}
function explicitSettings(settings) {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value));
}
function renderSettings(kind, settings = readSettings(kind)) {
  const nodes = settingsNodes(kind);
  const actual = kind === "new" ? null : threadDetails.get(selected) || threads.find(t => t.id === selected);
  const inheritedModel = actual?.model || modelCatalog?.defaultModel || "";
  const chosen = modelCatalog?.models.find(m => m.id === settings.model);
  const effective = chosen || modelCatalog?.models.find(m => m.id === inheritedModel);
  const inheritedEffort = chosen
    ? chosen.defaultEffort
    : actual?.reasoningEffort ||
      (actual?.model && actual.model !== modelCatalog?.defaultModel
        ? effective?.defaultEffort : modelCatalog?.defaultEffort || effective?.defaultEffort);
  nodes.model.replaceChildren(new Option(
    (kind === "new" ? "使用默认模型" : "沿用会话 / 默认模型") + (inheritedModel ? ` · ${inheritedModel}` : ""), ""),
    ...(modelCatalog?.models || []).map(m => new Option(m.name, m.id)));
  nodes.model.value = chosen?.id || "";
  const efforts = effective?.efforts || [];
  nodes.effort.replaceChildren(new Option(
    (chosen || kind === "new" ? "模型默认" : "沿用会话 / 默认强度") + (inheritedEffort ? ` · ${inheritedEffort}` : ""), ""),
    ...efforts.map(e => new Option(e.label, e.id)));
  nodes.effort.value = modelCatalog
    ? efforts.some(e => e.id === settings.effort) ? settings.effort : ""
    : "";
  nodes.model.disabled = !modelCatalog || (kind === "new" && creating);
  nodes.effort.disabled = !modelCatalog || !efforts.length || (kind === "new" && creating);
  nodes.notice.textContent = modelCatalogError;
}
async function loadModels() {
  try {
    const data = await api("/api/models");
    if (!Array.isArray(data.models) || !data.models.length || data.models.some(m =>
      typeof m.id !== "string" || typeof m.name !== "string" || !Array.isArray(m.efforts) ||
      m.efforts.some(e => typeof e.id !== "string" || typeof e.label !== "string")))
      throw new Error("模型列表格式无效");
    modelCatalog = data;
    modelCatalogError = "";
  } catch {
    modelCatalog = null;
    modelCatalogError = "模型列表暂不可用，可沿用会话或默认设置发送。";
  }
  renderSettings("chat", modelPreferences.get(selected) || submissions.latest(selected) || {});
  renderSettings("new", creationPreferences.get($("new-project").value) || creations.latest($("new-project").value) || {});
}
let grant = new URLSearchParams(location.hash.slice(1)).get("pair");
if (location.hash) history.replaceState(null, "", location.pathname);
const labels = {
  inProgress: "执行中",
  completed: "本轮完成",
  failed: "执行失败",
  interrupted: "已中断",
  unknown: "待处理",
};
function uuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
}
function toast(value) {
  $("toast").textContent = value;
  $("toast").classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("toast").classList.add("hidden"), 4500);
}
function pairScreen() {
  selected = null;
  pendingThread = null;
  if ($("new-thread-dialog").open) $("new-thread-dialog").close();
  document.body.classList.remove("chat-open");
  $("workspace").classList.add("hidden");
  $("pair-screen").classList.remove("hidden");
  $("pair-form").classList.toggle("hidden", !grant);
  if (grant) {
    $("pair-description").textContent =
      "确认后，这台手机可以查看、继续和新建你的 Codex 会话。";
  }
}
const api = createApiClient({ fetchImpl: fetch, onUnauthorized: pairScreen });
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function time(value) {
  if (!value) return "";
  const date = new Date(value);
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function badge(status) {
  const node = el(
    "span",
    "status " +
      (status === "inProgress"
        ? "running"
        : status === "failed"
          ? "failed"
          : ""),
    labels[status] || "待处理",
  );
  return node;
}
async function loadProjects() {
  const data = await api("/api/projects");
  projects = data.projects;
  const current = $("project-select").value;
  $("project-select").replaceChildren(new Option("全部项目", ""));
  for (const p of projects)
    $("project-select").add(new Option(`${p.name} · ${p.count}`, p.id));
  $("project-select").value = projects.some(p => p.id === current) ? current : "";
  $("new-thread").disabled = !projects.some(p => p.paths.length > 0);
  $("new-thread").title = $("new-thread").disabled ? "请先在电脑添加本地项目" : "";
}
function openNewThread() {
  const available = projects.filter(p => p.paths.length > 0);
  if (!available.length || creating) return;
  const current = $("project-select").value;
  const unresolved = creations.latest(current || undefined);
  const preferred = current || unresolved?.threadId || threads.find(t => t.id === selected)?.projectId;
  $("new-project").replaceChildren(...available.map(p => new Option(p.name, p.id)));
  $("new-project").value = available.some(p => p.id === preferred) ? preferred : available[0].id;
  if (unresolved?.threadId === $("new-project").value) $("new-message").value = unresolved.text;
  renderSettings("new", creationPreferences.get($("new-project").value) ||
    (unresolved?.threadId === $("new-project").value ? unresolved : {}));
  $("new-thread-error").textContent = unresolved?.threadId === $("new-project").value
    ? "有一条创建请求尚未确认。请先检查会话列表；重试原文会沿用同一请求。" : "";
  $("new-thread-dialog").showModal();
  $("new-message").focus();
}
function setCreating(value) {
  creating = value;
  for (const id of ["new-project", "new-message", "create-thread", "cancel-new-thread"])
    $(id).disabled = value;
  renderSettings("new");
  $("new-thread-form").setAttribute("aria-busy", String(value));
  $("create-thread").textContent = value ? "正在创建…" : "创建并发送";
}
async function createThread() {
  if (creating) return;
  const projectId = $("new-project").value;
  const text = $("new-message").value;
  if (!text.trim()) {
    $("new-thread-error").textContent = "请输入首条消息。";
    $("new-message").focus();
    return;
  }
  if (!projects.some(p => p.id === projectId && p.paths.length)) {
    $("new-thread-error").textContent = "请选择一个本地项目。";
    return;
  }
  const settings = readSettings("new");
  creationPreferences.set(projectId, settings);
  const submission = creations.get(projectId, text, uuid, settings);
  setCreating(true);
  $("new-thread-error").textContent = "";
  let result;
  try {
    result = await api(`/api/projects/${encodeURIComponent(projectId)}/threads`, {
      method: "POST",
      body: JSON.stringify({text, requestId: submission.requestId, ...explicitSettings(settings)}),
    });
  } catch (e) {
    if (e.notSubmitted) creations.acknowledge(submission.requestId);
    $("new-thread-error").textContent = e.message;
    return;
  } finally {
    setCreating(false);
  }
  // Acknowledgment remains final even when list/history persistence is delayed.
  creations.acknowledge(submission.requestId);
  $("new-message").value = "";
  $("new-thread-dialog").close();
  $("project-select").value = projectId;
  $("search").value = "";
  clearTimeout(searchTimer);
  pendingThread = result.threadId;
  selectThread(result.threadId);
  $("thread-title").textContent = text.trim().split(/\r?\n/)[0].slice(0, 80);
  $("thread-meta").textContent = projects.find(p => p.id === projectId)?.name || "";
  $("chat-notice").textContent = "新会话已创建，首条消息已提交。正在等待会话记录同步…";
  toast("新会话已创建");
  await loadProjects().catch(() => {});
  await loadThreads().catch(() => {});
}
async function loadThreads() {
  const epoch = ++listEpoch;
  const params = new URLSearchParams({
    projectId: $("project-select").value,
    search: $("search").value,
  });
  const data = await api("/api/threads?" + params);
  if (epoch !== listEpoch) return;
  threads = data.threads;
  renderThreads();
}
function renderThreads() {
  const list = $("thread-list");
  list.replaceChildren();
  if (!threads.length) {
    list.append(el("p", "empty-list", "没有找到匹配的会话。"));
    return;
  }
  for (const thread of threads) {
    const item = el(
      "button",
      "thread-card" + (selected === thread.id ? " active" : ""),
    );
    item.type = "button";
    item.append(el("strong", "thread-card-title", thread.title));
    const detail = el("div", "thread-card-detail");
    detail.append(
      el("span", "small muted", thread.projectName),
      el("span", "small muted", time(thread.updatedAt)),
    );
    item.append(detail, badge(thread.status));
    item.onclick = () => selectThread(thread.id);
    list.append(item);
  }
}
function selectThread(id) {
  if (selected) {
    drafts.set(selected, $("message-input").value);
    if (modelCatalog) modelPreferences.set(selected, readSettings("chat"));
  }
  selected = id;
  $("thread-title").textContent = threads.find(t => t.id === id)?.title || "新会话";
  $("thread-meta").textContent = "";
  $("activity").classList.add("hidden");
  $("load-earlier").classList.add("hidden");
  $("thread-status").replaceWith(Object.assign(badge("unknown"), {id: "thread-status"}));
  const unresolved = submissions.latest(id);
  if (!modelPreferences.has(id) && unresolved)
    modelPreferences.set(id, {model: unresolved.model || "", effort: unresolved.effort || ""});
  renderSettings("chat", modelPreferences.get(id) || unresolved || {});
  $("message-input").value = drafts.get(id) ?? unresolved?.text ?? "";
  messages = [];
  signature = "";
  nextBefore = null;
  hasMore = false;
  historyNotice.textContent = "";
  $("chat-notice").textContent = unresolved
    ? "保留了一条未确认提交。请先查看是否已收到，重试原文会沿用相同请求标识。"
    : "";
  $("empty-chat").classList.add("hidden");
  $("chat-content").classList.remove("hidden");
  document.body.classList.add("chat-open");
  $("messages").replaceChildren(el("p", "muted", "读取会话中…"));
  renderThreads();
  loadChat(true).catch((e) => toast(e.message));
}
function messageNode(message) {
  const article = el("article", "message " + message.role);
  const head = el("div", "message-heading");
  head.append(
    el(
      "strong",
      "",
      message.role === "user"
        ? "你"
        : message.phase === "commentary"
          ? "Codex · 进展"
          : "Codex",
    ),
    el("span", "small muted", time(message.createdAt)),
  );
  article.append(head);
  const content = el("div", "message-body");
  const parts = message.text.split(/```[^\n]*\n([\s\S]*?)```/g);
  parts.forEach((part, i) => {
    if (i % 2) {
      const pre = el("pre", "");
      pre.append(el("code", "", part));
      content.append(pre);
    } else if (part) content.append(el("div", "prose", part));
  });
  article.append(content);
  return article;
}
function renderMessages(force = false) {
  const next = JSON.stringify(messages);
  if (!force && next === signature) return;
  signature = next;
  const box = $("messages-scroll"),
    nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 130;
  $("messages").replaceChildren(...messages.map(messageNode));
  if (!messages.length)
    $("messages").append(el("p", "empty-list", "还没有可展示的消息。"));
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}
async function loadChat(initial = false) {
  if (!selected) return;
  const id = selected,
    epoch = ++chatEpoch;
  let data;
  try {
    data = await api("/api/threads/" + encodeURIComponent(id));
  } catch (e) {
    if (pendingThread === id && e.status === 404) {
      if (selected === id && epoch === chatEpoch)
        historyNotice.textContent = "新会话已创建，正在等待记录同步…";
      return;
    }
    if (selected === id && epoch === chatEpoch)
      historyNotice.textContent = e.message;
    throw e;
  }
  if (selected !== id || epoch !== chatEpoch) return;
  if (pendingThread === id) {
    pendingThread = null;
    $("chat-notice").textContent = "新会话已创建，首条消息已提交。";
  }
  $("thread-title").textContent = data.thread.title;
  const previousThread = threadDetails.get(id);
  threadDetails.set(id, data.thread);
  $("thread-meta").textContent =
    data.thread.projectName +
    (data.thread.model ? " · " + data.thread.model : "") +
    (data.thread.reasoningEffort ? " · " + data.thread.reasoningEffort : "");
  if (modelCatalog && (!previousThread || previousThread.model !== data.thread.model ||
    previousThread.reasoningEffort !== data.thread.reasoningEffort)) {
    renderSettings("chat", modelPreferences.get(id) || readSettings("chat"));
    modelPreferences.set(id, readSettings("chat"));
  }
  $("thread-status").replaceWith(
    Object.assign(badge(data.status), { id: "thread-status" }),
  );
  if (initial) {
    messages = data.messages;
    nextBefore = data.nextBefore;
    hasMore = data.hasMore;
  } else {
    const merged = new Map(messages.map((m) => [m.id, m]));
    for (const m of data.messages) merged.set(m.id, m);
    messages = [...merged.values()].sort((a, b) => a.ordinal - b.ordinal);
  }
  $("load-earlier").classList.toggle("hidden", !hasMore);
  $("activity").textContent = data.activity
    ? "记录状态：" + data.activity + "…"
    : "";
  $("activity").classList.toggle("hidden", !data.activity);
  historyNotice.textContent = data.warning || "";
  renderMessages(initial);
}
async function send(text) {
  if (sending || !selected || !text.trim()) return;
  const target = selected;
  sending = true;
  $("send").disabled = true;
  $("continue").disabled = true;
  const settings = readSettings("chat");
  if (modelCatalog) modelPreferences.set(target, settings);
  const submission = submissions.get(target, text, uuid, settings);
  let result;
  try {
    result = await api(`/api/threads/${target}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, requestId: submission.requestId, ...explicitSettings(settings) }),
    });
  } catch (e) {
    if (e.notSubmitted) submissions.acknowledge(submission.requestId);
    toast(e.message);
    if (selected === target) $("chat-notice").textContent = e.message;
    return;
  } finally {
    sending = false;
    $("send").disabled = false;
    $("continue").disabled = false;
  }
  submissions.acknowledge(submission.requestId);
  drafts.delete(target);
  if (selected === target) {
    $("message-input").value = "";
    $("chat-notice").textContent =
      (result.status === "started" ? "已开始执行。" : "已提交到桌面队列。") +
      (typeof result.notice === "string" && result.notice
        ? result.notice
        : result.status === "started" ? "正在等待执行记录同步。" : "等待 Codex 处理；若一直无新回复，请在电脑打开该会话。");
  }
  toast(result.status === "started" ? "已开始执行" : "消息已提交");
  // Queue confirmation is final even if the separate history refresh fails.
  if (selected === target) await loadChat().catch(() => {});
}
async function boot() {
  if (grant) {
    pairScreen();
    return;
  }
  try {
    const data = await api("/api/session");
    $("device-label").textContent = data.device.name + " · 已配对";
    $("pair-screen").classList.add("hidden");
    $("workspace").classList.remove("hidden");
    await loadProjects();
    await loadModels();
    await loadThreads();
  } catch (e) {
    pairScreen();
    $("pair-error").textContent = e.message;
  }
}
$("pair-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    await api("/api/pair", {
      method: "POST",
      body: JSON.stringify({ token: grant, name: $("device-name").value }),
    });
    grant = null;
    await boot();
  } catch (e) {
    $("pair-error").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
$("project-select").onchange = () =>
  loadThreads().catch((e) => toast(e.message));
let searchTimer;
$("search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(
    () => loadThreads().catch((e) => toast(e.message)),
    250,
  );
};
$("refresh-list").onclick = () => loadThreads().catch((e) => toast(e.message));
$("new-thread").onclick = openNewThread;
$("new-thread-form").onsubmit = (event) => {
  event.preventDefault();
  return createThread();
};
$("cancel-new-thread").onclick = () => $("new-thread-dialog").close();
$("new-thread-dialog").oncancel = (event) => {
  if (creating) event.preventDefault();
};
$("new-project").onchange = () => {
  const unresolved = creations.latest($("new-project").value);
  if (unresolved) $("new-message").value = unresolved.text;
  renderSettings("new", creationPreferences.get($("new-project").value) || unresolved || {});
  $("new-thread-error").textContent = unresolved
    ? "此项目有一条创建请求尚未确认，重试原文会沿用同一请求。" : "";
};
for (const kind of ["chat", "new"]) {
  const nodes = settingsNodes(kind);
  const remember = () => {
    const settings = readSettings(kind);
    const key = kind === "new" ? $("new-project").value : selected;
    if (key && modelCatalog) (kind === "new" ? creationPreferences : modelPreferences).set(key, settings);
  };
  nodes.model.onchange = () => {
    // A new model gets its own default effort, never a stale effort from the previous model.
    renderSettings(kind, {model: nodes.model.value, effort: ""});
    remember();
  };
  nodes.effort.onchange = remember;
}
$("back").onclick = () => document.body.classList.remove("chat-open");
$("composer").onsubmit = (event) => {
  event.preventDefault();
  send($("message-input").value);
};
$("continue").onclick = () => send("继续");
$("load-earlier").onclick = async () => {
  if (!hasMore || !selected) return;
  const id = selected;
  const box = $("messages-scroll"),
    oldHeight = box.scrollHeight,
    oldTop = box.scrollTop;
  try {
    const data = await api(`/api/threads/${id}?before=${nextBefore}`);
    if (selected !== id) return;
    const merged = new Map(
      [...data.messages, ...messages].map((m) => [m.id, m]),
    );
    messages = [...merged.values()].sort((a, b) => a.ordinal - b.ordinal);
    nextBefore = data.nextBefore;
    hasMore = data.hasMore;
    renderMessages();
    box.scrollTop = oldTop + box.scrollHeight - oldHeight;
    $("load-earlier").classList.toggle("hidden", !hasMore);
  } catch (e) {
    if (selected === id) historyNotice.textContent = e.message;
    toast(e.message);
  }
};
$("logout").onclick = async () => {
  if (!confirm("取消这台手机的配对？之后需要重新扫码。")) return;
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
    submissions.clear();
    creations.clear();
    drafts.clear();
    modelPreferences.clear();
    creationPreferences.clear();
    threadDetails.clear();
    modelCatalog = null;
    grant = null;
    pairScreen();
  } catch (e) {
    toast(e.message);
  }
};
setInterval(() => {
  if (
    !document.hidden &&
    !$("workspace").classList.contains("hidden") &&
    selected
  )
    loadChat().catch(() => {});
}, 2500);
setInterval(() => {
  if (!document.hidden && !$("workspace").classList.contains("hidden"))
    loadThreads().catch(() => {});
}, 12000);
boot();

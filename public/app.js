import { SubmissionTracker } from "./submissions.js";
const $ = (id) => document.getElementById(id);
const submissions = new SubmissionTracker(sessionStorage);
let selected = null,
  threads = [],
  messages = [],
  nextBefore = null,
  hasMore = false,
  sending = false,
  signature = "",
  listEpoch = 0,
  chatEpoch = 0;
const drafts = new Map();
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
  $("workspace").classList.add("hidden");
  $("pair-screen").classList.remove("hidden");
  $("pair-form").classList.toggle("hidden", !grant);
  if (grant) {
    $("pair-description").textContent =
      "确认后，这台手机可以读取并发送你的桌面会话消息。";
  }
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    cache: "no-store",
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("服务响应无效，请稍后重试。");
  }
  if (!response.ok) {
    if (response.status === 401 && !path.includes("/api/pair")) pairScreen();
    throw new Error(data.error || "请求失败");
  }
  return data;
}
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
  const current = $("project-select").value;
  $("project-select").replaceChildren(new Option("全部项目", ""));
  for (const p of data.projects.filter((p) => p.count > 0))
    $("project-select").add(new Option(`${p.name} · ${p.count}`, p.id));
  $("project-select").value = current;
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
  if (selected) drafts.set(selected, $("message-input").value);
  selected = id;
  const unresolved = submissions.latest(id);
  $("message-input").value = drafts.get(id) ?? unresolved?.text ?? "";
  messages = [];
  signature = "";
  nextBefore = null;
  hasMore = false;
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
  const data = await api("/api/threads/" + encodeURIComponent(id));
  if (selected !== id || epoch !== chatEpoch) return;
  $("thread-title").textContent = data.thread.title;
  $("thread-meta").textContent =
    data.thread.projectName +
    (data.thread.model ? " · " + data.thread.model : "");
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
  if (data.warning) $("chat-notice").textContent = data.warning;
  renderMessages(initial);
}
async function send(text) {
  if (sending || !selected || !text.trim()) return;
  const target = selected;
  sending = true;
  $("send").disabled = true;
  $("continue").disabled = true;
  const submission = submissions.get(target, text, uuid);
  try {
    await api(`/api/threads/${target}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, requestId: submission.requestId }),
    });
    submissions.acknowledge(submission.requestId);
    drafts.delete(target);
    if (selected === target) {
      $("message-input").value = "";
      $("chat-notice").textContent =
        "已提交到桌面队列。等待 Codex 处理；若一直无新回复，请在电脑打开该会话。";
    }
    toast("消息已提交");
    await loadChat();
  } catch (e) {
    toast(e.message);
    if (selected === target) $("chat-notice").textContent = e.message;
  } finally {
    sending = false;
    $("send").disabled = false;
    $("continue").disabled = false;
  }
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
    toast(e.message);
  }
};
$("logout").onclick = async () => {
  if (!confirm("取消这台手机的配对？之后需要重新扫码。")) return;
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
    submissions.clear();
    drafts.clear();
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
    loadChat().catch((e) => {
      $("chat-notice").textContent = e.message;
    });
}, 2500);
setInterval(() => {
  if (!document.hidden && !$("workspace").classList.contains("hidden"))
    loadThreads().catch(() => {});
}, 12000);
boot();

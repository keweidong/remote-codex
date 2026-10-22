import { SubmissionTracker } from "./submissions.js";
import { createApiClient } from "./api-client.js";
const $ = (id) => document.getElementById(id);
const submissions = new SubmissionTracker(sessionStorage);
const creations = new SubmissionTracker(sessionStorage, "codex-pocket-new-threads");
const controls = new SubmissionTracker(sessionStorage, "codex-pocket-controls");
const queueResumes = new SubmissionTracker(sessionStorage, "codex-pocket-queue-resume");
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
const controlStates = new Map(), controlReads = new Map(), controlModes = new Map();
const controlBusy = new Set(), stoppingTurns = new Map(), controlNotices = new Map();
const controlDraftKey = "codex-pocket-control-drafts";
const controlDrafts = new Map();
try {
  const saved = JSON.parse(sessionStorage.getItem(controlDraftKey) || "[]");
  if (Array.isArray(saved)) for (const entry of saved) {
    if (Array.isArray(entry) && typeof entry[0] === "string" &&
      typeof entry[1]?.text === "string" && (controls.latest(entry[0]) || queueResumes.latest(entry[0])))
      controlDrafts.set(entry[0], entry[1]);
  }
} catch {}
let controlEpoch = 0;
const expandedProjects = new Set(), searchCollapsedProjects = new Set();
const projectRequests = new Map(), projectResults = new Map();
let preferredProject = "", projectStateReady = false, searchThreads = null, appliedSearch = "", listTerm = null;
const mobileLayout = typeof matchMedia === "function" ? matchMedia("(max-width: 760px)") : null;
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
  const steering = kind === "chat" && composeMode() === "steer";
  nodes.model.disabled = !modelCatalog || (kind === "new" && creating) || steering;
  nodes.effort.disabled = !modelCatalog || !efforts.length || (kind === "new" && creating) || steering;
  nodes.notice.textContent = modelCatalogError;
  if (kind === "chat") {
    const effort = efforts.find(e => e.id === nodes.effort.value)?.label || inheritedEffort;
    $("model-summary").textContent =
      [chosen?.name || inheritedModel, effort].filter(Boolean).join(" · ") || "沿用会话设置";
    $("chat-settings").classList.toggle("settings-unavailable", !!modelCatalogError);
  }
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
  controlEpoch++;
  pendingThread = null;
  if ($("new-thread-dialog").open) $("new-thread-dialog").close();
  document.body.classList.remove("chat-open");
  setSidebar(false);
  $("workspace").classList.add("hidden");
  $("pair-screen").classList.remove("hidden");
  $("pair-form").classList.toggle("hidden", !grant);
  if (grant) {
    $("pair-description").textContent =
      "确认后，这台手机可以查看、继续和新建你的 Codex 会话，并可对支持控制的执行中轮次插话或停止。";
  }
}
const api = createApiClient({ fetchImpl: fetch, onUnauthorized: pairScreen });
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#icon-" + name);
  svg.append(use);
  return svg;
}
function setSidebar(open) {
  $("workspace").classList.toggle("sidebar-open", open);
  $("workspace").classList.toggle("sidebar-collapsed", !open);
  $("sidebar-toggle").setAttribute("aria-expanded", String(open));
  $("sidebar-toggle").setAttribute("aria-label", open ? "隐藏侧栏" : "显示侧栏");
  $("sidebar-toggle").title = open ? "隐藏侧栏" : "显示侧栏";
  $("chat-sidebar").inert = !open;
  $("conversation").inert = !!(open && mobileLayout?.matches);
  if (!open) resizeComposer();
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
  if (!projectStateReady) {
    const first = projects.find(p => p.count > 0) || projects[0];
    if (first) expandedProjects.add(first.id);
    projectStateReady = true;
  }
  for (const id of expandedProjects)
    if (!projects.some(p => p.id === id)) expandedProjects.delete(id);
  if (!projects.some(p => p.id === preferredProject)) preferredProject = "";
  $("new-thread").disabled = !projects.some(p => p.paths.length > 0);
  $("new-thread").title = $("new-thread").disabled ? "请先在电脑添加本地项目" : "新建会话";
  renderThreads();
}
function openNewThread(projectId) {
  const available = projects.filter(p => p.paths.length > 0);
  if (!available.length || creating) return;
  const current = typeof projectId === "string" ? projectId : preferredProject;
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
  preferredProject = projectId;
  expandedProjects.add(projectId);
  searchThreads = null;
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
  const term = $("search").value.trim();
  if (term !== listTerm) {
    listTerm = term;
    listEpoch++;
    searchThreads = term ? [] : null;
    appliedSearch = term;
  }
  const epoch = listEpoch;
  const ids = projects.filter(p => term || expandedProjects.has(p.id)).map(p => p.id);
  let cursor = 0;
  // Render each project independently; a slow or failed group cannot block its peers.
  const worker = async () => {
    while (cursor < ids.length && epoch === listEpoch)
      await loadProjectThreads(ids[cursor++], term, epoch);
  };
  renderThreads();
  await Promise.all(Array.from({length: Math.min(4, ids.length)}, worker));
}
function loadProjectThreads(id, term, epoch) {
  const key = `${epoch}:${id}`;
  if (projectRequests.has(key)) return projectRequests.get(key);
  if (projectResults.get(id)?.term !== term)
    projectResults.set(id, {term, complete: false, error: ""});
  const task = (async () => {
    try {
      const data = await api("/api/threads?" + new URLSearchParams({projectId: id, search: term}));
      if (epoch !== listEpoch) return;
      const items = data.threads.filter(t => t.projectId === id);
      if (term) searchThreads = [...searchThreads.filter(t => t.projectId !== id), ...items];
      else threads = [...threads.filter(t => t.projectId !== id), ...items];
      projectResults.set(id, {term, complete: true, error: ""});
    } catch (e) {
      if (epoch === listEpoch) projectResults.set(id, {term, complete: true, error: e.message});
    } finally {
      projectRequests.delete(key);
      if (epoch === listEpoch) renderThreads();
    }
  })();
  projectRequests.set(key, task);
  return task;
}
function renderThreads() {
  const list = $("thread-list");
  const focusId = list.contains?.(document.activeElement) ? document.activeElement?.id : "";
  const scrollTop = list.scrollTop;
  list.replaceChildren();
  const searching = searchThreads !== null;
  const source = searching ? searchThreads : threads;
  const term = searching ? appliedSearch : "";
  const groups = projects.filter(p => !searching || p.name.toLowerCase().includes(appliedSearch.toLowerCase()) ||
    source.some(t => t.projectId === p.id) || projectResults.get(p.id)?.term !== term ||
    !projectResults.get(p.id)?.complete || projectResults.get(p.id)?.error);
  $("thread-count").textContent = String(groups.length);
  if (!groups.length) {
    list.append(el("p", "empty-list", searching ? "没有找到匹配的项目或会话。" : "暂无项目。"));
    return;
  }
  for (const project of groups) {
    const group = el("section", "project-group");
    const row = el("div", "project-row");
    const toggle = el("button", "project-toggle");
    const open = searching ? !searchCollapsedProjects.has(project.id) : expandedProjects.has(project.id);
    toggle.type = "button";
    toggle.id = "project-toggle-" + encodeURIComponent(project.id);
    toggle.title = project.name;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.append(icon("continue"), icon("folder"), el("span", "project-name", project.name),
      el("span", "project-count", String(searching ? source.filter(t => t.projectId === project.id).length : project.count)));
    const children = el("div", "project-threads");
    children.id = "project-threads-" + encodeURIComponent(project.id);
    children.classList.toggle("hidden", !open);
    toggle.setAttribute("aria-controls", children.id);
    toggle.onclick = () => {
      preferredProject = project.id;
      if (searching) {
        if (open) searchCollapsedProjects.add(project.id);
        else searchCollapsedProjects.delete(project.id);
      } else if (open) expandedProjects.delete(project.id);
      else expandedProjects.add(project.id);
      renderThreads();
      if (!searching && !open) return loadThreads().catch(e => toast(e.message));
    };
    row.append(toggle);
    if (project.paths.length) {
      const add = el("button", "project-add icon-button");
      add.type = "button";
      add.id = "project-add-" + encodeURIComponent(project.id);
      add.title = `在${project.name}中新建会话`;
      add.setAttribute("aria-label", add.title);
      add.append(icon("plus"));
      add.onclick = () => {
        preferredProject = project.id;
        openNewThread(project.id);
      };
      row.append(add);
    }
    const items = source.filter(t => t.projectId === project.id);
    for (const thread of items) children.append(threadNode(thread));
    const result = projectResults.get(project.id);
    const problem = result?.term === term && result.error;
    if (problem) {
      const error = el("p", "project-empty error-text", "读取失败：" + problem);
      error.setAttribute("role", "alert");
      children.append(error);
    } else if (!items.length) {
      const pending = result?.term !== term || !result?.complete;
      children.append(el("p", "project-empty", pending && project.count
        ? "正在读取会话…" : searching ? "没有匹配的会话。" : "暂无会话"));
    }
    group.append(row, children);
    list.append(group);
  }
  list.scrollTop = scrollTop;
  if (focusId) $(focusId)?.focus({preventScroll: true});
}
function threadNode(thread) {
    const item = el(
      "button",
      "thread-card" + (selected === thread.id ? " active" : ""),
    );
    item.type = "button";
    item.id = "thread-row-" + encodeURIComponent(thread.id);
    item.setAttribute("aria-current", String(selected === thread.id));
    const heading = el("div", "thread-card-heading");
    const status = badge(thread.status);
    status.classList.add("thread-state");
    status.title = labels[thread.status] || "待处理";
    heading.append(el("strong", "thread-card-title", thread.title), status);
    item.append(heading);
    const detail = el("div", "thread-card-detail");
    detail.append(
      el("span", "small muted", thread.projectName),
      el("span", "small muted", time(thread.updatedAt)),
    );
    item.append(detail);
    if (thread.model) item.append(el("span", "thread-card-model muted", thread.model));
    item.onclick = () => selectThread(thread.id);
    return item;
}
function selectThread(id) {
  if (selected) {
    drafts.set(selected, $("message-input").value);
    if (modelCatalog) modelPreferences.set(selected, readSettings("chat"));
    saveControlDraft(selected);
  }
  selected = id;
  controlEpoch++;
  const thread = threads.find(t => t.id === id) || searchThreads?.find(t => t.id === id);
  if (thread) {
    preferredProject = thread.projectId;
    if (!threads.some(t => t.id === id)) threads.push(thread);
  }
  $("thread-title").textContent = thread?.title || "新会话";
  $("thread-meta").textContent = "";
  $("activity").classList.add("hidden");
  $("load-earlier").classList.add("hidden");
  $("thread-status").replaceWith(Object.assign(badge("unknown"), {id: "thread-status"}));
  const unresolved = submissions.latest(id);
  const unresolvedControl = controls.latest(id);
  const retainedControl = controlDrafts.get(id);
  if (!controlModes.has(id) && (unresolvedControl || retainedControl))
    controlModes.set(id, ["queue", "steer"].includes(retainedControl?.mode)
      ? retainedControl.mode : unresolvedControl?.action === "steer" ? "steer" : "queue");
  if (!modelPreferences.has(id) && retainedControl)
    modelPreferences.set(id, {model: retainedControl.model || "", effort: retainedControl.effort || ""});
  if (!modelPreferences.has(id) && unresolved)
    modelPreferences.set(id, {model: unresolved.model || "", effort: unresolved.effort || ""});
  renderSettings("chat", modelPreferences.get(id) || unresolved || {});
  $("message-input").value = drafts.get(id) ?? retainedControl?.text ?? unresolvedControl?.text ?? unresolved?.text ?? "";
  messages = [];
  signature = "";
  nextBefore = null;
  hasMore = false;
  historyNotice.textContent = "";
  $("chat-notice").textContent = controlNotices.get(id) || (unresolvedControl
    ? "有一条本轮控制请求尚未确认。请先检查执行状态；重试会沿用原请求和原轮次。"
    : pendingQueueResume(id)
    ? "有一条队列恢复请求尚未确认，请点击“核对恢复结果”检查原请求。"
    : unresolved
    ? "保留了一条未确认提交。请先查看是否已收到，重试原文会沿用相同请求标识。"
    : "");
  $("empty-chat").classList.add("hidden");
  $("chat-content").classList.remove("hidden");
  document.body.classList.add("chat-open");
  if (mobileLayout?.matches) setSidebar(false);
  resizeComposer();
  $("messages").replaceChildren(el("p", "muted", "读取会话中…"));
  renderThreads();
  renderControl();
  refreshControl(id);
  loadChat(true).catch((e) => toast(e.message));
}
function composeMode() {
  return controlModes.get(selected) || "queue";
}
function pendingControl(id, action, text) {
  return (Array.isArray(controls.items) ? controls.items : []).findLast(item =>
    item.threadId === id && item.action === action &&
    typeof item.turnId === "string" && !!item.turnId &&
    (text === undefined || item.text === text));
}
function saveControlDraft(id) {
  if (!id) return;
  const unresolvedControl = typeof controls.latest === "function" && controls.latest(id);
  const unresolvedQueue = typeof queueResumes.latest === "function" && queueResumes.latest(id);
  if (unresolvedControl || unresolvedQueue) {
    controlDrafts.set(id, {
      text: selected === id ? $("message-input").value : drafts.get(id) ?? controlDrafts.get(id)?.text ?? "",
      mode: controlModes.get(id) || "queue", ...modelPreferences.get(id),
    });
  } else controlDrafts.delete(id);
  try {
    sessionStorage.setItem(controlDraftKey, JSON.stringify([...controlDrafts]));
  } catch {}
}
function controlReason(state) {
  if (!state) return "正在读取本轮控制状态…";
  if (!state.available) return state.reason || "此会话没有可用的共享控制通道。";
  if (state.state !== "inProgress" || !state.turnId) return "当前没有正在执行的轮次。";
  return state.reason || "当前轮次暂不支持此操作。";
}
function canControl(state, action) {
  return state?.available === true && ["mobile", "shared"].includes(state.source) &&
    state.state === "inProgress" && typeof state.turnId === "string" && !!state.turnId &&
    state[action === "steer" ? "canSteer" : "canInterrupt"] === true;
}
function pendingQueueResume(id) {
  return (Array.isArray(queueResumes.items) ? queueResumes.items : []).findLast(item =>
    item.threadId === id && item.action === "resumeQueue" &&
    typeof item.queuedSubmissionId === "string" && !!item.queuedSubmissionId);
}
function canResumeQueue(state) {
  const queue = state?.queue;
  return state?.state === "idle" && queue?.available === true && queue.pending === true &&
    queue.canResume === true && typeof queue.headId === "string" && !!queue.headId.trim();
}
function queueReason(state) {
  if (state?.queue?.reason) return state.queue.reason;
  if (!state?.queue || state.queue.available !== true)
    return "队列控制通道不可用，请在桌面检查队列。";
  if (state.state !== "idle") return "请等待当前轮次结束后恢复队列。";
  return "当前队列没有可恢复的任务，请刷新后检查。";
}
function renderQueueStatus(state, busy) {
  // The native queue has no pause flag; pending work alone is not proof of a paused queue.
  const queue = state?.queue, pending = pendingQueueResume(selected);
  const count = Number.isSafeInteger(queue?.count) && queue.count >= 0 ? queue.count : null;
  const show = !!selected && (queue?.pending === true || count > 0 || !!pending);
  const enabled = canResumeQueue(state);
  $("queue-status").classList.toggle("hidden", !show);
  $("queue-status").setAttribute("aria-busy", String(busy));
  $("queue-summary").textContent = count !== null ? `队列 · ${count} 条待执行`
    : pending ? "队列恢复结果待确认" : "队列有待执行消息";
  $("queue-resume-label").textContent = pending ? "核对恢复结果" : "恢复队列";
  $("resume-queue").disabled = busy || sending || (!pending && !enabled);
  $("resume-queue").title = pending ? "核对原恢复请求的结果" : enabled ? "启动队列中的首条已有任务" : queueReason(state);
  $("queue-reason").textContent = pending
    ? "仅核对原请求，不会恢复后续消息。" + (!enabled ? queueReason(state) : "")
    : enabled ? "" : queueReason(state);
}
function renderControl() {
  const state = controlStates.get(selected), steering = composeMode() === "steer";
  const busy = controlBusy.has(selected);
  const pendingSteer = pendingControl(selected, "steer", $("message-input").value);
  const pendingStop = pendingControl(selected, "interrupt");
  const steerable = canControl(state, "steer") || !!pendingSteer;
  const interruptible = canControl(state, "interrupt") || !!pendingStop;
  const steerTitle = pendingSteer ? "核对上次插话请求（原请求与原轮次）"
    : canControl(state, "steer") ? "插话到当前轮次" : controlReason(state);
  const stopTitle = pendingStop ? "核对上次停止请求"
    : canControl(state, "interrupt") ? "停止当前轮次" : controlReason(state);
  $("queue-mode").setAttribute("aria-pressed", String(!steering));
  $("steer-mode").setAttribute("aria-pressed", String(steering));
  $("queue-mode").disabled = busy;
  $("steer-mode").disabled = busy || !steerable;
  $("steer-mode").title = steerTitle;
  const showUnavailableStop = state?.state === "unavailable" && !pendingStop;
  $("interrupt-turn").classList.toggle("hidden", !selected || (!interruptible && !pendingStop && !showUnavailableStop));
  $("interrupt-turn").disabled = busy || !interruptible ||
    (!pendingStop && stoppingTurns.get(selected)?.id === state?.turnId);
  $("interrupt-turn").title = stopTitle;
  $("interrupt-turn").setAttribute("aria-label", stopTitle);
  $("send").disabled = sending || busy || (steering && !steerable);
  $("continue").disabled = sending || busy || steering;
  $("send").title = steering ? steerTitle : "发送消息";
  $("send").setAttribute("aria-label", steering ? pendingSteer ? "核对上次插话请求" : "插话到当前轮次" : "发送消息");
  $("message-input").placeholder = steering ? "插话到当前轮次…" : "给这个会话发消息…";
  renderQueueStatus(state, busy);
  if (selected && state?.state === "unavailable" && !controlNotices.has(selected) &&
    !$("chat-notice").textContent)
    $("chat-notice").textContent = "共享控制通道不可用；排队发送可用。";
}
async function refreshControl(id = selected) {
  if (!id) return null;
  const epoch = controlEpoch, stopping = stoppingTurns.get(id);
  let task = controlReads.get(id);
  if (!task) {
    task = (async () => {
      let state;
      try {
        state = await api(`/api/threads/${encodeURIComponent(id)}/control`);
        if (typeof state.available !== "boolean" || !["inProgress", "idle", "unavailable"].includes(state.state))
          throw new Error("invalid control status");
      } catch {
        state = {available: false, state: "unavailable", turnId: null,
          canSteer: false, canInterrupt: false, reason: "本轮控制暂不可用，请稍后重试。"};
      }
      controlStates.set(id, state);
      return state;
    })();
    controlReads.set(id, task);
  }
  try {
    const state = await task;
    reconcileStop(id, state, stopping);
    if (selected === id && epoch === controlEpoch) renderControl();
    return state;
  } finally {
    if (controlReads.get(id) === task) controlReads.delete(id);
  }
}
function setComposeMode(mode) {
  if (!selected || controlBusy.has(selected)) return;
  if (mode === "steer" && !canControl(controlStates.get(selected), "steer") &&
    !pendingControl(selected, "steer", $("message-input").value)) return;
  controlModes.set(selected, mode);
  saveControlDraft(selected);
  renderSettings("chat");
  renderControl();
}
function showControlNotice(id, text) {
  controlNotices.set(id, text);
  if (selected === id) $("chat-notice").textContent = text;
}
function reconcileStop(id, state, stopping) {
  const lastTurn = state?.lastTurn;
  if (!stopping?.awaitingConfirmation || stoppingTurns.get(id) !== stopping ||
    lastTurn?.id !== stopping.id || !["interrupted", "completed", "failed"].includes(lastTurn.status)) return;
  stopping.awaitingConfirmation = false;
  showControlNotice(id, lastTurn.status === "interrupted"
    ? "请求停止的原轮次已中断，排队消息不会被删除。"
    : `请求停止的原轮次已结束（${lastTurn.status === "completed" ? "已完成" : "执行失败"}），未确认中断。`);
}
async function resumeQueue() {
  const target = selected, epoch = controlEpoch;
  if (!target || controlBusy.has(target) || sending) return;
  const pending = pendingQueueResume(target), previous = controlStates.get(target);
  if (!pending && !canResumeQueue(previous)) return;
  const headId = pending?.queuedSubmissionId || previous.queue.headId;
  if (!confirm(pending
    ? "核对上次恢复结果，仅重试原请求和原队列任务，不会恢复后续消息。确定继续？"
    : "启动队列中首条已有任务，不会新增“继续”消息。确定恢复队列？")) return;
  controlBusy.add(target);
  renderControl();
  let submission;
  try {
    const state = await refreshControl(target);
    if (selected !== target || epoch !== controlEpoch) return;
    if (!pending && (!canResumeQueue(state) || state.queue.headId !== headId)) {
      showControlNotice(target, state?.queue?.headId && state.queue.headId !== headId
        ? "队列首条任务已变化，请确认最新状态后再操作。" : queueReason(state));
      return;
    }
    // Recovery deliberately bypasses live eligibility, but never changes the original queue identity.
    submission = pending || queueResumes.get(target, "", uuid, {action: "resumeQueue", queuedSubmissionId: headId});
    if (modelCatalog) modelPreferences.set(target, readSettings("chat"));
    saveControlDraft(target);
    const result = await api(`/api/threads/${encodeURIComponent(target)}/queue/resume`, {
      method: "POST",
      body: JSON.stringify({requestId: submission.requestId, queuedSubmissionId: submission.queuedSubmissionId}),
    });
    if (result.requestId !== submission.requestId || result.queuedSubmissionId !== submission.queuedSubmissionId)
      throw new Error("服务返回的恢复请求或队列任务标识不匹配。");
    queueResumes.acknowledge(submission.requestId);
    const outcome = {
      inProgress: "队列首条任务已启动，等待执行记录同步。",
      completed: "队列首条任务已启动并完成，后续任务请查看队列。",
      failed: "队列首条任务已启动，但本轮执行失败。",
      interrupted: "队列首条任务已启动，但本轮已中断。",
    };
    showControlNotice(target, outcome[result.turnStatus]);
    await refreshControl(target);
  } catch (e) {
    if (submission && e.notSubmitted) queueResumes.acknowledge(submission.requestId);
    showControlNotice(target, e.notSubmitted ? e.message
      : "队列恢复结果未确认，请点击“核对恢复结果”检查原请求。" + e.message);
  } finally {
    saveControlDraft(target);
    controlBusy.delete(target);
    renderControl();
  }
}
async function submitControl(action, text = $("message-input").value) {
  const target = selected, epoch = controlEpoch;
  if (!target || controlBusy.has(target) || (action === "steer" && !text.trim())) return;
  const pending = pendingControl(target, action, action === "steer" ? text : undefined);
  const expectedTurn = pending?.turnId || controlStates.get(target)?.turnId;
  if (!expectedTurn || (!pending && action === "interrupt" && stoppingTurns.get(target)?.id === expectedTurn)) return;
  if (action === "interrupt" && !confirm(pending
    ? "核对上次停止请求，仅重试原请求和原轮次，排队消息不会被删除。确定继续？"
    : "只停止当前轮，排队消息不会被删除。确定停止？")) return;
  controlBusy.add(target);
  renderControl();
  let submission;
  try {
    const state = await refreshControl(target);
    if (selected !== target || epoch !== controlEpoch) return;
    if (!pending && (!canControl(state, action) || state.turnId !== expectedTurn)) {
      showControlNotice(target, !canControl(state, action) ? controlReason(state) : "当前轮次已变化，请确认后再操作。");
      return;
    }
    // Receipt recovery precedes the server's live preflight and always uses the original identity.
    submission = pending || controls.get(target, text, uuid, {action, turnId: expectedTurn});
    saveControlDraft(target);
    const result = await api(`/api/threads/${encodeURIComponent(target)}/${action}`, {
      method: "POST",
      body: JSON.stringify({...(action === "steer" ? {text} : {}),
        requestId: submission.requestId, turnId: submission.turnId}),
    });
    if (result.requestId !== submission.requestId || result.turnId !== submission.turnId)
      throw new Error("服务返回的请求或轮次标识不匹配。");
    controls.acknowledge(submission.requestId);
    if (action === "steer") {
      if (drafts.get(target) === text) drafts.delete(target);
      if (selected === target && $("message-input").value === text) {
        $("message-input").value = "";
        resizeComposer();
      }
      showControlNotice(target, pending ? "上次插话请求已确认。" : "已插话到当前轮次。");
    } else {
      const stopping = {id: submission.turnId, awaitingConfirmation: result.status === "interruptRequested"};
      stoppingTurns.set(target, stopping);
      showControlNotice(target, result.status === "interrupted"
        ? pending ? "原轮次已中断，排队消息不会被删除。" : "当前轮次已中断，排队消息不会被删除。"
        : pending ? "上次停止请求已受理，等待原轮次的中断确认；排队消息不会被删除。"
          : "已请求停止当前轮次，等待中断确认；排队消息不会被删除。");
      reconcileStop(target, controlStates.get(target), stopping);
    }
  } catch (e) {
    if (submission && e.notSubmitted) controls.acknowledge(submission.requestId);
    const notice = e.notSubmitted ? e.message : "本轮控制结果未确认，请先检查执行状态，勿重复操作。" + e.message;
    showControlNotice(target, notice);
  } finally {
    saveControlDraft(target);
    controlBusy.delete(target);
    renderControl();
  }
}
function messageNode(message) {
  const article = el("article", "message " + message.role +
    (message.phase === "commentary" ? " commentary" : ""));
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
  if (composeMode() === "steer") return submitControl("steer", text);
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
    renderControl();
  }
  submissions.acknowledge(submission.requestId);
  drafts.set(target, "");
  if (selected === target) {
    $("message-input").value = "";
    resizeComposer();
    $("chat-notice").textContent =
      (result.status === "started" ? "已开始执行。" : "已提交到桌面队列。") +
      (typeof result.notice === "string" && result.notice
        ? result.notice
        : result.status === "started" ? "正在等待执行记录同步。" : "等待 Codex 处理；若一直无新回复，请在电脑打开该会话。");
  }
  saveControlDraft(target);
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
    setSidebar(true);
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
let searchTimer;
$("search").oninput = () => {
  searchCollapsedProjects.clear();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(
    () => loadThreads().catch((e) => toast(e.message)),
    250,
  );
};
$("refresh-list").onclick = () => loadProjects().then(loadThreads).catch((e) => toast(e.message));
$("new-thread").onclick = () => openNewThread();
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
    if (kind === "chat") {
      renderSettings(kind, settings);
      saveControlDraft(key);
    }
  };
  nodes.model.onchange = () => {
    // A new model gets its own default effort, never a stale effort from the previous model.
    renderSettings(kind, {model: nodes.model.value, effort: ""});
    remember();
  };
  nodes.effort.onchange = remember;
}
$("sidebar-toggle").onclick = () => {
  const open = !$("workspace").classList.contains("sidebar-open");
  setSidebar(open);
  if (open) {
    $("sidebar-close").focus();
    loadThreads().catch(e => toast(e.message));
  }
};
const closeSidebar = () => {
  setSidebar(false);
  $("sidebar-toggle").focus();
};
$("sidebar-close").onclick = closeSidebar;
$("sidebar-backdrop").onclick = closeSidebar;
document.addEventListener?.("keydown", event => {
  if (event.key === "Escape" && $("workspace").classList.contains("sidebar-open") && !$("new-thread-dialog").open) {
    event.preventDefault();
    closeSidebar();
  }
});
mobileLayout?.addEventListener("change", () =>
  setSidebar($("workspace").classList.contains("sidebar-open")));
function resizeComposer() {
  const input = $("message-input");
  input.style.height = "auto";
  input.style.height = Math.max(46, Math.min(input.scrollHeight, 144)) + "px";
}
$("message-input").oninput = () => {
  resizeComposer();
  if (selected) {
    drafts.set(selected, $("message-input").value);
    saveControlDraft(selected);
  }
  renderControl();
};
$("queue-mode").onclick = () => setComposeMode("queue");
$("steer-mode").onclick = () => setComposeMode("steer");
$("interrupt-turn").onclick = () => submitControl("interrupt");
$("resume-queue").onclick = resumeQueue;
$("composer").onsubmit = (event) => {
  event.preventDefault();
  send($("message-input").value);
};
$("continue").onclick = () => {
  if (composeMode() !== "steer") return send("继续");
};
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
    controls.clear();
    queueResumes.clear();
    controlModes.clear();
    controlStates.clear();
    controlNotices.clear();
    stoppingTurns.clear();
    controlDrafts.clear();
    try { sessionStorage.removeItem(controlDraftKey); } catch {}
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
  if (!document.hidden && !$("workspace").classList.contains("hidden") && selected)
    return refreshControl();
}, 5000);
setInterval(() => {
  if (
    !document.hidden &&
    !$("workspace").classList.contains("hidden") &&
    selected
  )
    loadChat().catch(() => {});
}, 2500);
setInterval(() => {
  if (!document.hidden && !$("workspace").classList.contains("hidden") &&
    $("workspace").classList.contains("sidebar-open"))
    loadThreads().catch(() => {});
}, 12000);
boot();

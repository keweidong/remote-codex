export class ApiError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ApiError";
    Object.assign(this, details);
  }
}

export function createApiClient({
  fetchImpl = globalThis.fetch,
  onUnauthorized = () => {},
} = {}) {
  return async function api(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const isSubmission =
      method === "POST" && /^\/api\/threads\/[^/?]+\/messages$/.test(path);
    const isCreation =
      method === "POST" && /^\/api\/projects\/[^/?]+\/threads$/.test(path);
    const controlAction = method === "POST"
      ? path.match(/^\/api\/threads\/[^/?]+\/(steer|interrupt|queue\/resume)$/)?.[1] : null;
    const isHistory =
      method === "GET" && /^\/api\/threads\/[^/?]+(?:\?|$)/.test(path);
    let status = null;
    let contentType = "";
    function failure(phase, reason) {
      const submissionUnknown = (isSubmission || isCreation) && phase !== "http";
      const controlUnknown = !!controlAction && phase !== "http";
      const prefix = controlUnknown
        ? controlAction === "queue/resume"
          ? "恢复队列结果未确认，请检查队列及执行记录，勿重复操作。"
          : "控制结果未确认，请先检查当前执行轮，勿重复操作。"
        : submissionUnknown
        ? isCreation
          ? "新会话创建结果未确认，请先检查会话列表；重试原文会沿用同一请求。"
          : "提交结果未确认，请检查桌面队列，勿重复发送。"
        : isHistory
          ? "历史刷新失败："
          : "";
      return new ApiError(prefix + reason, {
        phase,
        status,
        contentType,
        method,
        path,
        submissionUnknown,
        ...(controlAction ? {controlUnknown} : {}),
      });
    }

    let response;
    try {
      response = await fetchImpl(path, {
        ...options,
        headers: { "Content-Type": "application/json", ...options.headers },
        cache: "no-store",
      });
    } catch {
      throw failure("network", "网络连接失败，请检查网络和电脑服务。");
    }
    status = response.status;
    contentType = response.headers.get("content-type") || "";
    if (status === 401 && !path.includes("/api/pair")) onUnauthorized();
    const http = `（HTTP ${status}）`;
    let raw;
    try {
      raw = await response.text();
    } catch {
      throw failure("body", `读取服务响应时连接中断${http}。`);
    }
    if (!raw.trim()) throw failure("parse", `服务返回了空响应${http}。`);
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // Do not expose proxy HTML, response bodies, or JSON parser excerpts.
      throw failure("parse", `服务返回了非 JSON 或不完整的响应${http}。`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw failure("response", `服务响应格式不符合预期${http}。`);
    if (!response.ok) {
      const error = failure(
        "http",
        typeof data.error === "string" && data.error
          ? data.error
          : `请求失败${http}。`,
      );
      error.notSubmitted = data.notSubmitted === true;
      if (controlAction) error.controlUnknown = data.controlUnknown === true;
      throw error;
    }
    if (
      controlAction &&
      (!(controlAction === "steer" ? ["steered"] : controlAction === "queue/resume"
        ? ["queueStarted"] : ["interrupted", "interruptRequested"]).includes(data.status) ||
        typeof data.turnId !== "string" || !data.turnId ||
        typeof data.requestId !== "string" || !data.requestId ||
        (controlAction === "queue/resume" && (typeof data.queuedSubmissionId !== "string" || !data.queuedSubmissionId ||
          !["inProgress", "completed", "interrupted", "failed"].includes(data.turnStatus))))
    )
      throw failure("response", `服务未返回有效的控制确认${http}。`);
    if (
      isSubmission &&
      (!["queued", "started"].includes(data.status) ||
        typeof data.messageId !== "string" ||
        !data.messageId)
    )
      throw failure("response", `服务未返回有效的提交确认${http}。`);
    if (
      isCreation &&
      (data.status !== "created" ||
        typeof data.threadId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(data.threadId))
    )
      throw failure("response", `服务未返回有效的新会话确认${http}。`);
    return data;
  };
}

import { AppServerClient } from "./app-server-client.js";

const effortLabels = {
  none: "无", minimal: "最低", low: "低", medium: "中", high: "高",
  xhigh: "更高", max: "最高", ultra: "超高",
};

function invalid(message = "模型或推理等级参数无效。") {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function unavailable() {
  // Do not relay provider errors or configuration data to the browser.
  return Object.assign(new Error("暂时无法读取 Codex 模型目录，请稍后重试。"), { statusCode: 503 });
}

function selection(value, maxLength) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > maxLength || /[\x00-\x1f\x7f]/u.test(value))
    throw invalid();
  return value.trim();
}

function catalogString(value, maxLength = 256) {
  return typeof value === "string" && value.length <= maxLength && value.trim() && !/[\x00-\x1f\x7f]/u.test(value)
    ? value.trim() : null;
}

function catalogModel(value) {
  if (!value || typeof value !== "object" || value.hidden === true) return null;
  const id = catalogString(value.model);
  if (!id || !Array.isArray(value.supportedReasoningEfforts)) return null;
  const efforts = [];
  const seen = new Set();
  for (const option of value.supportedReasoningEfforts) {
    const effort = catalogString(option?.reasoningEffort, 64);
    if (!effort || seen.has(effort)) continue;
    seen.add(effort);
    efforts.push({ id: effort, label: Object.hasOwn(effortLabels, effort) ? effortLabels[effort] : effort });
  }
  return {
    id,
    name: catalogString(value.displayName, 512) || id,
    defaultEffort: seen.has(value.defaultReasoningEffort) ? value.defaultReasoningEffort : null,
    efforts,
  };
}

export class ModelCatalog {
  constructor({ executable = "codex", prefixArgs = [], codexHome, cwd, timeoutMs = 20000, ttlMs = 300000 } = {}) {
    this.clientOptions = { executable, prefixArgs, codexHome, cwd, timeoutMs };
    this.ttlMs = ttlMs;
    this.cache = null;
    this.expiresAt = 0;
    this.pending = null;
    this.client = null;
    this.stopping = false;
  }

  async list() {
    if (this.stopping) throw unavailable();
    if (this.cache && Date.now() < this.expiresAt) return structuredClone(this.cache);
    if (!this.pending) {
      this.pending = this.read().then((result) => {
        this.cache = result;
        this.expiresAt = Date.now() + this.ttlMs;
        return result;
      }).finally(() => { this.pending = null; });
    }
    return structuredClone(await this.pending);
  }

  async normalize(options = {}, context = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => key !== "model" && key !== "effort")) throw invalid();
    const requestedModel = selection(options.model, 256);
    const requestedEffort = selection(options.effort, 64);
    if (!requestedModel && !requestedEffort) return {};
    if (!context || typeof context !== "object" || Array.isArray(context)) throw invalid();
    const currentModel = selection(context.currentModel, 256);
    const catalog = await this.list();
    const id = requestedModel || currentModel || catalog.defaultModel;
    const model = catalog.models.find((entry) => entry.id === id);
    if (!model) throw invalid("所选模型不在当前可用模型目录中。");
    const effort = requestedEffort || model.defaultEffort;
    if (effort && !model.efforts.some((entry) => entry.id === effort))
      throw invalid("所选模型不支持该推理等级。");
    return { model: model.id, ...(effort ? { effort } : {}) };
  }

  async read() {
    const client = new AppServerClient(this.clientOptions);
    this.client = client;
    try {
      await client.initialize();
      const models = [];
      const seenModels = new Set();
      const seenCursors = new Set();
      let catalogDefault = null;
      let cursor;
      for (let page = 0; ; page++) {
        if (page >= 100) throw unavailable();
        const result = await client.request("model/list", { includeHidden: false, ...(cursor ? { cursor } : {}) });
        if (!result || !Array.isArray(result.data)) throw unavailable();
        for (const entry of result.data) {
          const model = catalogModel(entry);
          if (!model || seenModels.has(model.id)) continue;
          seenModels.add(model.id);
          models.push(model);
          if (entry.isDefault === true && !catalogDefault) catalogDefault = model.id;
        }
        if (result.nextCursor == null) break;
        cursor = catalogString(result.nextCursor, 4096);
        if (!cursor || seenCursors.has(cursor)) throw unavailable();
        seenCursors.add(cursor);
      }
      if (!models.length) throw unavailable();
      const response = await client.request("config/read", { includeLayers: false });
      if (!response?.config || typeof response.config !== "object" || Array.isArray(response.config)) throw unavailable();
      const configuredModel = catalogString(response.config.model);
      const configuredEffort = catalogString(response.config.model_reasoning_effort, 64);
      const selected = models.find(({ id }) => id === configuredModel)
        || models.find(({ id }) => id === catalogDefault) || models[0];
      const defaultEffort = selected.id === configuredModel && selected.efforts.some(({ id }) => id === configuredEffort)
        ? configuredEffort : selected.defaultEffort;
      if (this.stopping) throw unavailable();
      return { models, defaultModel: selected.id, defaultEffort };
    } catch {
      throw unavailable();
    } finally {
      await client.close();
      if (this.client === client) this.client = null;
    }
  }

  async stop() {
    this.stopping = true;
    await this.client?.close();
    await this.pending?.catch(() => {});
  }
}

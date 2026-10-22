const key = "codex-pocket-unconfirmed";
export class SubmissionTracker {
  constructor(storage, storageKey = key) {
    this.storage = storage;
    this.key = storageKey;
    this.items = [];
    try {
      const raw = JSON.parse(storage.getItem(this.key) || "[]");
      if (Array.isArray(raw))
        this.items = raw.filter(
          (x) =>
            typeof x.threadId === "string" &&
            typeof x.text === "string" &&
            typeof x.requestId === "string",
        );
    } catch {}
  }
  save() {
    try {
      this.storage.setItem(this.key, JSON.stringify(this.items));
    } catch {}
  }
  get(threadId, text, makeId, settings = {}) {
    const model = settings.model || "", effort = settings.effort || "";
    const action = settings.action || "", turnId = settings.turnId || "";
    const queuedSubmissionId = settings.queuedSubmissionId || "";
    let item = this.items.find(
      (x) => x.threadId === threadId && x.text === text &&
        (x.model || "") === model && (x.effort || "") === effort &&
        (x.action || "") === action && (x.turnId || "") === turnId &&
        (x.queuedSubmissionId || "") === queuedSubmissionId,
    );
    if (!item) {
      item = { threadId, text, requestId: makeId() };
      if (model) item.model = model;
      if (effort) item.effort = effort;
      if (action) item.action = action;
      if (turnId) item.turnId = turnId;
      if (queuedSubmissionId) item.queuedSubmissionId = queuedSubmissionId;
      this.items.push(item);
      this.save();
    }
    return item;
  }
  acknowledge(requestId) {
    this.items = this.items.filter((x) => x.requestId !== requestId);
    this.save();
  }
  latest(threadId) {
    return this.items.findLast((x) => threadId === undefined || x.threadId === threadId) || null;
  }
  clear() {
    this.items = [];
    try {
      this.storage.removeItem(this.key);
    } catch {}
  }
}

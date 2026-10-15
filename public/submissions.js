const key = "codex-pocket-unconfirmed";
export class SubmissionTracker {
  constructor(storage) {
    this.storage = storage;
    this.items = [];
    try {
      const raw = JSON.parse(storage.getItem(key) || "[]");
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
      this.storage.setItem(key, JSON.stringify(this.items));
    } catch {}
  }
  get(threadId, text, makeId) {
    let item = this.items.find(
      (x) => x.threadId === threadId && x.text === text,
    );
    if (!item) {
      item = { threadId, text, requestId: makeId() };
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
    return this.items.findLast((x) => x.threadId === threadId) || null;
  }
  clear() {
    this.items = [];
    try {
      this.storage.removeItem(key);
    } catch {}
  }
}

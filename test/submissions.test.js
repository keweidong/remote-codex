import test from "node:test";
import assert from "node:assert/strict";
import { SubmissionTracker } from "../public/submissions.js";

test("an unacknowledged send keeps its id across other chats, edits and page reload", () => {
  const values = new Map();
  const storage = {
    getItem: (k) => values.get(k) || null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
  let counter = 0;
  const makeId = () => `request-${++counter}`;
  let tracker = new SubmissionTracker(storage);
  const first = tracker.get("chat-a", "do the work", makeId);
  tracker.get("chat-b", "different chat", makeId);
  tracker.get("chat-a", "edited draft", makeId);
  tracker = new SubmissionTracker(storage);
  assert.equal(
    tracker.get("chat-a", "do the work", makeId).requestId,
    first.requestId,
  );
  tracker.acknowledge(first.requestId);
  assert.notEqual(
    tracker.get("chat-a", "do the work", makeId).requestId,
    first.requestId,
  );
  tracker.clear();
  assert.equal(new SubmissionTracker(storage).latest("chat-a"), null);
});

test("submission identity includes exact model and effort and restores them after reload", () => {
  const values = new Map();
  const storage = {getItem: k => values.get(k), setItem: (k,v) => values.set(k,v)};
  let n = 0;
  const makeId = () => `request-${++n}`;
  const tracker = new SubmissionTracker(storage);
  const inherited = tracker.get("chat", "same", makeId);
  assert.deepEqual(inherited, {threadId: "chat", text: "same", requestId: "request-1"});
  const chosen = tracker.get("chat", "same", makeId, {model: "model-a", effort: "high"});
  const otherEffort = tracker.get("chat", "same", makeId, {model: "model-a", effort: "low"});
  assert.notEqual(chosen.requestId, inherited.requestId);
  assert.notEqual(chosen.requestId, otherEffort.requestId);
  const reloaded = new SubmissionTracker(storage);
  assert.equal(reloaded.get("chat", "same", makeId, {model: "model-a", effort: "high"}).requestId, chosen.requestId);
  assert.equal(reloaded.latest("chat").effort, "low");
  assert.equal(reloaded.get("chat", "same", makeId, {}).requestId, inherited.requestId);
});

test("legacy submissions without model options reuse their inherited identity", () => {
  const storage = {getItem: () => JSON.stringify([{threadId: "chat", text: "old", requestId: "legacy"}]), setItem() {}};
  const tracker = new SubmissionTracker(storage);
  assert.equal(tracker.get("chat", "old", () => "new", {model: "", effort: ""}).requestId, "legacy");
  assert.equal(tracker.get("chat", "old", () => "new", {effort: "high"}).requestId, "new");
});

test("control identities bind the action and original turn across reloads without colliding with queue sends", () => {
  const values = new Map();
  const storage = {getItem: k => values.get(k), setItem: (k, v) => values.set(k, v)};
  const tracker = new SubmissionTracker(storage);
  let n = 0;
  const uuid = () => "request-" + ++n;
  const queued = tracker.get("chat", "same", uuid);
  const steered = tracker.get("chat", "same", uuid, {action: "steer", turnId: "turn-one"});
  const later = tracker.get("chat", "same", uuid, {action: "steer", turnId: "turn-two"});
  const interrupted = tracker.get("chat", "same", uuid, {action: "interrupt", turnId: "turn-one"});
  assert.equal(new Set([queued.requestId, steered.requestId, later.requestId, interrupted.requestId]).size, 4);
  assert.equal(steered.action, "steer");
  assert.equal(steered.turnId, "turn-one");
  const restored = new SubmissionTracker(storage).get("chat", "same", uuid, {action: "steer", turnId: "turn-one"});
  assert.equal(restored.requestId, steered.requestId);
});

test("queue resume identities stay bound to the original queued item across reloads", () => {
  const values = new Map();
  const storage = {getItem: k => values.get(k), setItem: (k, v) => values.set(k, v)};
  const tracker = new SubmissionTracker(storage, "resume");
  let n = 0;
  const id = () => "resume-" + ++n;
  const one = tracker.get("chat", "", id, {action: "resumeQueue", queuedSubmissionId: "head-one"});
  const two = tracker.get("chat", "", id, {action: "resumeQueue", queuedSubmissionId: "head-two"});
  assert.notEqual(one.requestId, two.requestId);
  const original = new SubmissionTracker(storage, "resume").get("chat", "", id,
    {action: "resumeQueue", queuedSubmissionId: "head-one"});
  assert.equal(original.requestId, one.requestId);
  assert.equal(original.queuedSubmissionId, "head-one");
});

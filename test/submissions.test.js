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

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../src/auth.js";

test("pair grants expire, are single-use, and refresh invalidates the old grant", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codex-remote-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = 1000;
  const auth = new AuthStore({ dataDir: dir, now: () => now });
  const old = auth.createGrant();
  const grant = auth.createGrant();
  assert.throws(() => auth.pair(old.token, "Old"), /配对/);
  const { token, device } = auth.pair(grant.token, "My phone");
  assert.equal(auth.authenticate(token).name, "My phone");
  assert.throws(() => auth.pair(grant.token, "Replay"), /配对/);
  const expired = auth.createGrant();
  now = expired.expiresAt + 1;
  assert.throws(() => auth.pair(expired.token, "Late"), /配对/);
  auth.revoke(device.id);
  assert.equal(auth.authenticate(token), null);
});

test("device credentials persist as hashes, revoke survives restart, expired sessions fail closed", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codex-remote-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.now();
  let auth = new AuthStore({ dataDir: dir, now: () => now });
  const { token, device } = auth.pair(auth.createGrant().token, "Phone");
  assert.equal(
    readFileSync(join(dir, "devices.json"), "utf8").includes(token),
    false,
  );
  auth = new AuthStore({ dataDir: dir, now: () => now });
  assert.equal(auth.authenticate(token).id, device.id);
  auth.revoke(device.id);
  auth = new AuthStore({ dataDir: dir, now: () => now });
  assert.equal(auth.authenticate(token), null);
  const next = auth.pair(auth.createGrant().token, "Second");
  now += 31 * 24 * 3600 * 1000;
  assert.equal(auth.authenticate(next.token), null);
});

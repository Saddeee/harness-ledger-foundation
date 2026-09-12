import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Round 6 Task 1: a plain-file lock so the app (the web server's own
// executor loop) and a manually-run `npm run harness:executor` CLI
// invocation never both drive Lovable at once. Nothing here touches
// SQLite or the network -- just node:fs against a scratch directory.
import { acquireLock, heartbeat, releaseLock } from "../src/executor/lock.ts";

const tmp = mkdtempSync(join(tmpdir(), "harness-lock-test-"));
let n = 0;
/** A fresh, never-touched path per test -- a foreign (non-this-process)
 * lock some tests write directly is deliberately left in place by
 * releaseLock (see the "does nothing when held by a different pid" test),
 * so sharing one path across tests would leak that state forward. */
function freshLockPath(): string {
  n += 1;
  return join(tmp, `executor-${n}.lock`);
}

test("acquireLock: an unheld path is acquired, with holder info matching owner/pid", () => {
  const lockPath = freshLockPath();
  const result = acquireLock(lockPath, "app");
  assert.equal(result.held, true);
  assert.ok(result.holder);
  assert.equal(result.holder!.owner, "app");
  assert.equal(result.holder!.pid, process.pid);
  assert.ok(result.holder!.heartbeat_at);

  const onDisk = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(onDisk.owner, "app");
  assert.equal(onDisk.pid, process.pid);
});

test("acquireLock: a second caller is refused while the first holder's heartbeat is fresh, and sees who holds it", () => {
  const lockPath = freshLockPath();
  const first = acquireLock(lockPath, "cli");
  assert.equal(first.held, true);

  const second = acquireLock(lockPath, "app");
  assert.equal(second.held, false);
  assert.ok(second.holder);
  assert.equal(second.holder!.owner, "cli", "the refused caller learns who actually holds it");
  assert.equal(second.holder!.pid, process.pid);
});

test("acquireLock: the same process re-acquiring its own held, fresh lock succeeds (reentrant)", () => {
  const lockPath = freshLockPath();
  const first = acquireLock(lockPath, "app");
  assert.equal(first.held, true);
  const again = acquireLock(lockPath, "app");
  assert.equal(again.held, true, "the process already holding the lock can re-acquire it");
});

test("heartbeat: updates heartbeat_at on the held lock without changing owner/pid", async () => {
  const lockPath = freshLockPath();
  acquireLock(lockPath, "cli");
  const before = JSON.parse(readFileSync(lockPath, "utf8"));
  await new Promise((r) => setTimeout(r, 5));
  heartbeat(lockPath);
  const after = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(after.owner, "cli");
  assert.equal(after.pid, process.pid);
  assert.notEqual(after.heartbeat_at, before.heartbeat_at, "heartbeat_at advanced");
});

test("heartbeat: throws when there is no lock file to heartbeat", () => {
  assert.throws(() => heartbeat(freshLockPath()));
});

test("acquireLock: a lock whose heartbeat is older than 3 minutes is stale and can be taken by a different owner/pid", () => {
  const lockPath = freshLockPath();
  // Simulate a crashed holder: write the lock file directly (a different
  // pid than this test process) with a heartbeat well past the 3-minute
  // staleness window, rather than going through acquireLock (which always
  // stamps process.pid).
  const staleHeartbeat = new Date(Date.now() - 4 * 60 * 1000).toISOString();
  writeFileSync(
    lockPath,
    JSON.stringify({ owner: "cli", pid: 999999, heartbeat_at: staleHeartbeat }),
  );

  const result = acquireLock(lockPath, "app");
  assert.equal(result.held, true, "a stale lock (no heartbeat in >3 minutes) can be taken");
  assert.equal(result.holder!.owner, "app");
  assert.equal(result.holder!.pid, process.pid);

  const onDisk = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(onDisk.owner, "app", "the file itself now reflects the new holder");
});

test("acquireLock: a heartbeat just under 3 minutes old is NOT stale -- still refused", () => {
  const lockPath = freshLockPath();
  const almostStale = new Date(Date.now() - 2 * 60 * 1000 - 30 * 1000).toISOString(); // 2m30s
  writeFileSync(lockPath, JSON.stringify({ owner: "cli", pid: 999999, heartbeat_at: almostStale }));

  const result = acquireLock(lockPath, "app");
  assert.equal(result.held, false, "2m30s old is inside the 3-minute staleness window");
});

test("releaseLock: removes the lock file when called by the process that holds it, and is idempotent", () => {
  const lockPath = freshLockPath();
  acquireLock(lockPath, "app");
  assert.ok(existsSync(lockPath));
  releaseLock(lockPath);
  assert.ok(!existsSync(lockPath));

  // idempotent: releasing an already-released (or never-acquired) path is a no-op
  releaseLock(lockPath);
  assert.ok(!existsSync(lockPath));
});

test("releaseLock: does nothing when the on-disk lock is held by a different pid", () => {
  const lockPath = freshLockPath();
  writeFileSync(
    lockPath,
    JSON.stringify({ owner: "cli", pid: 999999, heartbeat_at: new Date().toISOString() }),
  );
  releaseLock(lockPath);
  assert.ok(existsSync(lockPath), "a lock this process does not hold is left alone");
  const onDisk = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(onDisk.pid, 999999);
});

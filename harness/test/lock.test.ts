import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Round 6 Task 1: a plain-file lock so the app (the web server's own
// executor loop) and a manually-run `npm run harness:executor` CLI
// invocation never both drive Lovable at once. Nothing here touches
// SQLite or the network -- just node:fs against a scratch directory.
// `_fsHooks` is the test-only seam described in lock.ts's own comment --
// used below (round 1 fix) to simulate a real cross-process rename race
// deterministically, since node:fs's own exports cannot be mocked
// (`t.mock.method` throws "Cannot redefine property" on them -- verified).
import { acquireLock, heartbeat, releaseLock, _fsHooks } from "../src/executor/lock.ts";

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

test("heartbeat: updates heartbeat_at on the held lock without changing owner/pid, returns { ok: true }", async () => {
  const lockPath = freshLockPath();
  acquireLock(lockPath, "cli");
  const before = JSON.parse(readFileSync(lockPath, "utf8"));
  await new Promise((r) => setTimeout(r, 5));
  const result = heartbeat(lockPath);
  assert.deepEqual(result, { ok: true });
  const after = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(after.owner, "cli");
  assert.equal(after.pid, process.pid);
  assert.notEqual(after.heartbeat_at, before.heartbeat_at, "heartbeat_at advanced");
});

test("heartbeat: returns { ok: false, holder: null } (does not throw) when there is no lock file to heartbeat", () => {
  const result = heartbeat(freshLockPath());
  assert.deepEqual(result, { ok: false, holder: null });
});

// Round 6 Task 1 fix round 1, item 1 (CRITICAL): heartbeat() had no
// ownership check, so after process B took over a stale lock, A's
// heartbeat() would silently keep refreshing B's file forever -- A never
// finds out it lost the lock. Reproduces the reviewer's exact scenario: A
// acquires, its lock goes stale, B (a different pid, simulated by writing
// the file directly) takes over, then A calls heartbeat().
test("heartbeat: after a stale lock is taken over by a different pid, the original holder's heartbeat() reports the loss and does not touch the file", () => {
  const lockPath = freshLockPath();

  const a = acquireLock(lockPath, "app");
  assert.equal(a.held, true, "A acquires first");

  // Make A's lock stale, then have B (pid 999999, a different owner too,
  // so the takeover is unambiguous) take over -- written directly rather
  // than through acquireLock, exactly like the other staleness tests above,
  // since acquireLock always stamps process.pid (this test process, i.e.
  // "A" itself) and B must be a genuinely different pid.
  const staleHeartbeat = new Date(Date.now() - 4 * 60 * 1000).toISOString();
  writeFileSync(
    lockPath,
    JSON.stringify({ owner: "cli", pid: 999999, heartbeat_at: staleHeartbeat }),
  );
  const bFileBefore = readFileSync(lockPath, "utf8");

  // A, unaware it lost the lock, calls heartbeat().
  const result = heartbeat(lockPath);
  assert.equal(result.ok, false, "A no longer holds the lock -- heartbeat must report failure");
  if (!result.ok) {
    assert.ok(result.holder, "the current holder is named");
    assert.equal(result.holder!.owner, "cli", "it's B's lock now");
    assert.equal(result.holder!.pid, 999999);
  }

  // The critical assertion: A's heartbeat() must not have written anything
  // -- B's file is byte-for-byte unchanged.
  assert.equal(
    readFileSync(lockPath, "utf8"),
    bFileBefore,
    "A's heartbeat call did not touch B's lock file at all",
  );
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

// Round 6 Task 1 fix round 1, item 2 (IMPORTANT): acquireLock's stale
// takeover used to be read -> check -> overwrite-in-place, with no
// atomicity -- two processes racing the same stale lock could both believe
// they won. The fix routes the takeover through a temp-file-then-rename
// (atomic) followed by a re-read that verifies this process actually ended
// up as the last writer. This test drives that exact verification path by
// simulating, via the `_fsHooks` test seam (see this file's top-of-file
// comment for why: node:fs's own exports cannot be mocked), a competing
// process's rename landing immediately after this process's own rename --
// the real race the fix exists to detect.
test("acquireLock: stale takeover verification reports held:false when another process's rename wins the race", () => {
  const lockPath = freshLockPath();
  const staleHeartbeat = new Date(Date.now() - 4 * 60 * 1000).toISOString();
  writeFileSync(
    lockPath,
    JSON.stringify({ owner: "cli", pid: 111111, heartbeat_at: staleHeartbeat }),
  );

  const realRenameSync = _fsHooks.renameSync;
  const rival = { owner: "cli" as const, pid: 222222, heartbeat_at: new Date().toISOString() };
  _fsHooks.renameSync = (...args: Parameters<typeof realRenameSync>) => {
    // Perform this process's own rename for real (so the temp file is
    // actually consumed, matching what would happen in production), then
    // simulate a rival process's rename landing immediately afterward --
    // exactly the interleaving acquireLock's post-rename re-read exists to
    // detect.
    const result = (realRenameSync as (...a: Parameters<typeof realRenameSync>) => void)(...args);
    writeFileSync(lockPath, JSON.stringify(rival));
    return result;
  };

  try {
    const result = acquireLock(lockPath, "app");
    assert.equal(result.held, false, "the rival's rename landed last -- this call lost the race");
    assert.ok(result.holder, "the actual (rival) holder is reported");
    assert.equal(result.holder!.pid, 222222);
    assert.equal(result.holder!.owner, "cli");

    const onDisk = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(onDisk.pid, 222222, "the file on disk reflects the true last writer, the rival");
  } finally {
    _fsHooks.renameSync = realRenameSync;
  }
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

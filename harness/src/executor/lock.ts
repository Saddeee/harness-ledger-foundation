/**
 * A plain-file process lock so the app (the web server's own executor loop)
 * and a manually-run `npm run harness:executor` CLI invocation never both
 * drive Lovable at once (Round 6: the paired-test runner spends real
 * credits and mutates a copy project -- two drivers racing on the same
 * project would double the spend and interleave writes).
 *
 * Deliberately not an flock/advisory OS lock: the two drivers can be on
 * different processes started minutes apart, and the whole point is that a
 * crashed holder's lock can be taken over once its heartbeat goes stale --
 * an OS lock releases the instant its process dies, which would just move
 * the "is anyone still driving" question back into an fs check anyway. A
 * heartbeat file makes staleness explicit and testable without a crash.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authFilePath } from "./lovable-auth.js";

export type LockOwner = "app" | "cli";

export type LockHolder = {
  owner: LockOwner;
  pid: number;
  /** ISO 8601 timestamp of the holder's last heartbeat. */
  heartbeat_at: string;
};

export type LockAcquireResult = { held: boolean; holder?: LockHolder };

/** heartbeat()'s result: `ok: true` means this process's heartbeat_at was
 * refreshed; `ok: false` means the on-disk lock is no longer this process's
 * -- either someone else has taken it over (`holder` names them) or the
 * file is simply gone (`holder: null`). A caller (the scheduler loop) must
 * stop touching Lovable on `ok: false` -- it no longer holds the lock. */
export type HeartbeatResult = { ok: true } | { ok: false; holder: LockHolder | null };

/** A held lock with no heartbeat in this long is stale and can be taken --
 * the holder is assumed crashed (a live holder heartbeats far more often). */
const STALE_AFTER_MS = 3 * 60 * 1000;

/**
 * Test-only seam: every fs call this module makes for reading/writing the
 * lock file goes through here instead of calling node:fs directly. Node's
 * builtin module exports are non-configurable (`Object.defineProperty`
 * throws `Cannot redefine property` -- verified directly, node:test's own
 * `t.mock.method` cannot patch them either), so there is no way to
 * intercept node:fs itself to simulate a real cross-process race
 * deterministically from a single test process. This plain, ordinary
 * exported object *is* reconfigurable, and is the only way
 * test/lock.test.ts can simulate "another process's rename lands between
 * this process's own rename and its post-rename verification read" (a real
 * race acquireLock must handle correctly, exercised via the actual
 * production code path, not a reimplementation of it).
 *
 * Production code (acquireLock/heartbeat/releaseLock's callers) never
 * touches this -- it exists solely so the test file can reach in.
 */
export const _fsHooks = { readFileSync, writeFileSync, renameSync };

/** `harness/data/executor.lock`, next to the auth file (authFilePath()) --
 * both are per-install local state, and colocating means one
 * HARNESS_DB_PATH/HARNESS_AUTH_PATH override moves both together in tests. */
export function defaultLockPath(): string {
  return join(dirname(authFilePath()), "executor.lock");
}

function readLock(path: string): LockHolder | null {
  try {
    const raw = JSON.parse(_fsHooks.readFileSync(path, "utf8")) as Partial<LockHolder>;
    if (
      (raw.owner !== "app" && raw.owner !== "cli") ||
      typeof raw.pid !== "number" ||
      typeof raw.heartbeat_at !== "string"
    ) {
      return null;
    }
    return { owner: raw.owner, pid: raw.pid, heartbeat_at: raw.heartbeat_at };
  } catch {
    return null;
  }
}

function writeLock(path: string, holder: LockHolder): void {
  mkdirSync(dirname(path), { recursive: true });
  _fsHooks.writeFileSync(path, JSON.stringify(holder));
}

function isStale(holder: LockHolder, now: number): boolean {
  const heartbeatMs = new Date(holder.heartbeat_at).getTime();
  if (Number.isNaN(heartbeatMs)) return true; // unparseable heartbeat -- treat as abandoned
  return now - heartbeatMs > STALE_AFTER_MS;
}

function isEExist(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EEXIST"
  );
}

/** Writes `holder` to `path` via a temp-file-then-rename, which POSIX
 * guarantees is atomic (no partial/torn read is ever possible, unlike an
 * in-place overwrite) -- then re-reads `path` to see who actually ended up
 * as the last writer. Used only for "contested" writes: a stale lock (any
 * number of processes may be racing to take over the very same one) or a
 * present-but-unparseable file. Two racing callers each do their own
 * temp+rename; the OS serializes the two renames, and only the true last
 * writer sees its own data on re-read -- the loser sees the winner's,
 * exactly the signal `acquireLock` needs to report `held: false` honestly
 * instead of assuming its own write stuck. */
function atomicTakeover(path: string, holder: LockHolder, owner: LockOwner): LockAcquireResult {
  const tmpPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  _fsHooks.writeFileSync(tmpPath, JSON.stringify(holder));
  _fsHooks.renameSync(tmpPath, path);
  const verified = readLock(path);
  if (verified && verified.pid === process.pid && verified.owner === owner) {
    return { held: true, holder: verified };
  }
  return { held: false, holder: verified ?? undefined };
}

/**
 * Claims the lock at `path` for `owner` (the current process's pid is
 * stamped in). Succeeds when the path is unheld, held by a stale heartbeat
 * (>3 minutes, see STALE_AFTER_MS), or already held by this exact
 * process+owner (reentrant -- the executor's own retry/resume path can
 * re-acquire without first releasing). Otherwise returns
 * `{ held: false, holder }` so the caller can report who actually holds it
 * -- including the case where this process holds it under a *different*
 * owner label, which is treated as a genuine conflict, not reentrancy.
 *
 * Every write that could be contested (no file yet, or a stale takeover) is
 * atomic: a fresh path is claimed with an exclusive create (`wx`, which
 * fails loudly with EEXIST rather than silently overwriting a
 * simultaneous winner), and a stale takeover goes through
 * `atomicTakeover`'s temp-file-then-rename-then-verify dance. Only the
 * reentrant refresh (this process already owns it) is a plain overwrite --
 * nothing else could legitimately be racing to become *this exact*
 * pid+owner's lock.
 */
export function acquireLock(path: string = defaultLockPath(), owner: LockOwner): LockAcquireResult {
  const now = Date.now();
  const holder: LockHolder = {
    owner,
    pid: process.pid,
    heartbeat_at: new Date(now).toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });

  let existing = readLock(path);
  if (!existing) {
    try {
      _fsHooks.writeFileSync(path, JSON.stringify(holder), { flag: "wx" });
      return { held: true, holder };
    } catch (err) {
      if (!isEExist(err)) throw err;
      // Someone else won the exclusive-create race between our readLock
      // and our writeFileSync -- see what they actually left behind rather
      // than assume we lost.
      existing = readLock(path);
    }
  }

  if (existing) {
    const heldByMe = existing.pid === process.pid && existing.owner === owner;
    if (heldByMe) {
      writeLock(path, holder);
      return { held: true, holder };
    }
    if (!isStale(existing, now)) {
      return { held: false, holder: existing };
    }
  }

  // Reached only for a stale lock, or a file that exists but is
  // unparseable (corrupt/foreign content) -- both are takeable, and both
  // are contested (another process may be racing this exact takeover).
  return atomicTakeover(path, holder, owner);
}

/** Refreshes heartbeat_at on the lock this process already holds --
 * verifying first that the on-disk lock is still this exact process's
 * (same pid; a different pid could only be there if this process's lock
 * went stale and someone else took it over). On a mismatch, this does NOT
 * write (refreshing a lock that is no longer ours would silently keep the
 * real holder's file alive on their behalf forever) and returns
 * `{ ok: false, holder }` naming whoever now holds it -- or `{ ok: false,
 * holder: null }` if the file is simply gone. A caller (the scheduler
 * loop) must treat `ok: false` as "I no longer hold the lock, stop
 * touching Lovable until re-acquiring." */
export function heartbeat(path: string = defaultLockPath()): HeartbeatResult {
  const existing = readLock(path);
  if (!existing) return { ok: false, holder: null };
  if (existing.pid !== process.pid) return { ok: false, holder: existing };
  writeLock(path, { ...existing, heartbeat_at: new Date().toISOString() });
  return { ok: true };
}

/** Releases the lock, but only when this process is the one holding it (a
 * process whose lock went stale and was taken over must not delete the new
 * holder's lock out from under it). A missing or already-foreign lock file
 * is a silent no-op either way. */
export function releaseLock(path: string = defaultLockPath()): void {
  if (!existsSync(path)) return;
  const existing = readLock(path);
  if (existing && existing.pid !== process.pid) return;
  rmSync(path, { force: true });
}

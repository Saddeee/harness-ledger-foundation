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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** A held lock with no heartbeat in this long is stale and can be taken --
 * the holder is assumed crashed (a live holder heartbeats far more often). */
const STALE_AFTER_MS = 3 * 60 * 1000;

/** `harness/data/executor.lock`, next to the auth file (authFilePath()) --
 * both are per-install local state, and colocating means one
 * HARNESS_DB_PATH/HARNESS_AUTH_PATH override moves both together in tests. */
export function defaultLockPath(): string {
  return join(dirname(authFilePath()), "executor.lock");
}

function readLock(path: string): LockHolder | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LockHolder>;
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
  writeFileSync(path, JSON.stringify(holder));
}

function isStale(holder: LockHolder, now: number): boolean {
  const heartbeatMs = new Date(holder.heartbeat_at).getTime();
  if (Number.isNaN(heartbeatMs)) return true; // unparseable heartbeat -- treat as abandoned
  return now - heartbeatMs > STALE_AFTER_MS;
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
 */
export function acquireLock(path: string = defaultLockPath(), owner: LockOwner): LockAcquireResult {
  const existing = readLock(path);
  const now = Date.now();
  const heldByMe = existing && existing.pid === process.pid && existing.owner === owner;
  if (existing && !heldByMe && !isStale(existing, now)) {
    return { held: false, holder: existing };
  }
  const holder: LockHolder = { owner, pid: process.pid, heartbeat_at: new Date(now).toISOString() };
  writeLock(path, holder);
  return { held: true, holder };
}

/** Refreshes heartbeat_at on the lock this process already holds. Throws if
 * there is no lock file at `path` -- heartbeating a lock never acquired is a
 * caller bug, not a race worth silently papering over. */
export function heartbeat(path: string = defaultLockPath()): void {
  const existing = readLock(path);
  if (!existing) throw new Error(`no lock file at ${path} to heartbeat`);
  writeLock(path, { ...existing, heartbeat_at: new Date().toISOString() });
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

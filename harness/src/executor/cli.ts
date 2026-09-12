/**
 * Operator CLI: `npm run harness:executor -- [--connect|--status|--disconnect|--once|--analyse]`.
 * With no flag it runs the scheduler loop until interrupted. Prints no secrets.
 */
import { connect, disconnect, status } from "./lovable-auth.js";
import { loop, runOnce, nextRunAt, scheduleFromSettings } from "./schedule.js";
import { currentLockHolder } from "./lock.js";
import { getSettings, latestSyncRun } from "../store.js";
import { runAnalyseCommand } from "../analysis/run.js";
import { createCallLlm } from "../llm/index.js";

const USAGE =
  "Usage: npm run harness:executor -- [--connect | --status | --disconnect | --once | --analyse]";

// Accept both `--status` and the bare `status` the first version took.
const command = (process.argv[2] ?? "").replace(/^--/, "");

function printStatus(): void {
  const connection = status();
  const schedule = scheduleFromSettings(getSettings());
  const last = latestSyncRun();
  const lastStarted = last ? new Date(last.started_at.replace(" ", "T") + "Z") : null;
  console.log(
    JSON.stringify(
      {
        connection,
        schedule,
        last_run: last,
        next_run_at: nextRunAt(new Date(), lastStarted, schedule)?.toISOString() ?? null,
        // Round 6 Task 2: who currently drives the schedule, if anyone --
        // "app" is the web server's own in-app scheduler, "cli" is a
        // `npm run harness:executor` loop (this process, or another one).
        schedule_holder: currentLockHolder(),
      },
      null,
      2,
    ),
  );
}

if (command === "" || command === "loop") {
  // Round 6 Task 2: claims the executor lock as "cli" -- if the app (the
  // web server's own in-app scheduler) already holds it, loop() logs that
  // once and returns immediately without touching Lovable.
  await loop({ owner: "cli" });
} else if (command === "status") {
  printStatus();
} else if (command === "once") {
  // A connection that cannot be opened (expired grant, network) is an operator
  // problem, not a crash: one line and a non-zero exit for cron to notice.
  let result;
  try {
    result = await runOnce();
  } catch (err) {
    console.error(`Could not reach Lovable: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!result.ran) process.exit(0);
  if (!result.ok) process.exit(1);
} else if (command === "analyse") {
  // Round 4 Task A3 (fix round 1): queues an analysis_requests row (same
  // audit trail a UI-triggered "Analyse now" leaves) and refuses to overlap
  // a run already in flight, exactly like `--once` does for sync -- see
  // runAnalyseCommand's own doc comment. Independent of the Lovable
  // connection (spec §2). Never throws; prints no key material, only
  // counts/tokens.
  const outcome = await runAnalyseCommand(createCallLlm());
  if (!outcome.ran) process.exit(0);
  if (!outcome.result.ok) process.exit(1);
} else if (command === "connect") {
  const me = await connect();
  console.log(`Connected as ${me.email ?? "(unknown)"} — ${me.workspaces.length} workspace(s).`);
} else if (command === "disconnect") {
  await disconnect();
  console.log("Disconnected. Local credentials removed.");
} else {
  console.error(`Unknown command "${process.argv[2]}". ${USAGE}`);
  process.exit(1);
}

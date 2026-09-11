/**
 * Operator CLI: `npm run harness:executor -- [--connect|--status|--disconnect|--once]`.
 * With no flag it runs the scheduler loop until interrupted. Prints no secrets.
 */
import { connect, disconnect, status } from "./lovable-auth.js";
import { loop, runOnce, nextRunAt, scheduleFromSettings } from "./schedule.js";
import { getSettings, latestSyncRun } from "../store.js";

const USAGE = "Usage: npm run harness:executor -- [--connect | --status | --disconnect | --once]";

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
      },
      null,
      2,
    ),
  );
}

if (command === "" || command === "loop") {
  await loop();
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

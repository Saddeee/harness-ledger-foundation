/**
 * Tiny operator CLI for the Lovable connection: `npm run executor -- status|connect|disconnect`.
 * Prints no secrets.
 */
import { connect, disconnect, status } from "./lovable-auth.js";

const command = process.argv[2] ?? "status";

if (command === "status") {
  console.log(JSON.stringify(status(), null, 2));
} else if (command === "connect") {
  const me = await connect();
  console.log(`Connected as ${me.email ?? "(unknown)"} — ${me.workspaces.length} workspace(s).`);
} else if (command === "disconnect") {
  await disconnect();
  console.log("Disconnected. Local credentials removed.");
} else {
  console.error(`Unknown command "${command}". Use status | connect | disconnect.`);
  process.exit(1);
}

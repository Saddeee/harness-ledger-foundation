// Append-only event log helper. Every state transition writes one row.
import { db } from "./db";

export async function logEvent(
  ownerUserId: string | null,
  kind: string,
  refTable: string,
  refId: string | null,
  payload: unknown,
): Promise<void> {
  await db.from("events").insert({
    owner_user_id: ownerUserId,
    kind,
    ref_table: refTable,
    ref_id: refId,
    payload: payload as never,
  });
}

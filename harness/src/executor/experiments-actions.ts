/**
 * Round 6 Task 6b: the `test` action's own dispatch. Lives here, not in
 * improvements.ts (which may never import anything Lovable-related -- see
 * its own "no Lovable import" test), and not folded straight into
 * startExperiment (experiments.ts, Task 6a's runner, which must not know
 * about the queue or the Improvement view). beats.ts's
 * improvementActionAndWrite calls testAction before it ever reaches
 * peekActionKind/improvementAction -- "test" is intentionally absent from
 * improvements.ts's own action schema (see its own comment there).
 */
import { z } from "zod";
import { getImprovement, type Improvement } from "../improvements.js";
import { startExperiment } from "./experiments.js";
import { createLovableRest } from "./lovable-rest.js";
import { kickExperimentRunner } from "./experiments-queue.js";

const testActionInput = z.object({ action: z.literal("test"), id: z.number().int() });

/** True for any input shaped like a `test` action -- checked BEFORE the
 * input is otherwise validated (testActionInput.parse, inside testAction,
 * does the real validation), so a caller can route to this function without
 * risking peekActionKind/improvementAction ever seeing action: "test" (which
 * they don't recognize). */
export function isTestAction(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as Record<string, unknown>)["action"] === "test"
  );
}

/**
 * Starts a paired test for one correction/rule (spec §6 "Trigger"): refuses
 * with the exact sentence startExperiment itself returns (budget, not
 * connected, already running, no request to replay) by throwing -- the same
 * convention every other improvementAction case uses for a request that
 * can't be honoured, which the API route already turns into a 400 with that
 * message. On success, queues the run and kicks the background queue (fire-
 * and-forget -- this request does not wait for the run to finish) before
 * returning the refreshed improvement, whose `test.run` now shows the fresh
 * `queued` row.
 */
export async function testAction(input: unknown): Promise<Improvement> {
  const { id } = testActionInput.parse(input);

  const rest = createLovableRest();
  const result = await startExperiment(id, { rest });
  if ("refused" in result) {
    throw new Error(result.refused);
  }

  // Fire-and-forget: this request returns as soon as the run is queued, not
  // once it finishes. kickExperimentRunner's own in-flight flag makes this
  // safe to call again from runAll's own end-of-pass call without racing.
  void kickExperimentRunner();

  const improvement = getImprovement(id, { connected: true });
  if (!improvement) throw new Error(`improvement ${id} not found after starting a test`);
  return improvement;
}

// Settings page for the local runtime: the sync schedule, the Knowledge
// character cap, and a read-only note about approval. Only talks to the
// executor route (fetchExecutor/postExecutor) -- nothing on this page ever
// writes to Lovable itself; it only changes what the executor does on its
// own schedule.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  executorQueryOptions,
  postExecutor,
  type ExecutorSchedule,
} from "@/lib/improvements-client";

const DEFAULT_SCHEDULE: ExecutorSchedule = {
  enabled: true,
  interval_minutes: 60,
  window_start_hour: 10,
  window_end_hour: 22,
};
// The store's own default (harness/src/store.ts SETTING_DEFAULTS); GET
// executor doesn't echo the current cap back today, so the input starts
// here and reflects whatever this session has saved.
const DEFAULT_CAP = 9000;

const SCHEDULE_LINE =
  "Syncing reads your Lovable chats and Knowledge. It uses no Lovable credits and no AI.";
const CAP_LINE = "Lovable allows 10,000 characters; Harness keeps a margin.";
const APPROVAL_LINE = "Nothing is written to Lovable until you approve it here.";

export function LocalSettings() {
  const qc = useQueryClient();
  const executor = useQuery(executorQueryOptions);

  const [schedule, setSchedule] = useState<ExecutorSchedule>(DEFAULT_SCHEDULE);
  const [cap, setCap] = useState(DEFAULT_CAP);

  useEffect(() => {
    if (executor.data?.schedule) setSchedule(executor.data.schedule);
  }, [executor.data?.schedule]);

  const saveSchedule = useMutation({
    mutationFn: () =>
      postExecutor({
        action: "schedule",
        enabled: schedule.enabled,
        interval_minutes: schedule.interval_minutes,
        window_start_hour: schedule.window_start_hour,
        window_end_hour: schedule.window_end_hour,
      }),
    onSuccess: () => {
      toast.success("Sync schedule saved");
      void qc.invalidateQueries({ queryKey: executorQueryOptions.queryKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the schedule"),
  });

  const saveCap = useMutation({
    mutationFn: () => postExecutor({ action: "settings", knowledge_char_cap: cap }),
    onSuccess: () => toast.success("Knowledge limit saved"),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the limit"),
  });

  return (
    <div className="max-w-xl space-y-8">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <section className="space-y-4 rounded-md border p-4">
        <h2 className="text-lg font-medium">Sync schedule</h2>

        <div className="flex items-center justify-between">
          <Label htmlFor="sync-enabled">Sync on a schedule</Label>
          <Switch
            id="sync-enabled"
            checked={schedule.enabled}
            onCheckedChange={(v) => setSchedule((s) => ({ ...s, enabled: v }))}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="interval-minutes">Every N minutes (15–1440)</Label>
          <Input
            id="interval-minutes"
            type="number"
            min={15}
            max={1440}
            value={schedule.interval_minutes}
            onChange={(e) =>
              setSchedule((s) => ({ ...s, interval_minutes: Number(e.target.value) }))
            }
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="window-start">Between hour (0–24)</Label>
            <Input
              id="window-start"
              type="number"
              min={0}
              max={24}
              value={schedule.window_start_hour}
              onChange={(e) =>
                setSchedule((s) => ({ ...s, window_start_hour: Number(e.target.value) }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="window-end">and hour (0–24)</Label>
            <Input
              id="window-end"
              type="number"
              min={0}
              max={24}
              value={schedule.window_end_hour}
              onChange={(e) =>
                setSchedule((s) => ({ ...s, window_end_hour: Number(e.target.value) }))
              }
            />
          </div>
        </div>

        <p className="text-sm text-muted-foreground">{SCHEDULE_LINE}</p>

        <Button onClick={() => saveSchedule.mutate()} disabled={saveSchedule.isPending}>
          {saveSchedule.isPending ? "Saving…" : "Save schedule"}
        </Button>
      </section>

      <section className="space-y-4 rounded-md border p-4">
        <h2 className="text-lg font-medium">Knowledge limit</h2>

        <div className="space-y-2">
          <Label htmlFor="knowledge-cap">Character cap (1,000–10,000)</Label>
          <Input
            id="knowledge-cap"
            type="number"
            min={1000}
            max={10000}
            value={cap}
            onChange={(e) => setCap(Number(e.target.value))}
          />
        </div>

        <p className="text-sm text-muted-foreground">{CAP_LINE}</p>

        <Button onClick={() => saveCap.mutate()} disabled={saveCap.isPending}>
          {saveCap.isPending ? "Saving…" : "Save limit"}
        </Button>
      </section>

      <section className="space-y-2 rounded-md border p-4">
        <h2 className="text-lg font-medium">Approval</h2>
        <p className="text-sm text-muted-foreground">{APPROVAL_LINE}</p>
      </section>
    </div>
  );
}

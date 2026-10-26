import { Cron } from "croner";
import { Play, Trash2 } from "lucide-react";
import { useState } from "react";
import type { BotId, RoutineInput } from "../../shared/contracts.ts";
import { api } from "../lib/api.ts";
import { useAppState } from "../lib/live.tsx";
import { choiceKey, connectedModels, useCatalog } from "../lib/models.ts";
import { useOverlay } from "../lib/overlay.ts";
import { Button, Dialog, DialogClose, ErrorText, Field, Input, Segmented, Select, Textarea } from "../ui.tsx";

type When = "hour" | "day" | "weekdays" | "monday" | "week" | "month" | "interval" | "cron";

const whenOptions: { value: When; label: string }[] = [
  { value: "hour", label: "Every hour" },
  { value: "day", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "monday", label: "Every Monday" },
  { value: "week", label: "Every week" },
  { value: "month", label: "Every month" },
  { value: "interval", label: "Interval" },
  { value: "cron", label: "Cron" },
];

/** Turns the friendly choice into a cron expression. */
function toCron(when: When, time: string, minutes: number, cron: string) {
  const [hour = "9", minute = "0"] = time.split(":").map((part) => String(Number(part)));
  switch (when) {
    case "hour":
      return `${minute} * * * *`;
    case "day":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "monday":
    case "week":
      return `${minute} ${hour} * * 1`;
    case "month":
      return `${minute} ${hour} 1 * *`;
    case "interval":
      return `*/${Math.max(1, Math.min(59, minutes))} * * * *`;
    default:
      return cron;
  }
}

/** Reads a saved cron back into the friendly choice where possible. */
function fromCron(cron: string): { when: When; time: string; minutes: number } {
  const parts = cron.trim().split(/\s+/);
  const [minute, hour, day, , weekday] = parts;
  const time = `${String(hour ?? "9").padStart(2, "0")}:${String(minute ?? "0").padStart(2, "0")}`;
  if (parts.length !== 5) return { when: "cron", time: "09:00", minutes: 15 };
  if (/^\*\/\d+$/.test(minute ?? "") && hour === "*")
    return { when: "interval", time: "09:00", minutes: Number(minute?.slice(2)) };
  if (/^\d+$/.test(minute ?? "") && hour === "*" && day === "*" && weekday === "*")
    return { when: "hour", time: `09:${String(minute).padStart(2, "0")}`, minutes: 15 };
  if (/^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "")) {
    if (day === "*" && weekday === "*") return { when: "day", time, minutes: 15 };
    if (day === "*" && weekday === "1-5") return { when: "weekdays", time, minutes: 15 };
    if (day === "*" && weekday === "1") return { when: "monday", time, minutes: 15 };
    if (day === "1" && weekday === "*") return { when: "month", time, minutes: 15 };
  }
  return { when: "cron", time: "09:00", minutes: 15 };
}

export function RoutineEditor({ id }: { id: string }) {
  const state = useAppState();
  const overlay = useOverlay();
  const catalog = useCatalog();
  const existing = state.routines.find((routine) => routine.id === id);
  const presetBot = id.startsWith("new:") ? (id.slice(4) as BotId) : (state.bots[0]?.id ?? "");
  const [form, setForm] = useState<RoutineInput>(
    existing ?? { name: "", botId: presetBot, instruction: "", schedule: "0 9 * * *", active: true, model: null },
  );
  const parsed = fromCron(form.schedule);
  const [when, setWhen] = useState<When>(parsed.when);
  const [time, setTime] = useState(parsed.time);
  const [minutes, setMinutes] = useState(parsed.minutes);
  const [cron, setCron] = useState(form.schedule);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => overlay.set({ routine: null });

  const schedule = toCron(when, time, minutes, cron);
  let next: string[] = [];
  try {
    next = new Cron(schedule, { paused: true }).nextRuns(3).map((date) =>
      date.toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  } catch {}

  const models = connectedModels(state.models, catalog);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { ...form, schedule };
      if (existing) await api("PUT", `/routines/${existing.id}`, body);
      else await api("POST", "/routines", body);
      close();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={existing ? existing.name : "New routine"} onClose={close}>
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
        <h2 className="text-[15px] font-semibold">{existing ? "Routine" : "New routine"}</h2>
        <DialogClose onClose={close} />
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
        <Field label="Name">
          <Input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="Morning trend scan"
          />
        </Field>
        <Field label="Bot">
          <Select value={form.botId} onChange={(event) => setForm({ ...form, botId: event.target.value as BotId })}>
            {state.bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Instruction">
          <Textarea
            rows={4}
            value={form.instruction}
            onChange={(event) => setForm({ ...form, instruction: event.target.value })}
          />
        </Field>
        <Field label="When to run">
          <Select value={when} onChange={(event) => setWhen(event.target.value as When)}>
            {whenOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        {when === "interval" ? (
          <Field label="Every (minutes)">
            <Input
              type="number"
              min={1}
              max={59}
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value))}
            />
          </Field>
        ) : when === "cron" ? (
          <Field label="Cron">
            <Input
              className="font-mono"
              value={cron}
              onChange={(event) => setCron(event.target.value)}
              spellCheck={false}
            />
          </Field>
        ) : when !== "hour" ? (
          <Field label="Time">
            <Input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
          </Field>
        ) : null}
        {next.length ? (
          <p className="text-xs text-muted-foreground">Next: {next.join(" · ")}</p>
        ) : (
          <p className="text-xs text-destructive">Not a valid schedule</p>
        )}
        <Field label="Bot’s model">
          <Select
            value={choiceKey(form.model)}
            onChange={(event) =>
              setForm({ ...form, model: models.find((model) => model.key === event.target.value)?.choice ?? null })
            }
          >
            <option value="">The bot’s own model</option>
            {models.map((model) => (
              <option key={model.key} value={model.key}>
                {model.label}
              </option>
            ))}
          </Select>
        </Field>
        <Segmented
          wide
          label="Status"
          value={form.active ? "active" : "paused"}
          onChange={(value) => setForm({ ...form, active: value === "active" })}
          options={[
            { value: "active", label: "Active" },
            { value: "paused", label: "Paused" },
          ]}
        />
        <ErrorText error={error} />
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-3">
        {existing ? (
          <>
            <Button
              variant="danger"
              size="icon"
              aria-label="Delete routine"
              onClick={() => void api("DELETE", `/routines/${existing.id}`).then(close)}
            >
              <Trash2 className="size-4" />
            </Button>
            <Button variant="ghost" onClick={() => void api("POST", `/routines/${existing.id}/run`).then(close)}>
              <Play className="size-3.5" /> Run now
            </Button>
          </>
        ) : null}
        <Button
          variant="primary"
          className="ml-auto"
          busy={busy}
          disabled={!form.name.trim() || !form.instruction.trim() || !next.length}
          onClick={() => void save()}
        >
          Save
        </Button>
      </div>
    </Dialog>
  );
}

import { Check, Ellipsis, Flame, MessageCircle, Pause, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { dayOf, habitCadence, habitStats, profileStrength } from "../../shared/coach.ts";
import type { Habit } from "../../shared/contracts.ts";
import { api } from "../lib/api.ts";
import { useAppState } from "../lib/live.tsx";
import { PageHeader } from "../shell/app-shell.tsx";
import { Button, cx, ErrorText, Input, Menu, MenuItem, Section, Select } from "../ui.tsx";

const weekday = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "narrow" });

/** A job search space's growth: how strong the profile is, and the habits the person keeps with the Coordinator. */
export function GrowthPage() {
  const state = useAppState();
  const navigate = useNavigate();
  const coach = state.bots.find((bot) => bot.id === "coordinator") ?? state.bots.find((bot) => bot.delegation);
  const { score, gaps } = profileStrength(state.candidate);
  const active = state.habits.filter((habit) => habit.active);
  const paused = state.habits.filter((habit) => !habit.active);

  const ask = (task: string) => {
    if (!coach) return;
    void api("POST", "/runs", { botId: coach.id, task }).then(() => navigate(`/app/bots/${coach.id}`));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        actions={
          coach ? (
            <Button
              variant="primary"
              onClick={() =>
                ask("Coach me: ask me what you most need to know about me, one or two questions at a time.")
              }
            >
              <MessageCircle className="size-4" /> Coach me
            </Button>
          ) : null
        }
      >
        <span className="text-[15px] font-semibold">Growth</span>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-4 py-6">
          <Section
            title="Profile"
            aside={
              coach ? (
                <Button
                  size="sm"
                  onClick={() => ask("Review my résumé and my LinkedIn and Naukri profiles against the roles I want.")}
                >
                  Review my profiles
                </Button>
              ) : null
            }
          >
            <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
              <span className="text-2xl font-semibold tabular-nums">{score}%</span>
              <div
                className="h-2 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label="Profile strength"
                aria-valuenow={score}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${score}%` }} />
              </div>
              {gaps.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {gaps.map((gap) => (
                    <button
                      key={gap.label}
                      type="button"
                      title={gap.question}
                      disabled={!coach}
                      onClick={() => ask(`Help me fill in my profile: ${gap.label}.`)}
                      className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {gap.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </Section>

          <Section title="Habits">
            {active.length ? (
              <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
                {active.map((habit) => (
                  <HabitRow key={habit.id} habit={habit} />
                ))}
              </ul>
            ) : null}
            <NewHabit />
            {paused.length ? (
              <ul className="space-y-1">
                {paused.map((habit) => (
                  <li key={habit.id} className="flex items-center gap-2 px-1 text-[13px] text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate">{habit.title}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void api("PATCH", `/habits/${habit.id}`, { active: true })}
                    >
                      <Play className="size-3.5" /> Resume
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${habit.title}`}
                      onClick={() => void api("DELETE", `/habits/${habit.id}`)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
        </div>
      </div>
    </div>
  );
}

function HabitRow({ habit }: { habit: Habit }) {
  const today = dayOf();
  const stats = habitStats(habit, today);
  const mark = (day: string, done: boolean) => void api("PUT", `/habits/${habit.id}/days/${day}`, { done });
  const unit = habit.cadence === "daily" ? "day" : "week";
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <button
        type="button"
        aria-label={stats.doneToday ? `Mark ${habit.title} not done today` : `Mark ${habit.title} done today`}
        aria-pressed={stats.doneToday}
        onClick={() => mark(today, !stats.doneToday)}
        className={cx(
          "grid size-8 shrink-0 place-items-center rounded-full border transition",
          stats.doneToday ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted",
        )}
      >
        <Check className="size-4" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-medium" title={habit.why || undefined}>
          {habit.title}
        </p>
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{habitCadence(habit)}</span>
          {habit.cadence === "weekly" ? (
            <span>
              {stats.thisWeek} of {habit.target} this week
            </span>
          ) : null}
          {stats.streak ? (
            <span className="inline-flex items-center gap-0.5 text-foreground">
              <Flame className="size-3.5" /> {stats.streak} {unit}
              {stats.streak === 1 ? "" : "s"}
            </span>
          ) : null}
        </p>
      </div>
      <div className="hidden items-center gap-1 sm:flex">
        {stats.last7.map(({ day, done }) => (
          <button
            key={day}
            type="button"
            title={day}
            aria-label={`${habit.title}, ${day}: ${done ? "done" : "not done"}`}
            aria-pressed={done}
            onClick={() => mark(day, !done)}
            className="flex flex-col items-center gap-0.5"
          >
            <span className="text-[10px] text-muted-foreground">{weekday(day)}</span>
            <span
              className={cx(
                "size-3 rounded-full border",
                done ? "border-primary bg-primary" : "border-border",
                day === today && !done && "border-foreground/40",
              )}
            />
          </button>
        ))}
      </div>
      <Menu
        label={`More for ${habit.title}`}
        align="end"
        className="w-auto"
        trigger={
          <span className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted">
            <Ellipsis className="size-4" />
          </span>
        }
      >
        {(close) => (
          <>
            <MenuItem
              onSelect={() => {
                close();
                void api("PATCH", `/habits/${habit.id}`, { active: false });
              }}
            >
              <Pause className="size-4" /> Pause
            </MenuItem>
            <MenuItem
              danger
              onSelect={() => {
                close();
                void api("DELETE", `/habits/${habit.id}`);
              }}
            >
              <Trash2 className="size-4" /> Remove
            </MenuItem>
          </>
        )}
      </Menu>
    </li>
  );
}

/** Adds a habit by hand; most come from agreeing on them with the Coordinator. */
function NewHabit() {
  const [title, setTitle] = useState("");
  const [rhythm, setRhythm] = useState("daily");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    if (!title.trim()) return;
    const weekly = rhythm !== "daily";
    void api("POST", "/habits", {
      title,
      cadence: weekly ? "weekly" : "daily",
      target: weekly ? Number(rhythm) : 1,
    })
      .then(() => {
        setTitle("");
        setRhythm("daily");
        setError(null);
      })
      .catch((failure: Error) => setError(failure.message));
  };
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        add();
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[1fr_10rem_auto]">
        <Input
          value={title}
          maxLength={120}
          placeholder="Message 2 people at a target company"
          aria-label="New habit"
          onChange={(event) => setTitle(event.target.value)}
        />
        <Select aria-label="How often" value={rhythm} onChange={(event) => setRhythm(event.target.value)}>
          <option value="daily">Every day</option>
          {[1, 2, 3, 4, 5].map((times) => (
            <option key={times} value={String(times)}>
              {times === 1 ? "Once a week" : `${times} times a week`}
            </option>
          ))}
        </Select>
        <Button type="submit" className="h-9" disabled={!title.trim()}>
          <Plus className="size-4" /> Add
        </Button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}

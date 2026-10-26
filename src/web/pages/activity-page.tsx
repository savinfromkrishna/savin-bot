import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Run } from "../../shared/contracts.ts";
import { useAppState, useLive } from "../lib/live.tsx";
import { ago, isLive, statusMeta } from "../lib/meta.ts";
import { PageHeader } from "../shell/app-shell.tsx";
import { AvatarMark } from "../shell/avatar.tsx";
import { cx, Segmented } from "../ui.tsx";

type Filter = "all" | "waiting" | "running" | "succeeded" | "failed";

const origin = (run: Run, names: Record<string, string>, groups: Record<string, string>) =>
  run.trigger.kind === "routine"
    ? `Routine · ${run.trigger.name}`
    : run.trigger.kind === "delegation" || run.trigger.kind === "handoff"
      ? `From ${names[run.trigger.fromBotId] ?? "a teammate"}`
      : run.groupId
        ? (groups[run.groupId] ?? "Group")
        : null;

export function ActivityPage() {
  const state = useAppState();
  const { runs } = useLive();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const names = Object.fromEntries(state.bots.map((bot) => [bot.id, bot.name]));
  const groups = Object.fromEntries(state.groups.map((group) => [group.id, group.name]));

  const list = useMemo(
    () =>
      Object.values(runs)
        .filter((run) => filter === "all" || run.status === filter)
        .filter((run) => `${run.task} ${run.result ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 150),
    [runs, filter, query],
  );
  const now = list.filter(isLive);
  const recent = list.filter((run) => !isLive(run));

  const row = (run: Run) => {
    const bot = state.bots.find((candidate) => candidate.id === run.botId);
    const status = statusMeta[run.status];
    const from = origin(run, names, groups);
    return (
      <Link
        key={run.id}
        to={run.groupId ? `/app/g/${run.groupId}#run-${run.id}` : `/app/bots/${run.botId}#run-${run.id}`}
        className="flex gap-3 rounded-2xl px-3 py-3 transition hover:bg-muted"
      >
        {bot ? <AvatarMark avatar={bot.avatar} size={32} /> : null}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-xs">
            <span className="font-semibold">{bot?.name}</span>
            <span className={status.tone}>{status.label}</span>
            {from ? <span className="truncate text-muted-foreground">· {from}</span> : null}
            <span className="ml-auto shrink-0 text-muted-foreground">{ago(run.startedAt)}</span>
          </span>
          <span className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">{run.task}</span>
        </span>
      </Link>
    );
  };

  return (
    <>
      <PageHeader>
        <h1 className="text-[15px] font-semibold">Activity</h1>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 px-4 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="Status"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "waiting", label: "Needs you" },
                { value: "running", label: "Working" },
                { value: "succeeded", label: "Done" },
                { value: "failed", label: "Failed" },
              ]}
            />
            <label className="ml-auto flex h-8 w-full items-center gap-2 rounded-full border border-border px-3 text-muted-foreground sm:w-56">
              <Search className="size-3.5" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search"
                aria-label="Search runs"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none"
              />
            </label>
          </div>
          {now.length ? (
            <section>
              <h2 className="px-3 pb-1 text-xs font-semibold text-muted-foreground">Now</h2>
              {now.map(row)}
            </section>
          ) : null}
          <section className={cx(!now.length && "pt-1")}>
            {now.length ? <h2 className="px-3 pb-1 text-xs font-semibold text-muted-foreground">Recent</h2> : null}
            {recent.length ? (
              recent.map(row)
            ) : (
              <p className="px-3 py-10 text-center text-[13px] text-muted-foreground">Nothing here yet</p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

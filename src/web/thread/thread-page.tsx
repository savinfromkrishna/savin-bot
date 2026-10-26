import { Monitor, Settings2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import type { Bot, Run } from "../../shared/contracts.ts";
import { useAppState, useGone, useLive } from "../lib/live.tsx";
import { clock, isLive } from "../lib/meta.ts";
import { SidePanel, usePanel } from "../panel/side-panel.tsx";
import { PageHeader } from "../shell/app-shell.tsx";
import { AvatarMark } from "../shell/avatar.tsx";
import { markSeen } from "../shell/sidebar.tsx";
import { Button, cx, Spinner } from "../ui.tsx";
import type { ToolStep } from "./blocks.tsx";
import { ApprovalCard, IncomingCard, Reply, TakeoverCard, TeammateCard, ToolActivity, UserBubble } from "./blocks.tsx";
import { Composer } from "./composer.tsx";

type Segment =
  | { kind: "tools"; steps: ToolStep[] }
  | { kind: "message"; id: string; text: string }
  | { kind: "gate"; step: ToolStep }
  | { kind: "teammate"; step: ToolStep };

/** Groups a run's steps the way the thread shows them. */
function segments(run: Run): Segment[] {
  const out: Segment[] = [];
  for (const step of run.steps) {
    if (step.kind === "message") out.push({ kind: "message", id: step.id, text: step.text });
    else if (step.gate) out.push({ kind: "gate", step });
    else if (step.group === "team") out.push({ kind: "teammate", step });
    else {
      const last = out.at(-1);
      if (last?.kind === "tools") last.steps.push(step);
      else out.push({ kind: "tools", steps: [step] });
    }
  }
  return out;
}

export function RunView({
  run,
  bot,
  bots,
  runs,
  showTools,
  showTask = true,
}: {
  run: Run;
  bot: Bot;
  bots: Bot[];
  runs: Record<string, Run>;
  showTools: boolean;
  /** A group thread shows the person's message once, above every bot that answers it. */
  showTask?: boolean;
}) {
  const live = isLive(run);
  const parts = segments(run);
  const thinking =
    run.status === "running" &&
    !run.steps.some((step) => step.kind === "tool" && (step.status === "running" || step.status === "approval"));
  return (
    <div id={`run-${run.id}`} className="scroll-mt-20 space-y-3">
      {showTask && run.trigger.kind === "manual" ? <UserBubble text={run.task} attachments={run.attachments} /> : null}
      {run.trigger.kind === "routine" ? (
        <>
          <p className="text-center text-xs text-muted-foreground">Routine · {run.trigger.name}</p>
          <UserBubble text={run.task} />
        </>
      ) : null}
      {run.trigger.kind === "delegation" ? (
        <IncomingCard
          from={bots.find((other) => run.trigger.kind === "delegation" && other.id === run.trigger.fromBotId)}
          task={run.task}
        />
      ) : null}
      {parts.map((part) => {
        if (part.kind === "message") return <Reply key={part.id} text={part.text} muted />;
        if (part.kind === "gate") {
          return part.step.gate?.kind === "takeover" ? (
            <TakeoverCard key={part.step.id} run={run} step={part.step} bot={bot} />
          ) : (
            <ApprovalCard key={part.step.id} run={run} step={part.step} />
          );
        }
        if (part.kind === "teammate") {
          const child = part.step.childRunId ? runs[part.step.childRunId] : undefined;
          return (
            <TeammateCard
              key={part.step.id}
              step={part.step}
              child={child}
              teammate={bots.find((other) => other.id === (child?.botId ?? part.step.input.bot))}
            />
          );
        }
        return showTools ? (
          <ToolActivity
            key={part.steps[0]?.id}
            steps={part.steps}
            live={live && part === parts.filter((candidate) => candidate.kind === "tools").at(-1)}
            startedAt={part.steps[0]?.at ?? run.startedAt}
            endedAt={part.steps.at(-1)?.endedAt ?? run.endedAt}
          />
        ) : null;
      })}
      {thinking ? (
        <p className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
          <Spinner className="size-3" /> Thinking
        </p>
      ) : null}
      {run.result ? (
        <div className="flex items-end gap-2">
          <Reply text={run.result} />
          <span className="pb-1 text-[11px] text-muted-foreground">{clock(run.endedAt ?? run.startedAt)}</span>
        </div>
      ) : null}
      {run.status === "failed" ? <p className="px-2 text-[13px] text-destructive">{run.error}</p> : null}
      {run.status === "cancelled" ? <p className="px-2 text-xs text-muted-foreground">Stopped</p> : null}
    </div>
  );
}

export function ThreadPage() {
  const { botId } = useParams();
  const state = useAppState();
  const { runs } = useLive();
  const location = useLocation();
  const panel = usePanel();
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const gone = useGone(Boolean(bot));

  const thread = useMemo(
    () =>
      Object.values(runs)
        .filter((run) => run.botId === botId && !run.groupId)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .slice(-60),
    [runs, botId],
  );
  const runList = useMemo(() => Object.values(runs), [runs]);
  const signature = thread.map((run) => `${run.id}:${run.status}:${run.steps.length}`).join("|");

  useEffect(() => {
    if (bot) markSeen(bot.id);
  }, [bot, signature]);

  // Follow new work while the reader is at the bottom; a #run- link jumps to that run instead.
  useLayoutEffect(() => {
    const target = location.hash ? document.getElementById(location.hash.slice(1)) : null;
    if (target) target.scrollIntoView({ block: "start" });
    else if (atBottom) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [signature, location.hash, botId]);

  if (!bot) return gone ? <Navigate to="/app" replace /> : null;
  const cleared = bot.historyClearedAt;

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          actions={
            <>
              {bot.computerAccess !== "off" ? (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Agent computer"
                  className={cx(panel.open && panel.mode === "computer" && "bg-muted")}
                  onClick={() => panel.toggle("computer")}
                >
                  <Monitor className="size-4" />
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                aria-label="Bot settings"
                className={cx(panel.open && panel.mode === "settings" && "bg-muted")}
                onClick={() => panel.toggle("settings")}
              >
                <Settings2 className="size-4" />
              </Button>
            </>
          }
        >
          <button
            type="button"
            onClick={() => panel.toggle("settings")}
            className="flex min-w-0 items-center gap-3 text-left"
          >
            <AvatarMark avatar={bot.avatar} size={32} />
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold">{bot.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{bot.title}</span>
            </span>
          </button>
        </PageHeader>
        <div
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget;
            setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
            {thread.length ? null : (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <AvatarMark avatar={bot.avatar} size={64} />
                <p className="text-[15px] font-semibold">{bot.name}</p>
                <p className="max-w-sm text-[13px] text-muted-foreground">{bot.description}</p>
              </div>
            )}
            {thread.map((run, index) => (
              <div key={run.id}>
                {cleared && run.startedAt > cleared && (thread[index - 1]?.startedAt ?? "") <= cleared ? (
                  <p className="pb-6 text-center text-xs text-muted-foreground">Conversation cleared</p>
                ) : null}
                <RunView
                  run={run}
                  bot={bot}
                  bots={state.bots}
                  runs={runs}
                  showTools={state.preferences.showToolActivity}
                />
              </div>
            ))}
          </div>
        </div>
        <div className="mx-auto w-full max-w-3xl px-4 pb-4">
          <Composer bot={bot} runs={runList} />
        </div>
      </div>
      {panel.open ? <SidePanel bot={bot} panel={panel} /> : null}
    </div>
  );
}

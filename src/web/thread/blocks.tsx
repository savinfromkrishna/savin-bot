import { Ban, Check, ChevronDown, CircleAlert, Clock, Hand, Network, Wrench } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import { Link } from "react-router-dom";
import remarkGfm from "remark-gfm";
import type { Bot, Run, RunStep } from "../../shared/contracts.ts";
import { api, fileUrl } from "../lib/api.ts";
import { approvalTitle, attachmentName, duration, statusMeta, toolGroupMeta, toolLabel } from "../lib/meta.ts";
import { useOverlay } from "../lib/overlay.ts";
import { AvatarMark } from "../shell/avatar.tsx";
import { Button, cx, Spinner } from "../ui.tsx";

export type ToolStep = Extract<RunStep, { kind: "tool" }>;

export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}
      >
        {text}
      </Markdown>
    </div>
  );
}

export function Reply({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <div
      className={cx(
        "max-w-[min(680px,92%)] rounded-3xl px-4 py-2.5 text-[14px]",
        muted ? "text-muted-foreground" : "bg-bubble",
      )}
    >
      <MarkdownText text={text} />
    </div>
  );
}

export function UserBubble({ text, attachments = [] }: { text: string; attachments?: string[] }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[min(620px,88%)] space-y-1.5 rounded-3xl bg-user-bubble px-4 py-2.5 text-[14px] whitespace-pre-wrap text-user-bubble-foreground">
        {text}
        {attachments.length ? (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {attachments.map((path) => (
              <a
                key={path}
                href={fileUrl(path)}
                target="_blank"
                rel="noreferrer"
                className="rounded-full bg-black/10 px-2 py-0.5 text-xs hover:underline"
              >
                {attachmentName(path)}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A short, human line about what a tool call did. */
function detailOf(step: ToolStep) {
  const input = step.input as Record<string, unknown>;
  const pick = (...keys: string[]) =>
    keys.map((key) => input[key]).find((value) => typeof value === "string" && value) as string | undefined;
  return pick("command", "url", "path", "query", "text", "keys", "title", "message", "content", "reason", "name") ?? "";
}

function StepIcon({ step }: { step: ToolStep }) {
  if (step.status === "running") return <Spinner className="text-muted-foreground" />;
  if (step.status === "done") return <Check className="size-3.5 text-success" />;
  if (step.status === "denied") return <Ban className="size-3.5 text-muted-foreground" />;
  if (step.status === "error") return <CircleAlert className="size-3.5 text-destructive" />;
  return <Clock className="size-3.5 text-warning" />;
}

function StepRow({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false);
  const group = toolGroupMeta[step.group as keyof typeof toolGroupMeta];
  const Icon = group?.icon ?? Wrench;
  const detail = detailOf(step);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] hover:bg-muted"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0">{toolLabel(step.tool)}</span>
        {detail ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{detail}</span>
        ) : (
          <span className="flex-1" />
        )}
        <StepIcon step={step} />
      </button>
      {open && step.output ? (
        <pre className="mx-2 mt-1 mb-2 max-h-64 overflow-auto rounded-lg bg-muted p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
          {step.output}
        </pre>
      ) : null}
    </li>
  );
}

/** savin's "Working… · N tools" line: open while live, folded to a summary when done. */
export function ToolActivity({
  steps,
  live,
  startedAt,
  endedAt,
}: {
  steps: ToolStep[];
  live: boolean;
  startedAt: string;
  endedAt: string | null;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const [all, setAll] = useState(false);
  const expanded = open ?? live;
  const shown = all ? steps : steps.slice(-6);
  const hidden = steps.length - shown.length;
  const count = `${steps.length} ${steps.length === 1 ? "tool" : "tools"}`;
  return (
    <div className="max-w-[min(680px,92%)]">
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {live ? <Spinner className="size-3" /> : <Check className="size-3" />}
        {live ? `Working… · ${count}` : `Done · ${count} · ${duration(startedAt, endedAt)}`}
        <ChevronDown className={cx("size-3 transition", expanded && "rotate-180")} />
      </button>
      {expanded ? (
        <ul className="mt-1 border-l border-border pl-2">
          {hidden > 0 ? (
            <li>
              <button
                type="button"
                onClick={() => setAll(true)}
                className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                +{hidden} earlier {hidden === 1 ? "step" : "steps"}
              </button>
            </li>
          ) : null}
          {shown.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const decide = (run: Run, step: ToolStep, decision: "allow" | "always" | "deny") =>
  api("POST", `/runs/${run.id}/steps/${step.id}/decision`, { decision });

/** "Review before …" with Allow once / Always allow this tool / Deny, and the answer afterwards. */
export function ApprovalCard({ run, step }: { run: Run; step: ToolStep }) {
  const overlay = useOverlay();
  const [busy, setBusy] = useState(false);
  if (step.gate?.kind !== "approval") return null;
  const pending = step.status === "approval";
  const answer = (decision: "allow" | "always" | "deny") => {
    setBusy(true);
    void decide(run, step, decision).finally(() => setBusy(false));
  };
  const outcome =
    step.decision === "always"
      ? "Always allowed"
      : step.decision === "allow"
        ? "Allowed once"
        : step.decision === "deny"
          ? "Denied"
          : "No longer active";
  return (
    <div className="max-w-[min(520px,92%)] rounded-3xl border border-border bg-card p-4">
      <p className="text-[14px]">{approvalTitle(step.tool)}</p>
      {step.gate.why ? <p className="mt-1 text-xs text-muted-foreground">{step.gate.why}</p> : null}
      {step.gate.summary ? (
        <pre className="mt-2 max-h-48 overflow-auto rounded-xl px-1 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {step.gate.summary}
        </pre>
      ) : null}
      {pending ? (
        <div className="mt-3 space-y-2">
          <Button
            variant="primary"
            className="h-10 w-full justify-start rounded-xl px-4"
            busy={busy}
            onClick={() => answer("allow")}
          >
            Allow once
          </Button>
          {step.gate.allowAlways ? (
            <Button
              className="h-10 w-full justify-start rounded-xl px-4"
              disabled={busy}
              onClick={() => answer("always")}
            >
              Always allow this tool
            </Button>
          ) : null}
          <Button className="h-10 w-full justify-start rounded-xl px-4" disabled={busy} onClick={() => answer("deny")}>
            Deny
          </Button>
          {step.group === "browser" ? (
            <Button
              variant="ghost"
              className="h-9 w-full justify-start rounded-xl px-4"
              onClick={() => overlay.set({ computer: run.botId, window: null })}
            >
              Look at the page
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          {outcome}
          {step.status === "done" ? <Check className="size-3 text-success" /> : null}
          {step.status === "error" ? <CircleAlert className="size-3 text-destructive" /> : null}
        </p>
      )}
    </div>
  );
}

/**
 * A bot asking a person to take over its browser (sign in, solve a challenge, confirm a payment),
 * or to add a browser signed in to Gemini, or to choose the channel uploads go to.
 */
export function TakeoverCard({ run, step, bot }: { run: Run; step: ToolStep; bot: Bot }) {
  const overlay = useOverlay();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (step.gate?.kind !== "takeover") return null;
  const pending = step.status === "approval";
  const addBrowser = () => {
    setBusy(true);
    void api<{ tab: string }>("POST", "/browsers")
      .then(({ tab }) => overlay.set({ computer: bot.id, tab, window: null }))
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="max-w-[min(520px,92%)] rounded-3xl border border-warning/50 bg-card p-4">
      <div className="flex items-center gap-2">
        <Hand className="size-4 text-warning" />
        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
          {pending ? "Needs you" : step.decision === "deny" ? "Skipped" : "Done"}
        </span>
      </div>
      <p className="mt-2 text-[14px]">{step.gate.reason}</p>
      {pending ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {step.gate.action === "add-browser" ? (
            <Button variant="primary" busy={busy} onClick={addBrowser}>
              Add browser
            </Button>
          ) : step.gate.action === "choose-channel" ? (
            <Button variant="primary" onClick={() => overlay.set({ integrations: "youtube" })}>
              Choose channel
            </Button>
          ) : (
            <Button variant="primary" onClick={() => overlay.set({ computer: bot.id, window: null })}>
              Open computer
            </Button>
          )}
          <Button onClick={() => void decide(run, step, "allow")}>I'm done</Button>
          <Button variant="ghost" onClick={() => void decide(run, step, "deny")}>
            Skip
          </Button>
        </div>
      ) : null}
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** Work handed to a teammate, with its live status and report. */
export function TeammateCard({
  step,
  child,
  teammate,
}: {
  step: ToolStep;
  child: Run | undefined;
  teammate: Bot | undefined;
}) {
  const status = child ? statusMeta[child.status] : null;
  return (
    <div className="max-w-[min(560px,92%)] rounded-3xl border border-border bg-card p-4">
      <div className="flex items-center gap-2.5">
        {teammate ? <AvatarMark avatar={teammate.avatar} size={28} /> : <Network className="size-4" />}
        <span className="text-[13px] font-semibold">{teammate?.name ?? "Teammate"}</span>
        {status ? (
          <span className={cx("rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium", status.tone)}>
            {status.label}
          </span>
        ) : null}
        {child ? (
          <Link
            to={`/app/bots/${child.botId}#run-${child.id}`}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
          >
            Open
          </Link>
        ) : null}
      </div>
      <p className="mt-2 line-clamp-3 text-[13px] text-muted-foreground">{String(step.input.task ?? "")}</p>
      {child?.result ? (
        <div className="mt-2 line-clamp-6 border-t border-border pt-2 text-[13px]">
          <MarkdownText text={child.result} />
        </div>
      ) : null}
    </div>
  );
}

/** A task that arrived from a teammate rather than from you. */
export function IncomingCard({ from, task }: { from: Bot | undefined; task: string }) {
  return (
    <div className="max-w-[min(560px,92%)] rounded-3xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {from ? <AvatarMark avatar={from.avatar} size={20} /> : null}
        From {from?.name ?? "a teammate"}
      </div>
      <p className="mt-1.5 text-[14px] whitespace-pre-wrap">{task}</p>
    </div>
  );
}

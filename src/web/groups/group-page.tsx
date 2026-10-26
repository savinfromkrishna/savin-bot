import { Settings2 } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import type { Bot, BotId, Group, Run } from "../../shared/contracts.ts";
import { api } from "../lib/api.ts";
import { useAppState, useGone, useLive } from "../lib/live.tsx";
import { PageHeader } from "../shell/app-shell.tsx";
import { AvatarMark } from "../shell/avatar.tsx";
import { markSeen } from "../shell/sidebar.tsx";
import { UserBubble } from "../thread/blocks.tsx";
import { Composer } from "../thread/composer.tsx";
import { RunView } from "../thread/thread-page.tsx";
import { Button, cx, Dialog, DialogClose, ErrorText, Field, Input } from "../ui.tsx";

/** Overlapping avatars of a group's first members. */
export function GroupMark({ bots, size = 32 }: { bots: Bot[]; size?: number }) {
  const shown = bots.slice(0, 3);
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {shown.map((bot, index) => (
        <span
          key={bot.id}
          className="absolute rounded-full ring-2 ring-sidebar"
          style={{ left: index * (size / 4), top: index * (size / 8), zIndex: shown.length - index }}
        >
          <AvatarMark avatar={bot.avatar} size={Math.round(size * 0.66)} />
        </span>
      ))}
    </span>
  );
}

/** Choose 2–10 bots; the order of picking is kept, since the first answers when nobody is mentioned. */
export function MemberPicker({ value, onChange }: { value: BotId[]; onChange: (botIds: BotId[]) => void }) {
  const state = useAppState();
  return (
    <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-xl border border-border p-1">
      {state.bots.map((bot) => {
        const place = value.indexOf(bot.id);
        return (
          <button
            key={bot.id}
            type="button"
            aria-pressed={place >= 0}
            onClick={() =>
              onChange(
                place >= 0 ? value.filter((id) => id !== bot.id) : value.length < 10 ? [...value, bot.id] : value,
              )
            }
            className={cx(
              "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition",
              place >= 0 ? "bg-muted" : "hover:bg-muted/60",
            )}
          >
            <AvatarMark avatar={bot.avatar} size={28} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{bot.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{bot.title}</span>
            </span>
            {place >= 0 ? (
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                {place + 1}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** savin's "New group": a name and its members. */
export function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [botIds, setBotIds] = useState<BotId[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const group = await api<Group>("POST", "/groups", { name, botIds });
      onClose();
      navigate(`/app/g/${group.id}`);
    } catch (failure) {
      setError((failure as Error).message || "Could not create group");
      setBusy(false);
    }
  };
  return (
    <GroupForm
      title="New group"
      name={name}
      onName={setName}
      botIds={botIds}
      onBotIds={setBotIds}
      error={error}
      onClose={onClose}
      onSubmit={submit}
      submit={
        <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || botIds.length < 2}>
          {busy ? "Creating…" : "Create group"}
        </Button>
      }
    />
  );
}

function GroupForm({
  title,
  name,
  onName,
  botIds,
  onBotIds,
  error,
  onClose,
  onSubmit,
  submit,
  extra,
}: {
  title: string;
  name: string;
  onName: (name: string) => void;
  botIds: BotId[];
  onBotIds: (botIds: BotId[]) => void;
  error: string | null;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  submit: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={onSubmit} className="flex min-h-0 flex-col">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <DialogClose onClose={onClose} />
        </div>
        <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-5">
          <Field label="Name">
            <Input
              autoFocus
              maxLength={80}
              value={name}
              placeholder="Name this group"
              onChange={(event) => onName(event.target.value)}
            />
          </Field>
          <Field label="Members (pick 2–10)">
            <MemberPicker value={botIds} onChange={onBotIds} />
          </Field>
          <ErrorText error={error} />
          {extra}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {submit}
        </div>
      </form>
    </Dialog>
  );
}

function GroupSettings({ group, onClose }: { group: Group; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState(group.name);
  const [botIds, setBotIds] = useState<BotId[]>(group.botIds);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("PUT", `/groups/${group.id}`, { name, botIds });
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };
  return (
    <GroupForm
      title="Group settings"
      name={name}
      onName={setName}
      botIds={botIds}
      onBotIds={setBotIds}
      error={error}
      onClose={onClose}
      onSubmit={submit}
      submit={
        <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || botIds.length < 2}>
          Save
        </Button>
      }
      extra={
        confirming ? (
          <div className="space-y-2 rounded-xl border border-destructive/40 p-3">
            <p className="text-[13px] font-medium">Delete {group.name}?</p>
            <p className="text-xs text-muted-foreground">This cannot be undone.</p>
            <div className="flex gap-2">
              <Button
                variant="danger"
                onClick={() =>
                  void api("DELETE", `/groups/${group.id}`).then(() => {
                    onClose();
                    navigate("/app", { replace: true });
                  })
                }
              >
                Delete
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Delete group
          </Button>
        )
      }
    />
  );
}

type Message = { id: string; ask: Run | null; replies: Run[] };

/** One shared thread: each message of yours, then every member that answered it. */
export function GroupPage() {
  const { groupId } = useParams();
  const state = useAppState();
  const { runs } = useLive();
  const location = useLocation();
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [settings, setSettings] = useState(false);
  const group = state.groups.find((candidate) => candidate.id === groupId);
  const gone = useGone(Boolean(group));
  const members = useMemo(
    () => (group ? group.botIds.flatMap((id) => state.bots.filter((bot) => bot.id === id)) : []),
    [group, state.bots],
  );

  const messages = useMemo(() => {
    const list: Message[] = [];
    const byId = new Map<string, Message>();
    const replies = Object.values(runs)
      .filter((run) => run.groupId === groupId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const run of replies) {
      const key = run.messageId ?? run.id;
      let message = byId.get(key);
      if (!message) {
        message = { id: key, ask: null, replies: [] };
        byId.set(key, message);
        list.push(message);
      }
      if (run.trigger.kind === "manual" && !message.ask) message.ask = run;
      message.replies.push(run);
    }
    return list.slice(-40);
  }, [runs, groupId]);
  const runList = useMemo(() => Object.values(runs), [runs]);
  const signature = messages
    .flatMap((message) => message.replies.map((run) => `${run.id}:${run.status}:${run.steps.length}`))
    .join("|");

  useEffect(() => {
    if (group) markSeen(`group:${group.id}`);
  }, [group, signature]);

  useLayoutEffect(() => {
    const target = location.hash ? document.getElementById(location.hash.slice(1)) : null;
    if (target) target.scrollIntoView({ block: "start" });
    else if (atBottom) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [signature, location.hash, groupId]);

  if (!group) return gone ? <Navigate to="/app" replace /> : null;
  const nameOf = (id: BotId) => state.bots.find((bot) => bot.id === id)?.name ?? "A teammate";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        actions={
          <Button variant="ghost" size="icon" aria-label="Group settings" onClick={() => setSettings(true)}>
            <Settings2 className="size-4" />
          </Button>
        }
      >
        <button type="button" onClick={() => setSettings(true)} className="flex min-w-0 items-center gap-3 text-left">
          <GroupMark bots={members} size={32} />
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-semibold">{group.name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {members.map((bot) => bot.name).join(", ")}
            </span>
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
        <div className="mx-auto max-w-3xl space-y-8 px-4 py-6">
          {messages.length ? null : (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <GroupMark bots={members} size={64} />
              <p className="text-[15px] font-semibold">{group.name}</p>
              <p className="max-w-sm text-[13px] text-muted-foreground">
                {members[0]
                  ? `${members[0].name} answers first. @name picks who answers; @everyone wakes them all.`
                  : null}
              </p>
            </div>
          )}
          {messages.map((message) => (
            <div key={message.id} className="space-y-5">
              {message.ask ? <UserBubble text={message.ask.task} attachments={message.ask.attachments} /> : null}
              {message.replies.map((run) => {
                const bot = state.bots.find((candidate) => candidate.id === run.botId);
                if (!bot) return null;
                return (
                  <div key={run.id} className="space-y-2">
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <AvatarMark avatar={bot.avatar} size={20} />
                      <span className="font-medium text-foreground">{bot.name}</span>
                      {run.trigger.kind === "handoff" ? <span>· from {nameOf(run.trigger.fromBotId)}</span> : null}
                    </p>
                    {run.trigger.kind === "handoff" ? (
                      <p className="border-l-2 border-border pl-3 text-xs text-muted-foreground">{run.task}</p>
                    ) : null}
                    <RunView
                      run={run}
                      bot={bot}
                      bots={state.bots}
                      runs={runs}
                      showTools={state.preferences.showToolActivity}
                      showTask={false}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        <Composer group={group} runs={runList} />
      </div>
      {settings ? <GroupSettings group={group} onClose={() => setSettings(false)} /> : null}
    </div>
  );
}

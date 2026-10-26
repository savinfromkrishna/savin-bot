import {
  Activity,
  Blocks,
  Bot,
  Briefcase,
  ChevronRight,
  Ellipsis,
  FolderPlus,
  Gauge,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  Sprout,
  Users,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import type { SpaceSummary } from "../../shared/contracts.ts";
import { jobRoles, teamRoles } from "../../shared/ids.ts";
import { GroupMark } from "../groups/group-page.tsx";
import { useAccount } from "../lib/account.tsx";
import { api } from "../lib/api.ts";
import { authClient } from "../lib/auth.ts";
import { useAppState, useLive } from "../lib/live.tsx";
import { ago, isLive } from "../lib/meta.ts";
import { useOverlay } from "../lib/overlay.ts";
import { cx, Menu, MenuItem } from "../ui.tsx";
import { AvatarMark } from "./avatar.tsx";
import { DeleteSpaceDialog, RenameSpaceDialog } from "./create-dialogs.tsx";
import { Logo } from "./logo.tsx";

/** The last time each bot's thread was open, for unread dots. */
export const seenKey = (botId: string) => `seen:${botId}`;
export const markSeen = (botId: string) => {
  try {
    localStorage.setItem(seenKey(botId), new Date().toISOString());
  } catch {}
};
const seenAt = (botId: string) => {
  try {
    return localStorage.getItem(seenKey(botId)) ?? "";
  } catch {
    return "";
  }
};

/** Which spaces were folded or unfolded by hand; the rest follow the current space. Remembered per browser. */
function useFoldedSpaces() {
  const [chosen, setChosen] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("sidebar:folded") ?? "{}");
    } catch {
      return {};
    }
  });
  return {
    folded: (spaceId: string, current: boolean) => chosen[spaceId] ?? !current,
    set(spaceId: string, folded: boolean) {
      const next = { ...chosen, [spaceId]: folded };
      setChosen(next);
      try {
        localStorage.setItem("sidebar:folded", JSON.stringify(next));
      } catch {}
    },
  };
}

const navClass = ({ isActive }: { isActive: boolean }) =>
  cx(
    "flex h-9 items-center gap-2.5 rounded-xl px-3 text-[13px] font-medium transition",
    isActive ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
  );

/** An icon-only button or link in the collapsed sidebar. */
const railClass = ({ isActive }: { isActive: boolean }) =>
  cx(
    "relative grid size-10 place-items-center rounded-xl transition",
    isActive ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
  );

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";

const UnreadDot = ({ className }: { className?: string }) => (
  <span className={cx("size-2 shrink-0 rounded-full bg-primary", className)}>
    <span className="sr-only">Unread</span>
  </span>
);

/** A space's header: fold it with a click, and savin's actions menu beside it. */
function SpaceHeader({
  space,
  folded,
  count,
  onFold,
  onRename,
  onDelete,
}: {
  space: SpaceSummary;
  folded: boolean;
  count: number;
  onFold: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { space: current } = useAccount();
  const state = useAppState();
  const jobs = state.space.kind === "jobs";
  const missingTeam =
    space.id === current.id && (jobs ? jobRoles : teamRoles).some((role) => !state.bots.some((bot) => bot.id === role));
  return (
    <div className="flex items-center gap-1 px-1 pt-3 pb-1">
      <button
        type="button"
        aria-expanded={!folded}
        onClick={onFold}
        className={cx(
          "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 text-left hover:bg-card/60",
          space.id === current.id ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <ChevronRight className={cx("size-3.5 shrink-0 transition-transform", !folded && "rotate-90")} />
        <span className="min-w-0 truncate text-[11px] font-medium tracking-wider uppercase">{space.name}</span>
        {folded ? <span className="shrink-0 text-[11px] text-muted-foreground">{count}</span> : null}
      </button>
      <Menu
        label={`Actions for ${space.name}`}
        align="end"
        trigger={
          <span className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-card hover:text-foreground">
            <Ellipsis className="size-4" />
          </span>
        }
      >
        {(close) => (
          <>
            <MenuItem
              onSelect={() => {
                close();
                onRename();
              }}
            >
              Rename space
            </MenuItem>
            {missingTeam ? (
              <MenuItem
                onSelect={() => {
                  close();
                  void api("POST", "/team");
                }}
              >
                {jobs ? "Add job search team" : "Add social media team"}
              </MenuItem>
            ) : null}
            {space.isDefault ? null : (
              <MenuItem
                danger
                onSelect={() => {
                  close();
                  onDelete();
                }}
              >
                Delete space
              </MenuItem>
            )}
          </>
        )}
      </Menu>
    </div>
  );
}

/**
 * The bots and groups, the spaces, and everything else in reach. With `collapsed` it is a narrow rail of
 * icons and the current space's bots; `onToggle` offers the switch between the two.
 */
export function Sidebar({
  onNavigate,
  collapsed = false,
  onToggle,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const state = useAppState();
  const { me, space: current, switchSpace } = useAccount();
  const { runs } = useLive();
  const overlay = useOverlay();
  const location = useLocation();
  const navigate = useNavigate();
  const spaces = useFoldedSpaces();
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<SpaceSummary | null>(null);
  const [deleting, setDeleting] = useState<SpaceSummary | null>(null);
  const matches = (name: string, title: string) =>
    `${name} ${title}`.toLowerCase().includes(query.trim().toLowerCase());

  const rows = useMemo(() => {
    const all = Object.values(runs).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return state.bots
      .filter((bot) => matches(bot.name, bot.title))
      .map((bot) => {
        const mine = all.filter((run) => run.botId === bot.id && !run.groupId);
        const latest = mine[0];
        const working = mine.find(isLive);
        const status = working ? (working.status === "waiting" ? ("waiting" as const) : ("working" as const)) : null;
        const preview = working
          ? status === "waiting"
            ? "Needs you"
            : "Working…"
          : latest
            ? (latest.result ?? latest.error ?? latest.task)
            : bot.title;
        const finishedAt = latest?.endedAt ?? null;
        const viewing = location.pathname === `/app/bots/${bot.id}`;
        return {
          bot,
          status,
          preview,
          time: latest ? ago(latest.endedAt ?? latest.startedAt) : "",
          unread: Boolean(finishedAt && !viewing && finishedAt > seenAt(bot.id)),
        };
      });
  }, [state.bots, runs, query, location.pathname]);

  const groupRows = useMemo(() => {
    const all = Object.values(runs).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return state.groups
      .filter((group) => matches(group.name, ""))
      .map((group) => {
        const mine = all.filter((run) => run.groupId === group.id);
        const latest = mine[0];
        const working = mine.find(isLive);
        const members = group.botIds.flatMap((id) => state.bots.filter((bot) => bot.id === id));
        const finishedAt = latest?.endedAt ?? null;
        const viewing = location.pathname === `/app/g/${group.id}`;
        return {
          group,
          members,
          preview: working
            ? working.status === "waiting"
              ? "Needs you"
              : "Working…"
            : (latest?.result ?? members.map((bot) => bot.name).join(", ")),
          waiting: working?.status === "waiting",
          time: latest ? ago(latest.endedAt ?? latest.startedAt) : "",
          unread: Boolean(finishedAt && !viewing && finishedAt > seenAt(`group:${group.id}`)),
        };
      });
  }, [state.groups, state.bots, runs, query, location.pathname]);

  const open = (spaceId: string, path: string) => {
    if (spaceId !== current.id) switchSpace(spaceId);
    navigate(path);
    onNavigate?.();
  };

  const createMenu = (trigger: ReactNode) => (
    <Menu label="Create" align={collapsed ? "start" : "end"} trigger={trigger}>
      {(close) => (
        <>
          <MenuItem
            onSelect={() => {
              close();
              overlay.set({ create: "bot" });
            }}
          >
            <Bot className="size-4" /> Create new Bot
          </MenuItem>
          <MenuItem
            onSelect={() => {
              close();
              overlay.set({ create: "group" });
            }}
          >
            <Users className="size-4" /> Create new Group
          </MenuItem>
          <MenuItem
            onSelect={() => {
              close();
              overlay.set({ create: "space" });
            }}
          >
            <FolderPlus className="size-4" /> Create new Space
          </MenuItem>
        </>
      )}
    </Menu>
  );

  const accountMenu = (trigger: ReactNode) => (
    <Menu label="Account" up trigger={trigger}>
      {(close) => (
        <>
          <p className="truncate px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground">{me.user.email}</p>
          <MenuItem
            onSelect={() => {
              close();
              overlay.set({ settings: "general" });
            }}
          >
            <Settings className="size-4" /> Settings
          </MenuItem>
          <MenuItem
            onSelect={() => {
              close();
              overlay.set({ settings: "usage" });
            }}
          >
            <Gauge className="size-4" /> Usage
          </MenuItem>
          <MenuItem
            onSelect={() => {
              close();
              void authClient.signOut().then(() => {
                try {
                  localStorage.removeItem("space-id");
                } catch {}
                window.location.assign("/");
              });
            }}
          >
            <LogOut className="size-4" /> Log out
          </MenuItem>
        </>
      )}
    </Menu>
  );

  const pages = [
    { to: "/app", end: true, label: "Team map", icon: Workflow },
    { to: "/app/activity", end: false, label: "Activity", icon: Activity },
    ...(state.space.kind === "jobs"
      ? [
          { to: "/app/growth", end: false, label: "Growth", icon: Sprout },
          { to: "/app/applications", end: false, label: "Applications", icon: Briefcase },
        ]
      : []),
  ];

  if (collapsed) {
    return (
      <aside className="flex h-full w-16 flex-col items-center border-r border-border bg-sidebar">
        <div className="flex flex-col items-center gap-1 py-3">
          <button
            type="button"
            onClick={onToggle}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className="group relative grid size-10 place-items-center rounded-xl hover:bg-card/60"
          >
            <Logo className="size-6 group-hover:opacity-0" inverted="fill-sidebar" />
            <PanelLeftOpen className="absolute size-4 text-muted-foreground opacity-0 group-hover:opacity-100" />
          </button>
          {createMenu(
            <span className="grid size-10 place-items-center rounded-xl text-muted-foreground hover:bg-card hover:text-foreground">
              <Plus className="size-4" />
            </span>,
          )}
        </div>
        <nav className="flex flex-col items-center gap-1 border-t border-border py-2">
          {pages.map(({ to, end, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={end} className={railClass} aria-label={label} title={label}>
              <Icon className="size-4" />
            </NavLink>
          ))}
        </nav>
        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto border-t border-border py-2">
          {rows.map(({ bot, status, unread }) => (
            <NavLink
              key={bot.id}
              to={`/app/bots/${bot.id}`}
              className={railClass}
              aria-label={bot.name}
              title={`${bot.name} · ${bot.title}`}
            >
              <AvatarMark avatar={bot.avatar} size={32} status={status} />
              {unread ? <UnreadDot className="absolute top-1 right-1" /> : null}
            </NavLink>
          ))}
          {groupRows.map(({ group, members, unread }) => (
            <NavLink
              key={group.id}
              to={`/app/g/${group.id}`}
              className={railClass}
              aria-label={group.name}
              title={group.name}
            >
              <GroupMark bots={members} size={32} />
              {unread ? <UnreadDot className="absolute top-1 right-1" /> : null}
            </NavLink>
          ))}
        </div>
        <div className="flex flex-col items-center gap-1 border-t border-border py-2">
          <button
            type="button"
            className={railClass({ isActive: false })}
            aria-label="Integrations"
            title="Integrations"
            onClick={() => overlay.set({ integrations: "home" })}
          >
            <Blocks className="size-4" />
          </button>
          {accountMenu(
            <span className="grid size-10 place-items-center rounded-xl hover:bg-card/60" title={me.user.name}>
              <span className="grid size-7 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                {initials(me.user.name)}
              </span>
            </span>,
          )}
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-[300px] max-w-full flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 items-center gap-1 pr-2 pl-4">
        <Logo className="size-6" inverted="fill-sidebar" />
        <span className="ml-1 min-w-0 flex-1 truncate text-sm font-semibold">savin Social</span>
        {createMenu(
          <span className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-card hover:text-foreground">
            <Plus className="size-4" />
          </span>,
        )}
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-card hover:text-foreground"
          >
            <PanelLeftClose className="size-4" />
          </button>
        ) : null}
      </div>
      <div className="px-3">
        <label className="flex h-9 items-center gap-2 rounded-full border border-border bg-card px-3 text-muted-foreground focus-within:border-foreground/40">
          <Search className="size-4" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            aria-label="Search bots"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>
      <nav className="space-y-0.5 px-2 pt-3">
        {pages.map(({ to, end, label, icon: Icon }) => (
          <NavLink key={to} to={to} end={end} className={navClass} onClick={onNavigate}>
            <Icon className="size-4" /> {label}
          </NavLink>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {me.spaces.map((space) => {
          // A search shows every match, folded space or not.
          const folded = !query.trim() && spaces.folded(space.id, space.id === current.id);
          return (
            <div key={space.id}>
              <SpaceHeader
                space={space}
                folded={folded}
                count={space.id === current.id ? state.bots.length + state.groups.length : space.bots.length}
                onFold={() => spaces.set(space.id, !folded)}
                onRename={() => setRenaming(space)}
                onDelete={() => setDeleting(space)}
              />
              {folded ? null : space.id === current.id ? (
                <div className="space-y-0.5">
                  {rows.map(({ bot, status, preview, time, unread }) => (
                    <NavLink
                      key={bot.id}
                      to={`/app/bots/${bot.id}`}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cx(
                          "flex gap-3 rounded-2xl px-3 py-2.5 transition",
                          isActive ? "bg-card shadow-sm" : "hover:bg-card/60",
                        )
                      }
                    >
                      <AvatarMark avatar={bot.avatar} size={38} status={status} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className={cx("truncate text-[13.5px]", unread ? "font-semibold" : "font-medium")}>
                            {bot.name}
                          </span>
                          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{time}</span>
                          {unread ? <UnreadDot /> : null}
                        </span>
                        <span
                          className={cx(
                            "line-clamp-2 text-xs",
                            status === "waiting" ? "text-warning" : "text-muted-foreground",
                          )}
                        >
                          {preview}
                        </span>
                      </span>
                    </NavLink>
                  ))}
                  {groupRows.map(({ group, members, preview, waiting, time, unread }) => (
                    <NavLink
                      key={group.id}
                      to={`/app/g/${group.id}`}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cx(
                          "flex gap-3 rounded-2xl px-3 py-2.5 transition",
                          isActive ? "bg-card shadow-sm" : "hover:bg-card/60",
                        )
                      }
                    >
                      <GroupMark bots={members} size={38} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className={cx("truncate text-[13.5px]", unread ? "font-semibold" : "font-medium")}>
                            {group.name}
                          </span>
                          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{time}</span>
                          {unread ? <UnreadDot /> : null}
                        </span>
                        <span
                          className={cx("line-clamp-2 text-xs", waiting ? "text-warning" : "text-muted-foreground")}
                        >
                          {preview}
                        </span>
                      </span>
                    </NavLink>
                  ))}
                  {state.bots.length ? null : (
                    <button
                      type="button"
                      className="w-full rounded-2xl px-3 py-2 text-left text-xs text-muted-foreground hover:bg-card/60"
                      onClick={() => overlay.set({ create: "bot" })}
                    >
                      Create new Bot
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-0.5">
                  {space.bots
                    .filter((bot) => matches(bot.name, bot.title))
                    .map((bot) => (
                      <button
                        key={bot.id}
                        type="button"
                        onClick={() => open(space.id, `/app/bots/${bot.id}`)}
                        className="flex w-full gap-3 rounded-2xl px-3 py-2 text-left transition hover:bg-card/60"
                      >
                        <AvatarMark avatar={bot.avatar} size={30} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium">{bot.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">{bot.title}</span>
                        </span>
                      </button>
                    ))}
                  {space.bots.length ? null : (
                    <button
                      type="button"
                      className="w-full rounded-2xl px-3 py-2 text-left text-xs text-muted-foreground hover:bg-card/60"
                      onClick={() => open(space.id, "/app")}
                    >
                      Open {space.name}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="space-y-0.5 border-t border-border px-2 py-2">
        <button
          type="button"
          className={navClass({ isActive: false })}
          onClick={() => overlay.set({ integrations: "home" })}
        >
          <Blocks className="size-4" /> Integrations
        </button>
        {accountMenu(
          <span className="flex h-10 w-full items-center gap-2.5 rounded-xl px-2 text-left hover:bg-card/60">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
              {initials(me.user.name)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{me.user.name}</span>
          </span>,
        )}
      </div>
      {renaming ? <RenameSpaceDialog space={renaming} onClose={() => setRenaming(null)} /> : null}
      {deleting ? <DeleteSpaceDialog space={deleting} onClose={() => setDeleting(null)} /> : null}
    </aside>
  );
}

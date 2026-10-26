import type { Edge, EdgeProps, Node, NodeProps } from "@xyflow/react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Handle, Position } from "@xyflow/react";
import { Cron } from "croner";
import { BrainCircuit, Clock, MessageSquare, Plus, ShieldCheck } from "lucide-react";
import type { CSSProperties } from "react";
import type { Bot } from "../../shared/contracts.ts";
import type { BotActivity, GraphEdge, GraphNode, TriggerData } from "../../shared/graph.ts";
import { toolGroups } from "../../shared/ids.ts";
import { appIcons, platformIcon, toolGroupMeta } from "../lib/meta.ts";
import { AvatarMark } from "../shell/avatar.tsx";
import { cx, Spinner } from "../ui.tsx";

type Data<T extends GraphNode["type"]> = Extract<GraphNode, { type: T }>["data"];
export type BotNode = Node<{ botId: string; activity: BotActivity; bot: Bot; model: string }, "bot">;
export type TriggerNode = Node<TriggerData, "trigger">;
export type ModelNode = Node<Data<"model">, "model">;
export type ToolNode = Node<Data<"tool">, "tool">;
export type AppNode = Node<Data<"app">, "app">;
export type PlatformNode = Node<Data<"platform">, "platform">;
export type FlowEdge = Edge<GraphEdge & { color: string }, "flow">;

const card = "rounded-2xl border bg-card shadow-sm transition-colors";
const ring = (selected: boolean) => (selected ? "border-foreground/60 ring-2 ring-foreground/15" : "border-border");
const halo = (color: string) => ({ "--halo": color }) as CSSProperties;

function nextRun(schedule: string) {
  try {
    return (
      new Cron(schedule, { paused: true })
        .nextRun()
        ?.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) ?? null
    );
  } catch {
    return null;
  }
}

export function TriggerNodeView({ data, selected }: NodeProps<TriggerNode>) {
  const Icon = data.kind === "chat" ? MessageSquare : data.kind === "routine" ? Clock : Plus;
  const detail = data.kind === "routine" ? (data.active && data.schedule ? nextRun(data.schedule) : "Paused") : null;
  return (
    <div
      className={cx(
        "flex w-48 items-center gap-2.5 rounded-l-[26px] rounded-r-2xl border bg-card py-2 pr-3 pl-2 shadow-sm",
        data.kind === "add" ? "border-dashed border-input text-muted-foreground shadow-none" : ring(selected),
        data.kind === "routine" && !data.active && "opacity-60",
        data.live && "node-live",
      )}
      style={halo("var(--foreground)")}
    >
      <span
        className={cx(
          "grid size-9 shrink-0 place-items-center rounded-full",
          data.kind === "add" ? "border border-dashed border-input" : "bg-muted",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium">{data.label}</span>
        {detail ? <span className="block truncate text-[11px] text-muted-foreground">{detail}</span> : null}
      </span>
      {data.kind === "add" ? null : <Handle type="source" position={Position.Right} />}
    </div>
  );
}

export function BotNodeView({ data, selected }: NodeProps<BotNode>) {
  const { bot, activity } = data;
  const color = bot.avatar.color;
  const busy = activity.using.find((group) => group in toolGroupMeta) as keyof typeof toolGroupMeta | undefined;
  const status = activity.gated.length
    ? "Needs you"
    : busy
      ? `${toolGroupMeta[busy].label}…`
      : activity.using.length
        ? "Working…"
        : activity.thinking
          ? "Thinking…"
          : null;
  return (
    <div
      className={cx(card, ring(selected), "w-60 p-3", activity.active && "node-live")}
      style={halo(activity.gated.length ? "var(--warning)" : color)}
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Bottom} id="model" />
      <div className="flex items-center gap-2.5">
        <AvatarMark avatar={bot.avatar} size={36} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{bot.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{bot.title}</span>
        </span>
      </div>
      <div className="mt-2.5 flex items-center gap-1">
        {bot.computerAccess === "off"
          ? null
          : toolGroups
              .filter((group) => bot.tools[group])
              .map((group) => {
                const Icon = toolGroupMeta[group].icon;
                const using = activity.using.includes(group);
                return (
                  <span
                    key={group}
                    title={`${toolGroupMeta[group].label} · ${bot.computerAccess === "ask" ? "asks first" : "full access"}`}
                    className={cx(
                      "grid size-6 place-items-center rounded-md border",
                      bot.computerAccess === "ask" ? "border-dashed border-input" : "border-transparent bg-muted",
                      using && "text-white",
                    )}
                    style={using ? { background: color, borderColor: color } : undefined}
                  >
                    <Icon className="size-3.5" />
                  </span>
                );
              })}
        {status ? (
          <span
            className={cx(
              "ml-auto flex shrink-0 items-center gap-1 text-[11px] font-medium",
              activity.gated.length ? "text-warning" : "text-muted-foreground",
            )}
          >
            {activity.gated.length ? null : <Spinner className="size-3" />}
            {status}
          </span>
        ) : (
          <span className="ml-auto max-w-28 truncate font-mono text-[10px] text-muted-foreground">{data.model}</span>
        )}
      </div>
    </div>
  );
}

export function ModelNodeView({ data, selected }: NodeProps<ModelNode>) {
  return (
    <div className="flex w-40 flex-col items-center gap-1.5">
      <span
        className={cx(card, ring(selected), "grid size-14 place-items-center rounded-full", data.active && "node-live")}
        style={halo("var(--foreground)")}
      >
        <BrainCircuit className="size-6" />
        <Handle type="source" position={Position.Top} />
      </span>
      <span className="max-w-full truncate text-center text-xs font-medium">{data.label}</span>
      <span className="-mt-1 max-w-full truncate text-center text-[11px] text-muted-foreground">{data.detail}</span>
    </div>
  );
}

export function ToolNodeView({ data, selected }: NodeProps<ToolNode>) {
  const meta = toolGroupMeta[data.group];
  const Icon = meta.icon;
  return (
    <div
      className={cx(
        card,
        ring(selected),
        "flex w-52 items-center gap-2.5 p-3",
        !data.available && "opacity-50",
        data.active && "node-live",
      )}
      style={halo("var(--foreground)")}
    >
      <Handle type="target" position={Position.Left} />
      {data.group === "browser" ? <Handle type="source" position={Position.Right} /> : null}
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
        <Icon className="size-[18px]" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{meta.label}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {data.available ? data.detail : "Unavailable"}
        </span>
      </span>
    </div>
  );
}

export function AppNodeView({ data, selected }: NodeProps<AppNode>) {
  const Icon = appIcons[data.icon] ?? appIcons.mcp;
  const healthy = data.status === "connected";
  return (
    <div
      className={cx(
        card,
        ring(selected),
        "flex w-48 items-center gap-2 rounded-full px-3 py-2",
        data.active && "node-live",
      )}
      style={halo("var(--foreground)")}
    >
      <Handle type="target" position={Position.Left} />
      {Icon ? <Icon className="size-4 shrink-0" /> : null}
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{data.label}</span>
      <span
        className={cx(
          "size-2 shrink-0 rounded-full",
          healthy ? "bg-success" : data.status === "connecting" ? "bg-muted-foreground" : "bg-warning",
        )}
      />
    </div>
  );
}

export function PlatformNodeView({ data, selected }: NodeProps<PlatformNode>) {
  const Icon = platformIcon[data.platform];
  return (
    <div
      className={cx(
        card,
        ring(selected),
        "flex w-48 items-center gap-2 rounded-full px-3 py-2 shadow-none",
        !data.signedIn && "border-dashed",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <Icon className={cx("size-4", data.signedIn ? "text-foreground" : "text-muted-foreground")} />
      <span className={cx("min-w-0 flex-1 truncate text-[13px]", !data.signedIn && "text-muted-foreground")}>
        {data.name}
      </span>
      {data.signedIn ? <span className="shrink-0 text-[10px] text-success">Signed in</span> : null}
    </div>
  );
}

export function FlowEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<FlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  if (!data) return null;
  const off = data.mode === "off";
  const stroke = data.waiting ? "var(--warning)" : data.active ? data.color : "var(--edge)";
  const style: CSSProperties = {
    stroke,
    strokeWidth: data.active || data.waiting ? 2.25 : 1.5,
    opacity: off ? 0.25 : data.kind === "model" && !data.active ? 0.35 : 1,
    strokeDasharray: data.active
      ? undefined
      : off || data.kind === "model" || data.kind === "platform"
        ? "3 5"
        : undefined,
  };
  return (
    <>
      <BaseEdge id={id} path={path} style={style} className={data.active || data.waiting ? "edge-live" : undefined} />
      {data.mode === "ask" ? (
        <EdgeLabelRenderer>
          <span
            title={data.waiting ? "Waiting for you" : "Asks first"}
            className={cx(
              "nodrag nopan pointer-events-auto absolute grid size-5 place-items-center rounded-full border bg-card",
              data.waiting ? "border-warning text-warning" : "border-border text-muted-foreground",
            )}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <ShieldCheck className="size-3" />
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const nodeTypes = {
  trigger: TriggerNodeView,
  bot: BotNodeView,
  model: ModelNodeView,
  tool: ToolNodeView,
  app: AppNodeView,
  platform: PlatformNodeView,
};

export const edgeTypes = { flow: FlowEdgeView };

import { ArrowLeft, Check, ChevronDown, Globe, Plug, Search, Upload, X } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  BotId,
  CatalogItem,
  ConnectionView,
  McpServerInput,
  McpServerView,
  PlatformId,
} from "../../shared/contracts.ts";
import { platformIds } from "../../shared/ids.ts";
import { platforms } from "../../shared/roster.ts";
import { api } from "../lib/api.ts";
import { useAppState } from "../lib/live.tsx";
import { ago, appIcons, toolLabel } from "../lib/meta.ts";
import { useOverlay } from "../lib/overlay.ts";
import { AvatarMark } from "../shell/avatar.tsx";
import { Button, cx, Dialog, DialogClose, ErrorText, Field, Input, Select, Spinner, Tabs, Textarea } from "../ui.tsx";

function AppIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = appIcons[icon] ?? Plug;
  return (
    <span className={cx("grid shrink-0 place-items-center rounded-xl bg-muted", className ?? "size-10")}>
      <Icon className="size-5" />
    </span>
  );
}

/** Which bots may use a connection, as toggle chips. */
function Agents({ value, onChange }: { value: BotId[]; onChange: (agents: BotId[]) => void }) {
  const state = useAppState();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs text-muted-foreground">Agents:</span>
      {state.bots.map((bot) => {
        const on = value.includes(bot.id);
        return (
          <button
            key={bot.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((id) => id !== bot.id) : [...value, bot.id])}
            className={cx(
              "inline-flex h-7 items-center gap-1.5 rounded-full border pr-2.5 pl-1 text-xs transition",
              on
                ? "border-foreground/40 bg-muted font-medium"
                : "border-border text-muted-foreground opacity-70 hover:opacity-100",
            )}
          >
            <AvatarMark avatar={bot.avatar} size={20} />
            {bot.name}
          </button>
        );
      })}
    </div>
  );
}

function ToolList({ tools }: { tools: { name: string; description: string; readOnly: boolean }[] }) {
  return (
    <details className="group rounded-xl border border-border">
      <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-[13px] font-medium">
        {tools.length} tools
        <ChevronDown className="size-4 text-muted-foreground transition group-open:rotate-180" />
      </summary>
      <ul className="space-y-1 border-t border-border px-3 py-2">
        {tools.length ? null : <li className="text-xs text-muted-foreground">No tools available.</li>}
        {tools.map((tool) => (
          <li key={tool.name} className="flex items-start gap-2 py-1 text-[13px]">
            <span className="min-w-0 flex-1">
              <span className="block">{toolLabel(tool.name)}</span>
              <span className="block text-xs text-muted-foreground">{tool.description}</span>
            </span>
            <span
              className={cx(
                "shrink-0 rounded-full px-2 py-0.5 text-[10px]",
                tool.readOnly ? "bg-muted text-muted-foreground" : "bg-warning/15 text-warning",
              )}
            >
              {tool.readOnly ? "Reads" : "Changes"}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ConnectForm({ item, onDone, onCancel }: { item: CatalogItem; onDone: () => void; onCancel?: () => void }) {
  const state = useAppState();
  const overlay = useOverlay();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [agents, setAgents] = useState<BotId[]>(() => state.bots.map((bot) => bot.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (item.auth.kind === "google") {
        await signInWithGoogle({ connectorId: item.id, agents });
      } else {
        await api("POST", "/connections", { connectorId: item.id, fields, agents });
      }
      onDone();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 rounded-2xl border border-border p-4">
      {item.auth.kind === "google" ? (
        state.google.configured ? (
          <p className="text-[13px] text-muted-foreground">Sign in with the Google account that owns the channel.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-[13px] text-muted-foreground">Google sign-in isn’t set up yet.</p>
            <Button onClick={() => overlay.set({ integrations: null, settings: "general" })}>
              Set up Google sign-in
            </Button>
          </div>
        )
      ) : (
        item.auth.fields.map((spec) =>
          spec.options ? (
            <Field key={spec.key} label={spec.label}>
              <Select
                value={fields[spec.key] ?? spec.options[0]}
                onChange={(event) => setFields({ ...fields, [spec.key]: event.target.value })}
              >
                {spec.options.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field key={spec.key} label={spec.optional ? `${spec.label} (optional)` : spec.label}>
              <Input
                type={spec.secret ? "password" : "text"}
                autoComplete="off"
                placeholder={spec.placeholder}
                value={fields[spec.key] ?? ""}
                onChange={(event) => setFields({ ...fields, [spec.key]: event.target.value })}
              />
            </Field>
          ),
        )
      )}
      <Agents value={agents} onChange={setAgents} />
      <p className="text-xs text-muted-foreground">Credentials are encrypted and never sent to the model.</p>
      <ErrorText error={error} />
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          variant="primary"
          busy={busy}
          disabled={
            item.auth.kind === "google"
              ? !state.google.configured
              : item.auth.fields.some((spec) => !spec.optional && !spec.options && !fields[spec.key]?.trim())
          }
          onClick={() => void submit()}
        >
          {item.auth.kind === "google" ? "Sign in with Google" : "Verify and add"}
        </Button>
      </div>
    </div>
  );
}

/** Opens Google's sign-in in a popup; the popup opens on the click itself so no blocker stops it. */
async function signInWithGoogle(body: { connectorId: string; agents: BotId[]; reconnectId?: string }) {
  const popup = window.open("about:blank", "savin-google", "width=520,height=680");
  try {
    const { url } = await api<{ url: string }>("POST", "/connections/google", body);
    if (popup) popup.location.href = url;
    else window.location.href = url;
  } catch (failure) {
    popup?.close();
    throw failure;
  }
}

function Account({ connection, item }: { connection: ConnectionView; item: CatalogItem }) {
  const [label, setLabel] = useState(connection.label);
  const [error, setError] = useState<string | null>(null);
  const status =
    connection.status === "connected"
      ? null
      : connection.status === "pending"
        ? "Waiting for Google sign-in…"
        : connection.status === "reconnect"
          ? "Needs reconnecting"
          : (connection.error ?? "Error");
  const retry = () =>
    void signInWithGoogle({ connectorId: item.id, agents: connection.agents, reconnectId: connection.id }).catch(
      (failure: Error) => setError(failure.message),
    );
  return (
    <div className="space-y-3 rounded-2xl border border-border p-4">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Account label"
          className="h-8 max-w-56 border-transparent px-1 font-medium hover:border-border"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          onBlur={() =>
            label.trim() && label !== connection.label && void api("PATCH", `/connections/${connection.id}`, { label })
          }
        />
        <span className="truncate text-xs text-muted-foreground">{connection.account}</span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => void api("DELETE", `/connections/${connection.id}`)}
        >
          Remove
        </Button>
      </div>
      {status ? (
        <p className={cx("text-xs", connection.status === "pending" ? "text-muted-foreground" : "text-destructive")}>
          {status}
          {item.auth.kind === "google" ? (
            <button type="button" className="ml-2 font-medium text-foreground underline" onClick={retry}>
              {connection.status === "pending" ? "Open sign-in again" : "Try again"}
            </button>
          ) : null}
        </p>
      ) : null}
      <ErrorText error={error} />
      <Agents
        value={connection.agents}
        onChange={(agents) => void api("PATCH", `/connections/${connection.id}`, { agents })}
      />
      {connection.activity.length ? (
        <ul className="space-y-1 border-t border-border pt-2">
          {connection.activity.slice(0, 6).map((entry) => (
            <li key={`${entry.at}${entry.tool}`} className="flex items-center gap-2 text-xs">
              <span>{toolLabel(entry.tool)}</span>
              <span className={entry.ok ? "text-muted-foreground" : "text-destructive"}>
                {entry.ok ? "" : "Failed"}
              </span>
              <span className="ml-auto text-muted-foreground">{ago(entry.at)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The other way bots reach a platform: the shared browser, signed in like a person. A signed-in
 * browser works on its own, so this shows whether it is, next to the app's own accounts.
 */
function BrowserSession({ platform }: { platform: PlatformId }) {
  const state = useAppState();
  const overlay = useOverlay();
  const { name } = platforms[platform];
  const signedIn = state.browserSignIns.includes(platform);
  const helper = state.bots.find((bot) => bot.computerAccess !== "off" && bot.tools.browser);
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border px-4 py-3">
      <Globe className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-[13px]">
        {signedIn ? `The bots' browser is signed in to ${name}.` : `The bots' browser isn't signed in to ${name}.`}
      </p>
      {signedIn ? (
        <Check className="size-4 shrink-0 text-success" aria-label="Signed in" />
      ) : (
        <Button
          size="sm"
          onClick={() => {
            void api("POST", "/browser/open", { platforms: [platform] });
            if (helper) overlay.set({ integrations: null, computer: helper.id, window: null });
          }}
        >
          Sign in there
        </Button>
      )}
    </div>
  );
}

/** The one channel every YouTube upload goes to, chosen once from the channel the bots' browser opens on. */
function UploadChannel() {
  const { channel } = useAppState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detect = () => {
    setBusy(true);
    setError(null);
    void api("POST", "/channel/detect")
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="space-y-2 rounded-2xl border border-border px-4 py-3">
      <div className="flex items-center gap-3">
        <Upload className="size-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-[13px]">
          {channel ? (
            <>
              Uploads go only to{" "}
              <a
                href={`https://www.youtube.com/channel/${channel.id}`}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline underline-offset-2"
              >
                {channel.title}
              </a>
            </>
          ) : (
            "Choose the one channel uploads go to."
          )}
        </p>
        {channel ? (
          <Button size="sm" variant="ghost" onClick={() => void api("DELETE", "/channel")}>
            Change
          </Button>
        ) : (
          <Button size="sm" busy={busy} onClick={detect}>
            Use the browser's channel
          </Button>
        )}
      </div>
      <ErrorText error={error} />
    </div>
  );
}

function AppDetail({ item, back }: { item: CatalogItem; back: () => void }) {
  const state = useAppState();
  const accounts = state.connections.filter((connection) => connection.connectorId === item.id);
  const [adding, setAdding] = useState(accounts.length === 0);
  const [confirm, setConfirm] = useState(false);
  const platform = (platformIds as readonly string[]).includes(item.id) ? (item.id as PlatformId) : null;
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" aria-label="Back" onClick={back}>
          <ArrowLeft className="size-4" />
        </Button>
        <AppIcon icon={item.icon} />
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold">{item.name}</span>
          <span className="block text-xs text-muted-foreground">{item.description}</span>
        </span>
        {accounts.length ? (
          confirm ? (
            <Button variant="danger" onClick={() => void api("DELETE", `/integrations/${item.id}`).then(back)}>
              Uninstall all
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setConfirm(true)}>
              Uninstall
            </Button>
          )
        ) : null}
      </div>
      {item.id === "youtube" ? <UploadChannel /> : null}
      {platform ? <BrowserSession platform={platform} /> : null}
      {accounts.map((connection) => (
        <Account key={connection.id} connection={connection} item={item} />
      ))}
      {adding ? (
        <ConnectForm
          item={item}
          onDone={() => setAdding(false)}
          onCancel={accounts.length ? () => setAdding(false) : undefined}
        />
      ) : (
        <Button onClick={() => setAdding(true)}>Add another</Button>
      )}
      <ToolList tools={accounts[0]?.tools ?? item.tools} />
      {item.docsUrl ? (
        <a
          href={item.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Where to get credentials
        </a>
      ) : null}
    </div>
  );
}

// ---------- MCP servers ----------

function McpServer({ server }: { server: McpServerView }) {
  const [confirm, setConfirm] = useState(false);
  const status =
    server.status === "connected"
      ? `${server.tools.length} tools`
      : server.status === "connecting"
        ? "Connecting…"
        : (server.error ?? "Error");
  return (
    <div className="space-y-3 rounded-2xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-semibold">{server.name}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase">{server.transport}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {server.url ?? [server.command, ...server.args].join(" ")}
        </span>
        {server.hasSecret ? <span className="text-xs text-muted-foreground">credential saved</span> : null}
      </div>
      <p
        className={cx(
          "flex items-center gap-1.5 text-xs",
          server.status === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {server.status === "connecting" ? <Spinner className="size-3" /> : null}
        {status}
      </p>
      <Agents value={server.agents} onChange={(agents) => void api("PUT", `/mcp-servers/${server.id}`, { agents })} />
      {server.tools.length ? <ToolList tools={server.tools} /> : null}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void api("POST", `/mcp-servers/${server.id}/reconnect`)}>
          Reconnect
        </Button>
        {confirm ? (
          <Button size="sm" variant="danger" onClick={() => void api("DELETE", `/mcp-servers/${server.id}`)}>
            Confirm delete
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}

function AddMcpServer({ onDone }: { onDone: () => void }) {
  const state = useAppState();
  const [form, setForm] = useState<McpServerInput>(() => ({
    name: "",
    transport: "http",
    agents: state.bots.map((bot) => bot.id),
  }));
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const environment = Object.fromEntries(
        env
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]),
      );
      await api("POST", "/mcp-servers", {
        ...form,
        ...(form.transport === "stdio"
          ? { args: args.split(/\s+/).filter(Boolean), env: environment, url: undefined }
          : { command: undefined }),
      });
      onDone();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4 rounded-2xl border border-border p-4">
      <Field label="Server name">
        <Input
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          placeholder="YouTube tools"
        />
      </Field>
      <Tabs
        value={form.transport}
        onChange={(transport) => setForm({ ...form, transport })}
        options={[
          { value: "http", label: "HTTP" },
          { value: "sse", label: "SSE" },
          { value: "stdio", label: "STDIO" },
        ]}
      />
      {form.transport === "stdio" ? (
        <>
          <Field label="Command">
            <Input
              className="font-mono"
              value={form.command ?? ""}
              placeholder="npx"
              onChange={(event) => setForm({ ...form, command: event.target.value })}
            />
          </Field>
          <Field label="Arguments">
            <Input
              className="font-mono"
              value={args}
              placeholder="-y @scope/mcp-server"
              onChange={(event) => setArgs(event.target.value)}
            />
          </Field>
          <Field label="Environment (KEY=value per line, stored encrypted)">
            <Textarea
              rows={3}
              className="font-mono text-xs"
              value={env}
              onChange={(event) => setEnv(event.target.value)}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="Server URL">
            <Input
              className="font-mono"
              value={form.url ?? ""}
              placeholder="https://host/mcp"
              onChange={(event) => setForm({ ...form, url: event.target.value })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Header name">
              <Input
                value={form.headerName ?? ""}
                placeholder="Authorization"
                onChange={(event) => setForm({ ...form, headerName: event.target.value })}
              />
            </Field>
            <Field label="Access token (optional)">
              <Input
                type="password"
                autoComplete="off"
                placeholder="Stored encrypted"
                value={form.headerValue ?? ""}
                onChange={(event) => setForm({ ...form, headerValue: event.target.value })}
              />
            </Field>
          </div>
        </>
      )}
      <Agents value={form.agents} onChange={(agents) => setForm({ ...form, agents })} />
      <ErrorText error={error} />
      <div className="flex justify-end">
        <Button
          variant="primary"
          busy={busy}
          disabled={!form.name.trim() || (form.transport === "stdio" ? !form.command?.trim() : !form.url?.trim())}
          onClick={() => void submit()}
        >
          Add server
        </Button>
      </div>
    </div>
  );
}

function McpServers({ back }: { back: () => void }) {
  const state = useAppState();
  const [adding, setAdding] = useState(state.mcpServers.length === 0);
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" aria-label="Back" onClick={back}>
          <ArrowLeft className="size-4" />
        </Button>
        <AppIcon icon="mcp" />
        <span className="flex-1 text-[15px] font-semibold">MCP servers</span>
        {adding ? null : <Button onClick={() => setAdding(true)}>Add server</Button>}
      </div>
      {adding ? <AddMcpServer onDone={() => setAdding(false)} /> : null}
      {state.mcpServers.map((server) => (
        <McpServer key={server.id} server={server} />
      ))}
    </div>
  );
}

// ---------- Catalog ----------

export function IntegrationsDialog({ view }: { view: string }) {
  const state = useAppState();
  const overlay = useOverlay();
  const [catalog, setCatalog] = useState<CatalogItem[] | null>(null);
  const [query, setQuery] = useState("");
  const close = () => overlay.set({ integrations: null });
  const go = (next: string) => overlay.set({ integrations: next });

  useEffect(() => {
    void api<CatalogItem[]>("GET", "/integrations/catalog").then(setCatalog);
  }, []);

  /**
   * An app's state across its accounts: one working account is enough to count as connected, and a
   * bots' browser signed in to the platform works too, whatever happened to an app sign-in.
   */
  const statusOf = (connectorId: string) => {
    const mine = state.connections.filter((connection) => connection.connectorId === connectorId);
    if (mine.some((connection) => connection.status === "connected")) return "Connected";
    if (state.browserSignIns.includes(connectorId as PlatformId)) return "Signed in";
    if (!mine.length) return null;
    if (mine.some((connection) => connection.status === "pending")) return "Signing in…";
    return "Needs attention";
  };
  const matches = (catalog ?? []).filter((item) =>
    `${item.name} ${item.description} ${item.category}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const detail = catalog?.find((item) => item.id === view);

  const tile = (item: CatalogItem) => {
    const status = statusOf(item.id);
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => go(item.id)}
        className="flex items-center gap-3 rounded-2xl border border-border p-3 text-left transition hover:bg-muted/50"
      >
        <AppIcon icon={item.icon} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold">{item.name}</span>
          <span className="line-clamp-2 block text-xs text-muted-foreground">{item.description}</span>
        </span>
        <span
          className={cx(
            "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium",
            status === null
              ? "bg-primary text-primary-foreground"
              : status === "Needs attention"
                ? "bg-warning/15 text-warning"
                : "bg-muted text-muted-foreground",
          )}
        >
          {status ?? "Add"}
        </span>
      </button>
    );
  };

  return (
    <Dialog title="Integrations" onClose={close} wide>
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
        <h2 className="text-[15px] font-semibold">Integrations</h2>
        <DialogClose onClose={close} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {catalog === null ? (
          <Spinner className="mx-auto size-5" />
        ) : view === "mcp" ? (
          <McpServers back={() => go("home")} />
        ) : detail ? (
          <AppDetail key={detail.id} item={detail} back={() => go("home")} />
        ) : (
          <div className="space-y-6">
            <label className="flex h-10 items-center gap-2 rounded-full border border-border px-4 text-muted-foreground focus-within:border-foreground/40">
              <Search className="size-4" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search apps"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none"
              />
              {query ? (
                <button type="button" aria-label="Clear" onClick={() => setQuery("")}>
                  <X className="size-4" />
                </button>
              ) : null}
            </label>
            {query ? null : (
              <section className="space-y-2">
                <h3 className="text-xs font-semibold text-muted-foreground">Featured</h3>
                <div className="grid gap-2 sm:grid-cols-2">{catalog.filter((item) => item.featured).map(tile)}</div>
              </section>
            )}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground">{query ? "Results" : "All apps"}</h3>
              {matches.length ? (
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{matches.map(tile)}</div>
              ) : (
                <p className="text-[13px] text-muted-foreground">No apps match your search.</p>
              )}
            </section>
            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground">MCP servers</h3>
              <button
                type="button"
                onClick={() => go("mcp")}
                className="flex w-full items-center gap-3 rounded-2xl border border-border p-3 text-left transition hover:bg-muted/50"
              >
                <AppIcon icon="mcp" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold">Manage MCP servers</span>
                  <span className="block text-xs text-muted-foreground">
                    {state.mcpServers.length
                      ? `${state.mcpServers.length} configured`
                      : "Connect any MCP server over HTTP, SSE or a local command"}
                  </span>
                </span>
              </button>
            </section>
          </div>
        )}
      </div>
    </Dialog>
  );
}

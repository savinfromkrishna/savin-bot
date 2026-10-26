import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BotId, ConnectionInput, ConnectionView, McpServerInput, McpServerView } from "../../shared/contracts.ts";
import type { ConnectionRecord, McpServerRecord, Store } from "../store.ts";
import type { Tool } from "../tools/tool.ts";
import type { GoogleClient, GoogleGrant } from "./auth.ts";
import { freshGoogleGrant, googleAuthorization, googleExchange } from "./auth.ts";
import type { ConnectorContext } from "./connectors.ts";
import { catalog, connectorFor } from "./connectors.ts";
import type { McpSecret, McpServers } from "./mcp.ts";

export class IntegrationError extends Error {}

type GoogleSecret = { grant: GoogleGrant };

const SIGN_IN_MINUTES = 15;

/** Google's own wording, turned into what to do about it. */
function googleProblem(message: string, redirectUri: string) {
  if (/has not been used in project|SERVICE_DISABLED|accessNotConfigured/i.test(message)) {
    return "Turn on the YouTube Data API v3 in your Google Cloud project, then reconnect.";
  }
  if (/invalid_client|unauthorized_client/i.test(message)) {
    return "Google didn't accept the client ID or secret. Check them in Settings → General.";
  }
  if (/redirect_uri_mismatch/i.test(message))
    return `Add ${redirectUri} to the OAuth client's authorized redirect URIs.`;
  if (/invalid_grant/i.test(message)) return "That sign-in was already used or expired.";
  return message;
}

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24) || "server";

/** Connections to apps and MCP servers, and the tools they give each bot. */
export class Integrations {
  constructor(
    private readonly deps: {
      store: Store;
      mcp: McpServers;
      redirectUri: string;
      onChange: () => void;
      /** The owner's Google OAuth client, with its secret sealed. */
      google: () => { clientId: string | null; clientSecret: string | null };
    },
  ) {}

  catalog = catalog;

  private get secrets() {
    return this.deps.store.secrets;
  }

  googleClient(): GoogleClient | null {
    const { clientId, clientSecret } = this.deps.google();
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret: this.secrets.open<string>(clientSecret), redirectUri: this.deps.redirectUri };
  }

  /** Whether a Google sign-in callback belongs to this space. */
  owns(state: string) {
    return this.deps.store.state.connections.some((record) => record.pending?.state === state);
  }

  /** "telegram", "telegram_2", ...: tool prefixes stay unique when one app has several accounts. */
  private prefixOf(record: ConnectionRecord) {
    const same = this.deps.store.state.connections
      .filter((other) => other.connectorId === record.connectorId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const index = same.findIndex((other) => other.id === record.id);
    return `${record.connectorId.replace(/-/g, "_")}${index > 0 ? `_${index + 1}` : ""}`;
  }

  views(): ConnectionView[] {
    return this.deps.store.state.connections.map((record) => {
      const definition = connectorFor(record.connectorId);
      const prefix = this.prefixOf(record);
      // A sign-in nobody finished must not look like it is still on its way.
      const stalled = record.status === "pending" && (!record.pending || record.pending.expires < Date.now());
      return {
        id: record.id,
        connectorId: record.connectorId,
        label: record.label,
        account: record.account,
        status: stalled ? "error" : record.status,
        error: stalled ? "Sign-in didn't finish." : record.error,
        createdAt: record.createdAt,
        agents: record.agents,
        tools: (definition?.tools ?? []).map((entry) => ({
          name: `${prefix}_${entry.action}`,
          description: entry.description,
          readOnly: Boolean(entry.readOnly),
        })),
        activity: record.activity,
      };
    });
  }

  mcpViews(): McpServerView[] {
    return this.deps.store.state.mcpServers.map((record) => ({
      id: record.id,
      name: record.name,
      slug: record.slug,
      transport: record.transport,
      url: record.url,
      command: record.command,
      args: record.args,
      headerName: record.headerName,
      hasSecret: Boolean(record.secret),
      envKeys: record.envKeys,
      agents: record.agents,
      ...this.deps.mcp.view(record.id),
    }));
  }

  private nextLabel(connectorId: string, name: string) {
    const count = this.deps.store.state.connections.filter((record) => record.connectorId === connectorId).length;
    return count ? `${name} ${count + 1}` : name;
  }

  private async save(record: ConnectionRecord) {
    await this.deps.store.update((state) => ({
      ...state,
      connections: state.connections.some((other) => other.id === record.id)
        ? state.connections.map((other) => (other.id === record.id ? record : other))
        : [...state.connections, record],
    }));
    this.deps.onChange();
  }

  /** Verifies credentials with the app, then stores them encrypted. */
  async connect(input: ConnectionInput): Promise<ConnectionView> {
    const definition = connectorFor(input.connectorId);
    if (definition?.item.auth.kind !== "fields") throw new IntegrationError("Unknown app");
    const fields: Record<string, string> = {};
    for (const spec of definition.item.auth.fields) {
      const value = input.fields[spec.key]?.trim() ?? "";
      if (!value && !spec.optional) throw new IntegrationError(`${spec.label} is required`);
      if (value) fields[spec.key] = value;
    }
    let verified: { account: string | null; store?: Record<string, string> };
    try {
      verified = await definition.verify({ fields });
    } catch (error) {
      throw new IntegrationError(error instanceof Error ? error.message : String(error));
    }
    const record: ConnectionRecord = {
      id: randomUUID(),
      connectorId: definition.item.id,
      label: input.label || this.nextLabel(definition.item.id, definition.item.name),
      account: verified.account,
      status: "connected",
      error: null,
      createdAt: new Date().toISOString(),
      agents: input.agents,
      secret: this.secrets.seal({ ...fields, ...verified.store }),
      activity: [],
    };
    await this.save(record);
    return this.views().find((view) => view.id === record.id) as ConnectionView;
  }

  /** Starts Google sign-in; the person finishes it in a popup and the callback completes it. */
  async beginGoogle(connectorId: string, agents: BotId[], reconnectId?: string) {
    const definition = connectorFor(connectorId);
    if (definition?.item.auth.kind !== "google") throw new IntegrationError("Unknown app");
    const client = this.googleClient();
    if (!client) throw new IntegrationError("Set up Google sign-in in Settings → General first");
    const existing = reconnectId
      ? this.deps.store.state.connections.find((record) => record.id === reconnectId)
      : undefined;
    const authorization = googleAuthorization(client, definition.item.auth.scopes);
    // Kept with the connection, sealed, so the callback still finds it after a restart.
    const pending = {
      state: authorization.state,
      verifier: this.secrets.seal(authorization.verifier),
      expires: Date.now() + SIGN_IN_MINUTES * 60_000,
    };
    const record: ConnectionRecord = existing
      ? { ...existing, status: existing.status === "connected" ? "connected" : "pending", error: null, pending }
      : {
          id: randomUUID(),
          connectorId,
          label: this.nextLabel(connectorId, definition.item.name),
          account: null,
          status: "pending",
          error: null,
          createdAt: new Date().toISOString(),
          agents,
          secret: this.secrets.seal({}),
          activity: [],
          pending,
        };
    await this.save(record);
    return { url: authorization.url, connectionId: record.id };
  }

  /** Google's redirect back: the code becomes a grant, and the account is checked before it counts. */
  async completeGoogle(state: string, code: string | null, denied: string | null) {
    const record = state
      ? this.deps.store.state.connections.find((other) => other.pending?.state === state)
      : undefined;
    if (!record?.pending) throw new IntegrationError("This sign-in link expired. Start again.");
    const { pending } = record;
    const fail = async (message: string): Promise<never> => {
      // A connection that already worked keeps working; only its retry failed.
      const current = this.deps.store.state.connections.find((other) => other.id === record.id) ?? record;
      await this.save({
        ...current,
        pending: null,
        ...(current.status === "connected" ? {} : { status: "error" as const, error: message }),
      });
      throw new IntegrationError(message);
    };
    if (pending.expires < Date.now()) return fail("The sign-in took too long.");
    if (denied) {
      return fail(
        denied === "access_denied"
          ? "Google sign-in was cancelled. If Google said the app isn't verified, add your Google account as a test user on the OAuth consent screen, then try again."
          : `Google stopped the sign-in: ${denied}`,
      );
    }
    const client = this.googleClient();
    if (!client) return fail("Set up Google sign-in in Settings → General first");
    if (!code) return fail("Google did not return a code.");
    try {
      const grant = await googleExchange(client, code, this.secrets.open<string>(pending.verifier));
      const definition = connectorFor(record.connectorId);
      const verified = await definition?.verify({ fields: {}, googleToken: async () => grant.accessToken });
      await this.save({
        ...record,
        status: "connected",
        error: null,
        pending: null,
        account: verified?.account ?? record.account,
        secret: this.secrets.seal({ grant } satisfies GoogleSecret),
      });
      // The first channel connected becomes the one uploads go to; it changes only when a person changes it.
      const channel = verified?.channel;
      if (channel?.id && !this.deps.store.state.channel) {
        await this.deps.store.update((state) => ({ ...state, channel }));
      }
      return verified?.account ?? record.label;
    } catch (error) {
      return fail(googleProblem(error instanceof Error ? error.message : String(error), client.redirectUri));
    }
  }

  async update(id: string, change: { label?: string; agents?: BotId[] }) {
    const record = this.deps.store.state.connections.find((other) => other.id === id);
    if (!record) throw new IntegrationError("Not found");
    await this.save({
      ...record,
      ...(change.label?.trim() && { label: change.label.trim() }),
      ...(change.agents && { agents: change.agents }),
    });
  }

  async remove(id: string) {
    await this.deps.store.update((state) => ({
      ...state,
      connections: state.connections.filter((record) => record.id !== id),
    }));
    this.deps.onChange();
  }

  /** Removes every account of an app ("Uninstall"). */
  async uninstall(connectorId: string) {
    await this.deps.store.update((state) => ({
      ...state,
      connections: state.connections.filter((record) => record.connectorId !== connectorId),
    }));
    this.deps.onChange();
  }

  private async record(id: string, tool: string, ok: boolean, detail: string | null) {
    const record = this.deps.store.state.connections.find((other) => other.id === id);
    if (!record) return;
    const activity = [
      { at: new Date().toISOString(), tool, ok, detail: detail?.slice(0, 200) ?? null },
      ...record.activity,
    ].slice(0, 20);
    await this.save({
      ...record,
      activity,
      ...(!ok && /401|403|expired|reconnect/i.test(detail ?? "") && { status: "reconnect" }),
    });
  }

  /** A Google access token for a connection, refreshed and saved when it has expired. */
  private googleToken(record: ConnectionRecord) {
    return async () => {
      const client = this.googleClient();
      if (!client) throw new Error("Google sign-in is not set up");
      const current = this.deps.store.state.connections.find((other) => other.id === record.id) ?? record;
      const { grant } = this.secrets.open<GoogleSecret>(current.secret);
      const fresh = await freshGoogleGrant(client, grant);
      if (fresh.changed) await this.save({ ...current, secret: this.secrets.seal({ grant: fresh.grant }) });
      return fresh.grant.accessToken;
    };
  }

  // ---------- MCP servers ----------

  async addMcpServer(input: McpServerInput) {
    const record = this.mcpRecord(input, {
      id: randomUUID(),
      slug: this.uniqueSlug(input.name),
      secret: null,
      envKeys: [],
    });
    await this.saveMcp(record);
    return record.id;
  }

  async updateMcpServer(id: string, input: Partial<McpServerInput>) {
    const existing = this.deps.store.state.mcpServers.find((record) => record.id === id);
    if (!existing) throw new IntegrationError("Not found");
    const merged = {
      name: input.name ?? existing.name,
      transport: input.transport ?? existing.transport,
      url: input.url ?? existing.url ?? undefined,
      command: input.command ?? existing.command ?? undefined,
      args: input.args ?? existing.args,
      headerName: input.headerName ?? existing.headerName ?? undefined,
      headerValue: input.headerValue,
      env: input.env,
      agents: input.agents ?? existing.agents,
    } satisfies McpServerInput;
    await this.saveMcp(this.mcpRecord(merged, existing));
  }

  private mcpRecord(
    input: McpServerInput,
    base: Pick<McpServerRecord, "id" | "slug" | "secret" | "envKeys">,
  ): McpServerRecord {
    if (input.transport === "stdio" ? !input.command : !input.url) {
      throw new IntegrationError(input.transport === "stdio" ? "Command is required" : "Server URL is required");
    }
    const previous: McpSecret = base.secret ? this.secrets.open<McpSecret>(base.secret) : {};
    const secret: McpSecret = {
      headerValue: input.headerValue === undefined ? previous.headerValue : input.headerValue || undefined,
      env: input.env === undefined ? previous.env : input.env,
    };
    const hasSecret = Boolean(secret.headerValue) || Boolean(secret.env && Object.keys(secret.env).length);
    return {
      id: base.id,
      name: input.name,
      slug: base.slug,
      transport: input.transport,
      url: input.transport === "stdio" ? null : (input.url ?? null),
      command: input.transport === "stdio" ? (input.command ?? null) : null,
      args: input.transport === "stdio" ? (input.args ?? []) : [],
      headerName: input.headerName?.trim() || (secret.headerValue ? "Authorization" : null),
      secret: hasSecret ? this.secrets.seal(secret) : null,
      envKeys: Object.keys(secret.env ?? {}),
      agents: input.agents,
    };
  }

  private uniqueSlug(name: string) {
    const base = slugify(name);
    const taken = new Set(this.deps.store.state.mcpServers.map((record) => record.slug));
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    return slug;
  }

  private async saveMcp(record: McpServerRecord) {
    await this.deps.store.update((state) => ({
      ...state,
      mcpServers: state.mcpServers.some((other) => other.id === record.id)
        ? state.mcpServers.map((other) => (other.id === record.id ? record : other))
        : [...state.mcpServers, record],
    }));
    this.deps.mcp.sync(this.deps.store.state.mcpServers);
    this.deps.onChange();
  }

  async removeMcpServer(id: string) {
    await this.deps.store.update((state) => ({
      ...state,
      mcpServers: state.mcpServers.filter((record) => record.id !== id),
    }));
    this.deps.mcp.sync(this.deps.store.state.mcpServers);
    this.deps.onChange();
  }

  reconnectMcpServer(id: string) {
    const record = this.deps.store.state.mcpServers.find((other) => other.id === id);
    if (record) void this.deps.mcp.connect(record);
  }

  // ---------- Tools ----------

  /** Every integration tool this bot may use: its connected apps plus its MCP servers. */
  toolsFor(botId: BotId): Tool[] {
    // Only accounts that finished connecting give tools; one waiting on a sign-in has nothing to call with.
    const native = this.deps.store.state.connections
      .filter(
        (record) => (record.status === "connected" || record.status === "reconnect") && record.agents.includes(botId),
      )
      .flatMap((record) => {
        const definition = connectorFor(record.connectorId);
        if (!definition) return [];
        const prefix = this.prefixOf(record);
        const context = (): ConnectorContext =>
          definition.item.auth.kind === "google"
            ? { fields: {}, googleToken: this.googleToken(record), channel: this.deps.store.state.channel }
            : { fields: this.secrets.open<Record<string, string>>(record.secret) };
        return definition.tools.map(
          (entry): Tool => ({
            name: `${prefix}_${entry.action}`,
            group: record.label,
            connectorId: record.connectorId,
            description: `${record.label}${record.account ? ` (${record.account})` : ""}: ${entry.description}`,
            parameters: schemaOf(entry.input),
            readOnly: entry.readOnly,
            category: entry.category,
            parse(input) {
              const parsed = entry.input.safeParse(input);
              return parsed.success
                ? { ok: true, value: parsed.data as Record<string, unknown> }
                : {
                    ok: false,
                    error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"),
                  };
            },
            run: async (input, toolContext) => {
              try {
                const result = await entry.run(input, { ...context(), tool: toolContext });
                await this.record(record.id, entry.action, true, null);
                return result;
              } catch (error) {
                await this.record(
                  record.id,
                  entry.action,
                  false,
                  error instanceof Error ? error.message : String(error),
                );
                throw error;
              }
            },
          }),
        );
      });
    return [...native, ...this.deps.mcp.toolsFor(this.deps.store.state.mcpServers, botId)];
  }
}

const schemaOf = (input: z.ZodObject) =>
  z.toJSONSchema(input, { target: "openapi-3.0", io: "input" }) as Record<string, unknown>;

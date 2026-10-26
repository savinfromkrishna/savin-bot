import type { Hono } from "hono";
import { z } from "zod";
import { ModelChoice, ModelConnectInput, Thinking } from "../../shared/contracts.ts";
import { COMPATIBLE, DEMO } from "../../shared/providers.ts";
import type { Accounts } from "../accounts.ts";
import { baseUrlOf, catalog } from "../llm/catalog.ts";
import { listModels, normalizeBaseUrl } from "../llm/compatible.ts";
import type { Store } from "../store.ts";
import { body, HttpError } from "./util.ts";

export type ModelDeps = {
  store: Store;
  accounts: Accounts;
  /** The space's owner, whose connections its bots run on. */
  ownerId: string;
  announce: () => void;
  /** Clears a disconnected provider from every space of the owner. */
  forgetProvider: (provider: string) => Promise<void>;
};

const failure = (error: unknown) => new HttpError(422, error instanceof Error ? error.message : String(error));

/** Settings → Models, as in savin: connections belong to the account, the chosen model to the space. */
export function modelRoutes(app: Hono, { store, accounts, ownerId, announce, forgetProvider }: ModelDeps) {
  const connected = (provider: string) =>
    provider === DEMO.providerId || accounts.get(ownerId).connections.some((entry) => entry.provider === provider);
  const use = async (provider: string, model: string | undefined, thinking?: Thinking | null) => {
    const chosen = model ?? catalog().find((view) => view.id === provider)?.models[0]?.id;
    if (!chosen) return;
    await store.update((state) => ({
      ...state,
      active: { providerId: provider, model: chosen },
      ...(thinking !== undefined && { thinking }),
    }));
  };

  app.get("/api/models/catalog", (c) => c.json(catalog()));

  /** Connects an API key, or your own OpenAI-compatible server, then uses the chosen model. */
  app.post("/api/models/connect", async (c) => {
    const input = await body(c, ModelConnectInput);
    try {
      if (input.provider === COMPATIBLE) {
        if (!input.baseUrl) throw new Error("Server URL is required");
        const models = [...new Set([...(input.model ? [input.model] : []), ...(input.models ?? [])])];
        if (!models.length) throw new Error("Find models or enter a model id");
        const server = { baseUrl: normalizeBaseUrl(input.baseUrl), models, reasoning: input.reasoning ?? false };
        await accounts.connectServer(ownerId, server, input.apiKey);
      } else {
        if (!input.apiKey) throw new Error("API key must contain at least 8 characters");
        await accounts.connectKey(ownerId, input.provider, input.apiKey);
      }
    } catch (error) {
      throw failure(error);
    }
    await use(input.provider, input.model, input.thinking);
    announce();
    return c.json({ connected: true }, 201);
  });

  /** "Test API key", "Find models" and "Test sign-in". Nothing is saved. */
  app.post("/api/models/test", async (c) => {
    const input = await body(
      c,
      z.object({
        provider: z.string().min(1).max(80),
        apiKey: z.string().max(4000).optional(),
        baseUrl: z.url().optional(),
      }),
    );
    try {
      if (input.provider === COMPATIBLE) {
        const saved = accounts.get(ownerId).connections.find((entry) => entry.provider === COMPATIBLE)?.server;
        const baseUrl = input.baseUrl ?? saved?.baseUrl;
        if (!baseUrl) throw new Error("Server URL is required");
        const stored = input.apiKey ? undefined : await accounts.credentials(ownerId).read(COMPATIBLE);
        const apiKey = input.apiKey || (stored?.type === "api_key" ? stored.key : undefined);
        return c.json({ models: await listModels({ baseUrl, apiKey }) });
      }
      const models = accounts.models(ownerId);
      const provider = models.getProvider(input.provider);
      if (!provider) throw new Error("Unknown provider");
      if (input.apiKey) {
        const baseUrl = baseUrlOf(provider.getModels());
        if (!baseUrl) throw new Error("This provider cannot be tested without saving.");
        return c.json({ models: await listModels({ baseUrl, apiKey: input.apiKey }) });
      }
      // A connected provider: resolve its stored credential, refreshing a subscription token when due.
      if (!(await models.getAuth(input.provider))) throw new Error("Not connected");
      return c.json({ ok: true });
    } catch (error) {
      throw failure(error);
    }
  });

  /** Subscription sign-in: a device code, or a link that ends with a code to paste back. */
  app.post("/api/models/sign-in", async (c) => {
    const input = await body(
      c,
      z.object({
        provider: z.string().min(1).max(80),
        model: z.string().max(200).optional(),
        thinking: Thinking.nullable().optional(),
      }),
    );
    try {
      const begin = await accounts.signIns.begin(ownerId, input.provider, async () => {
        await accounts.recordSignIn(ownerId, input.provider);
        await use(input.provider, input.model, input.thinking);
        announce();
      });
      return c.json(begin, 201);
    } catch (error) {
      throw failure(error);
    }
  });

  app.get("/api/models/sign-in/:id", (c) => c.json(accounts.signIns.status(ownerId, c.req.param("id"))));

  app.post("/api/models/sign-in/:id/code", async (c) => {
    const { code } = await body(c, z.object({ code: z.string().min(1).max(8192) }));
    try {
      accounts.signIns.submit(ownerId, c.req.param("id"), code);
    } catch (error) {
      throw failure(error);
    }
    return c.json({ ok: true });
  });

  app.delete("/api/models/sign-in/:id", (c) => {
    accounts.signIns.cancel(ownerId, c.req.param("id"));
    return c.json({ ok: true });
  });

  /** Disconnecting removes the connection from the account and from every space that chose it. */
  app.delete("/api/models/connections/:provider", async (c) => {
    const provider = c.req.param("provider");
    await accounts.disconnect(ownerId, provider);
    await forgetProvider(provider);
    return c.json({ disconnected: true });
  });

  app.put("/api/models/active", async (c) => {
    const { choice, thinking } = await body(
      c,
      z.object({ choice: ModelChoice.nullable().optional(), thinking: Thinking.nullable().optional() }),
    );
    if (choice && !connected(choice.providerId)) throw new HttpError(404, "Connect that model provider first");
    await store.update((state) => ({
      ...state,
      ...(choice !== undefined && { active: choice?.providerId === DEMO.providerId ? null : choice }),
      ...(thinking !== undefined && { thinking }),
    }));
    announce();
    return c.json({ saved: true });
  });

  app.put("/api/models/backups", async (c) => {
    const { backups } = await body(c, z.object({ backups: z.array(ModelChoice).max(10) }));
    if (backups.some((choice) => !connected(choice.providerId))) {
      throw new HttpError(422, "Connect that model provider first");
    }
    await store.update((state) => ({ ...state, backups }));
    announce();
    return c.json({ saved: true });
  });
}

import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import type { BotId } from "../../shared/contracts.ts";
import { BotCreate, BotPatch, CredentialInput } from "../../shared/contracts.ts";
import { automaticInstructions, botView, describeCredential } from "../bots.ts";
import type { Runtime } from "../runtime.ts";
import type { BotRecord, Store } from "../store.ts";
import { createdBot, missingTeam } from "../store.ts";
import { body, HttpError } from "./util.ts";

const MAX_HISTORY = 20;
const MAX_BOTS = 50;
const now = () => new Date().toISOString();

/** Saves a bot's memory document, as the bot or a person edits it. */
export const saveMemory = (store: Store, id: BotId, text: string) =>
  store.updateBot(id, (record) => ({
    ...record,
    memory: { text, revision: record.memory.revision + 1, updatedAt: now() },
  }));

export async function updateOpenWork(store: Store, id: BotId, change: { add: string[]; done: string[] }) {
  await store.updateBot(id, (record) => {
    const done = new Set(change.done.map((text) => text.trim().toLowerCase()));
    const kept = record.openWork.filter((item) => !done.has(item.text.trim().toLowerCase()) && !done.has(item.id));
    const added = change.add
      .filter((text) => !kept.some((item) => item.text === text))
      .map((text) => ({ id: randomUUID(), text, parked: false }));
    return { ...record, openWork: [...kept, ...added].slice(-50) };
  });
  return store.state.bots[id]?.openWork ?? [];
}

export function botRoutes(
  app: Hono,
  { store, runtime, announce }: { store: Store; runtime: Runtime; announce: () => void },
) {
  const botId = (raw: string) => {
    if (!Object.hasOwn(store.state.bots, raw)) throw new HttpError(404, "No such bot");
    return raw;
  };
  const save = async (id: BotId, change: (record: BotRecord) => BotRecord) => {
    await store.updateBot(id, change);
    announce();
  };
  const view = (id: BotId) => {
    const record = store.state.bots[id];
    if (!record) throw new HttpError(404, "No such bot");
    return botView(id, record, store.state);
  };
  const add = async (record: BotRecord) => {
    if (Object.keys(store.state.bots).length >= MAX_BOTS)
      throw new HttpError(409, `A space holds up to ${MAX_BOTS} bots`);
    const id = `bot-${randomUUID().slice(0, 8)}`;
    await store.update((state) => ({ ...state, bots: { ...state.bots, [id]: record } }));
    announce();
    return id;
  };

  /** "New bot". */
  app.post("/api/bots", async (c) => {
    const input = await body(c, BotCreate);
    const id = await add(createdBot(input, Object.keys(store.state.bots).length));
    return c.json(view(id), 201);
  });

  /** Adds the social media team, or brings back the roles that were deleted. */
  app.post("/api/team", async (c) => {
    const team = missingTeam(store.state.bots, store.state.kind);
    await store.update((state) => ({ ...state, bots: { ...state.bots, ...team } }));
    announce();
    return c.json({ added: Object.keys(team) }, 201);
  });

  app.post("/api/bots/:id/duplicate", async (c) => {
    const source = store.state.bots[botId(c.req.param("id"))] as BotRecord;
    const id = await add({
      ...source,
      role: null,
      createdAt: now(),
      name: `${source.name} copy`.slice(0, 80),
      instructions: source.instructions ?? automaticInstructions(source, store.state),
      instructionHistory: [],
      memory: { text: "", revision: 0, updatedAt: null },
      openWork: [],
      credentials: [],
      historyClearedAt: null,
    });
    return c.json(view(id), 201);
  });

  /** Deletes the bot with its conversation and routines; the apps it used stop listing it. */
  app.delete("/api/bots/:id", async (c) => {
    const id = botId(c.req.param("id"));
    await runtime.forget({ botId: id });
    await store.update((state) => {
      const { [id]: _deleted, ...bots } = state.bots;
      for (const [other, record] of Object.entries(bots)) {
        if (record.supervisor === id) bots[other] = { ...record, supervisor: null };
      }
      return {
        ...state,
        bots,
        routines: state.routines.filter((routine) => routine.botId !== id),
        groups: state.groups
          .map((group) => ({ ...group, botIds: group.botIds.filter((member) => member !== id) }))
          .filter((group) => group.botIds.length),
        connections: state.connections.map((record) => ({
          ...record,
          agents: record.agents.filter((agent) => agent !== id),
        })),
        mcpServers: state.mcpServers.map((record) => ({
          ...record,
          agents: record.agents.filter((agent) => agent !== id),
        })),
      };
    });
    announce();
    return c.json({ deleted: true });
  });

  app.put("/api/bots/:id", async (c) => {
    const id = botId(c.req.param("id"));
    const patch = await body(c, BotPatch);
    await save(id, (record) => {
      const { tools, instructions, ...simple } = patch;
      const next: BotRecord = { ...record, ...simple, ...(tools && { tools: { ...record.tools, ...tools } }) };
      if (instructions !== undefined) {
        const current = record.instructions ?? automaticInstructions(record, store.state);
        const changed = instructions === null ? record.instructions !== null : instructions !== current;
        if (changed) {
          next.instructions = instructions;
          next.instructionHistory = [
            { at: now(), reason: instructions === null ? "Reset to automatic" : "Edited", text: current },
            ...record.instructionHistory,
          ].slice(0, MAX_HISTORY);
        }
      }
      return next;
    });
    return c.json(view(id));
  });

  app.post("/api/bots/:id/credentials", async (c) => {
    const id = botId(c.req.param("id"));
    const input = await body(c, CredentialInput);
    await save(id, (record) => ({
      ...record,
      credentials: [
        ...record.credentials,
        { id: randomUUID(), type: input.type, ...describeCredential(input), secret: store.secrets.seal(input) },
      ],
    }));
    return c.json({ saved: true }, 201);
  });

  app.delete("/api/bots/:id/credentials/:credentialId", async (c) => {
    const id = botId(c.req.param("id"));
    await save(id, (record) => ({
      ...record,
      credentials: record.credentials.filter((credential) => credential.id !== c.req.param("credentialId")),
    }));
    return c.json({ deleted: true });
  });

  app.put("/api/bots/:id/memory", async (c) => {
    const id = botId(c.req.param("id"));
    const { text } = await body(c, z.object({ text: z.string().max(20_000) }));
    await saveMemory(store, id, text);
    announce();
    return c.json({ saved: true });
  });

  app.post("/api/bots/:id/open-work", async (c) => {
    const id = botId(c.req.param("id"));
    const { text } = await body(c, z.object({ text: z.string().trim().min(1).max(300) }));
    await updateOpenWork(store, id, { add: [text], done: [] });
    announce();
    return c.json({ added: true }, 201);
  });

  app.patch("/api/bots/:id/open-work/:itemId", async (c) => {
    const id = botId(c.req.param("id"));
    const { parked } = await body(c, z.object({ parked: z.boolean() }));
    await save(id, (record) => ({
      ...record,
      openWork: record.openWork.map((item) => (item.id === c.req.param("itemId") ? { ...item, parked } : item)),
    }));
    return c.json({ saved: true });
  });

  app.delete("/api/bots/:id/open-work/:itemId", async (c) => {
    const id = botId(c.req.param("id"));
    await save(id, (record) => ({
      ...record,
      openWork: record.openWork.filter((item) => item.id !== c.req.param("itemId")),
    }));
    return c.json({ deleted: true });
  });

  app.post("/api/bots/:id/clear", async (c) => {
    const id = botId(c.req.param("id"));
    await save(id, (record) => ({ ...record, historyClearedAt: now() }));
    return c.json({ cleared: true });
  });

  /** A JSON manifest of the bot's setup, without credentials. */
  app.get("/api/bots/:id/export", (c) => {
    const {
      credentials: _credentials,
      instructionHistory: _history,
      historyClearedAt: _cleared,
      ...bot
    } = view(botId(c.req.param("id")));
    return c.json({ kind: "savin-social/bot", version: 1, exportedAt: now(), bot }, 200, {
      "content-disposition": `attachment; filename="${bot.name.replace(/[^\w-]+/g, "-")}.bot.json"`,
    });
  });
}

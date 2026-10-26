import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import { ApprovalRuleInput, BotId, Preferences, Profile, RoutineInput } from "../../shared/contracts.ts";
import type { Accounts } from "../accounts.ts";
import type { SkillLibrary } from "../library.ts";
import type { Runtime } from "../runtime.ts";
import type { Scheduler } from "../scheduler.ts";
import { validCron } from "../scheduler.ts";
import type { Store } from "../store.ts";
import { body, HttpError } from "./util.ts";

type SettingsDeps = {
  store: Store;
  runtime: Runtime;
  scheduler: Scheduler;
  skills: SkillLibrary;
  accounts: Accounts;
  ownerId: string;
  announce: () => void;
};

export function settingsRoutes(
  app: Hono,
  { store, runtime, scheduler, skills, accounts, ownerId, announce }: SettingsDeps,
) {
  const update = async (change: Parameters<Store["update"]>[0]) => {
    await store.update(change);
    announce();
  };

  // ---------- Brand and preferences ----------

  app.put("/api/profile", async (c) => {
    const profile = await body(c, Profile);
    await update((state) => ({ ...state, profile }));
    return c.json({ saved: true });
  });

  /** Appearance and chat preferences belong to the account, so every space looks the same. */
  app.put("/api/preferences", async (c) => {
    const preferences = await body(c, Preferences.partial());
    await accounts.update(ownerId, (record) => ({
      ...record,
      preferences: { ...record.preferences, ...preferences },
    }));
    return c.json({ saved: true });
  });

  // ---------- Approvals ----------

  app.post("/api/approval-rules", async (c) => {
    const input = await body(c, ApprovalRuleInput);
    await update((state) => ({
      ...state,
      approvalRules: [
        ...state.approvalRules.filter((rule) => JSON.stringify(rule.target) !== JSON.stringify(input.target)),
        { ...input, id: randomUUID(), createdAt: new Date().toISOString() },
      ],
    }));
    return c.json({ saved: true }, 201);
  });

  app.delete("/api/approval-rules/:id", async (c) => {
    await update((state) => ({
      ...state,
      approvalRules: state.approvalRules.filter((rule) => rule.id !== c.req.param("id")),
    }));
    return c.json({ deleted: true });
  });

  // ---------- Google sign-in (the account's OAuth client, used by YouTube) ----------

  app.put("/api/google", async (c) => {
    const input = await body(
      c,
      z.object({ clientId: z.string().trim().max(300), clientSecret: z.string().trim().max(300).optional() }),
    );
    await accounts.update(ownerId, (record) => ({
      ...record,
      google: {
        clientId: input.clientId || null,
        clientSecret:
          input.clientSecret === undefined
            ? record.google.clientSecret
            : input.clientSecret
              ? accounts.secrets.seal(input.clientSecret)
              : null,
      },
    }));
    return c.json({ saved: true });
  });

  // ---------- Shared skills ----------

  app.get("/api/skills/:name", async (c) => {
    const skill = await skills.read(c.req.param("name"));
    if (!skill) throw new HttpError(404, "No such skill");
    return c.json(skill);
  });

  app.put("/api/skills", async (c) => {
    const { content, previousName } = await body(
      c,
      z.object({ content: z.string().min(1).max(100_000), previousName: z.string().optional() }),
    );
    try {
      const name = await skills.save(content, previousName);
      announce();
      return c.json({ name });
    } catch (error) {
      throw new HttpError(422, error instanceof Error ? error.message : String(error));
    }
  });

  app.delete("/api/skills/:name", async (c) => {
    await skills.remove(c.req.param("name"));
    announce();
    return c.json({ deleted: true });
  });

  // ---------- Routines ----------

  const saveRoutine = async (id: string, input: z.infer<typeof RoutineInput>) => {
    if (!validCron(input.schedule)) throw new HttpError(400, "That schedule isn't a valid cron expression");
    if (!store.state.bots[input.botId]) throw new HttpError(404, "No such bot");
    await update((state) => {
      const existing = state.routines.find((routine) => routine.id === id);
      const routine = { ...input, id, lastRunAt: existing?.lastRunAt ?? null };
      return {
        ...state,
        routines: existing
          ? state.routines.map((other) => (other.id === id ? routine : other))
          : [...state.routines, routine],
      };
    });
    scheduler.sync();
  };

  app.post("/api/routines", async (c) => {
    const id = randomUUID();
    await saveRoutine(id, await body(c, RoutineInput));
    return c.json({ id }, 201);
  });

  app.put("/api/routines/:id", async (c) => {
    const id = c.req.param("id");
    if (!store.state.routines.some((routine) => routine.id === id)) throw new HttpError(404, "Not found");
    await saveRoutine(id, await body(c, RoutineInput));
    return c.json({ id });
  });

  app.delete("/api/routines/:id", async (c) => {
    await update((state) => ({
      ...state,
      routines: state.routines.filter((routine) => routine.id !== c.req.param("id")),
    }));
    scheduler.sync();
    return c.json({ deleted: true });
  });

  app.post("/api/routines/:id/run", (c) => {
    const run = scheduler.fire(c.req.param("id"));
    if (!run) throw new HttpError(409, "This routine is already running");
    return c.json(run, 201);
  });

  // ---------- Computer control ----------

  app.post("/api/computer/:botId/control", async (c) => {
    const id = BotId.parse(c.req.param("botId"));
    const { take } = await body(c, z.object({ take: z.boolean() }));
    if (take) runtime.takeControl(id);
    else runtime.releaseControl(id);
    return c.json(runtime.controlState());
  });
}

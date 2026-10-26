import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { Bot, BotId, Group } from "../../shared/contracts.ts";
import { GroupInput, GroupMessageInput } from "../../shared/contracts.ts";
import type { Runtime } from "../runtime.ts";
import type { Store } from "../store.ts";
import { body, HttpError } from "./util.ts";

const MAX_GROUPS = 50;

/** Who answers a group message, as in savin: the members it @mentions, all of them for @everyone, else the first. */
export function mentioned(text: string, members: Pick<Bot, "id" | "name">[]): BotId[] {
  if (/(^|\s)@everyone\b/i.test(text)) return members.map((member) => member.id);
  const lower = text.toLowerCase();
  const named = members.filter(
    (member) => lower.includes(`@${member.name.toLowerCase()}`) || lower.includes(`@${member.id}`),
  );
  return (named.length ? named : members.slice(0, 1)).map((member) => member.id);
}

export function groupRoutes(
  app: Hono,
  { store, runtime, announce }: { store: Store; runtime: Runtime; announce: () => void },
) {
  const groupOf = (id: string) => {
    const group = store.state.groups.find((candidate) => candidate.id === id);
    if (!group) throw new HttpError(404, "No such group");
    return group;
  };
  const members = (botIds: BotId[]) => {
    if (botIds.some((id) => !store.state.bots[id])) throw new HttpError(404, "No such bot");
    return [...new Set(botIds)];
  };
  const save = async (group: Group) => {
    await store.update((state) => ({
      ...state,
      groups: state.groups.some((other) => other.id === group.id)
        ? state.groups.map((other) => (other.id === group.id ? group : other))
        : [...state.groups, group],
    }));
    announce();
  };

  /** "New group": a shared chat with 2–10 of this space's bots. */
  app.post("/api/groups", async (c) => {
    const input = await body(c, GroupInput);
    if (store.state.groups.length >= MAX_GROUPS) throw new HttpError(409, `A space holds up to ${MAX_GROUPS} groups`);
    const group: Group = {
      id: randomUUID(),
      name: input.name,
      botIds: members(input.botIds),
      createdAt: new Date().toISOString(),
    };
    await save(group);
    return c.json(group, 201);
  });

  app.put("/api/groups/:id", async (c) => {
    const group = groupOf(c.req.param("id"));
    const input = await body(c, GroupInput.partial());
    const next: Group = {
      ...group,
      ...(input.name && { name: input.name }),
      ...(input.botIds && { botIds: members(input.botIds) }),
    };
    await save(next);
    return c.json(next);
  });

  /** Deletes the group and its thread; the bots stay. */
  app.delete("/api/groups/:id", async (c) => {
    const group = groupOf(c.req.param("id"));
    await runtime.forget({ groupId: group.id });
    await store.update((state) => ({ ...state, groups: state.groups.filter((other) => other.id !== group.id) }));
    announce();
    return c.json({ deleted: true });
  });

  app.post("/api/groups/:id/messages", async (c) => {
    const group = groupOf(c.req.param("id"));
    const input = await body(c, GroupMessageInput);
    const bots = runtime.bots();
    const inOrder = group.botIds.flatMap((id) => bots.filter((bot) => bot.id === id));
    if (!inOrder.length) throw new HttpError(409, "Add a bot to this group first");
    const messageId = randomUUID();
    const runs = mentioned(input.text, inOrder).map((botId) =>
      runtime.start(
        botId,
        input.text,
        { kind: "manual" },
        { attachments: input.attachments, group: { id: group.id, messageId } },
      ),
    );
    return c.json({ messageId, runs }, 201);
  });
}

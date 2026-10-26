import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { botView, botViews, describeCredential, openCredentials } from "../src/server/bots.ts";
import { jobSkillsDir, SkillLibrary } from "../src/server/library.ts";
import { Secrets } from "../src/server/secrets.ts";
import type { BotRecord } from "../src/server/store.ts";
import { createdBot, missingTeam, Store } from "../src/server/store.ts";

const fresh = () => mkdtempSync(join(tmpdir(), "savin-social-store-"));

const recordOf = (store: Store, id: string) => {
  const record = store.state.bots[id];
  if (!record) throw new Error(`No bot ${id}`);
  return record;
};

describe("store", () => {
  it("starts a space with the social media team, configured from the brand profile", async () => {
    const dir = fresh();
    const store = await Store.open(dir, Secrets.open(join(dir, "secret.key")));
    const bots = botViews(store.state);
    expect(bots.map((bot) => bot.id)).toEqual([
      "director",
      "scout",
      "writer",
      "editor",
      "producer",
      "publisher",
      "community",
    ]);
    expect(bots.filter((bot) => bot.supervisor === null).map((bot) => bot.id)).toEqual(["director"]);
    expect(bots.find((bot) => bot.id === "publisher")).toMatchObject({
      role: "publisher",
      computerAccess: "ask",
      instructionsAutomatic: true,
    });
    expect(store.state.routines.every((routine) => !routine.active)).toBe(true);

    await store.update((state) => ({
      ...state,
      profile: { ...state.profile, brand: "Brew Lab", platforms: ["tiktok"] },
    }));
    const publisher = botView("publisher", recordOf(store, "publisher"), store.state);
    expect(publisher.instructions).toContain("tiktokstudio");
  });

  it("starts an empty space when asked, and the team can be added later", async () => {
    const dir = fresh();
    const store = await Store.open(dir, Secrets.open(join(dir, "secret.key")), { team: false });
    expect(store.state.bots).toEqual({});
    expect(store.state.routines).toEqual([]);
    await store.update((state) => ({ ...state, bots: { ...state.bots, ...missingTeam(state.bots) } }));
    expect(botViews(store.state).map((bot) => bot.id)).toHaveLength(7);
    expect(missingTeam(store.state.bots)).toEqual({});
  });

  it("orders created bots after the team, oldest first", async () => {
    const dir = fresh();
    const store = await Store.open(dir, Secrets.open(join(dir, "secret.key")));
    await store.update((state) => ({
      ...state,
      bots: {
        "bot-b": { ...createdBot({ name: "B", title: "", description: "Second" }, 7), createdAt: "2026-02-01" },
        ...state.bots,
        "bot-a": { ...createdBot({ name: "A", title: "", description: "First" }, 6), createdAt: "2026-01-01" },
      },
    }));
    const bots = botViews(store.state);
    expect(bots.map((bot) => bot.id).slice(-2)).toEqual(["bot-a", "bot-b"]);
    expect(bots.at(-1)).toMatchObject({ role: null, supervisor: null, instructions: "Second" });
  });

  it("brings a version 2 space forward: the team keeps its roles, account settings move out", async () => {
    const dir = fresh();
    const secrets = Secrets.open(join(dir, "secret.key"));
    const seeded = await Store.open(dir, secrets);
    const { director, writer } = seeded.state.bots;
    const strip = ({ role: _role, supervisor: _supervisor, createdAt: _created, ...rest }: BotRecord) => rest;
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        ...seeded.state,
        version: 2,
        bots: {
          director: strip(director as BotRecord),
          writer: { ...strip(writer as BotRecord), instructions: "Keep it short." },
        },
        providers: [
          { id: "p1", name: "Imported", preset: null, baseUrl: "https://example.test/v1", apiKey: null, models: ["m"] },
        ],
        active: { providerId: "p1", model: "m" },
        thinking: "high",
        preferences: { theme: "dark", sendWithEnter: true, showToolActivity: true, density: "comfortable" },
        google: { clientId: null, clientSecret: null },
      }),
    );
    const store = await Store.open(dir, secrets);
    expect(store.state.version).toBe(5);
    expect(recordOf(store, "writer")).toMatchObject({
      role: "writer",
      supervisor: "director",
      instructions: "Keep it short.",
    });
    expect(recordOf(store, "director")).toMatchObject({ role: "director", supervisor: null });
    expect(store.state.active).toBeNull();
    expect(store.state.thinking).toBe("high");
    for (const moved of ["providers", "preferences", "google"]) expect(store.state).not.toHaveProperty(moved);
  });

  it("brings a version 3 space forward: the Producer joins the team, and the main browser is there", async () => {
    const dir = fresh();
    const secrets = Secrets.open(join(dir, "secret.key"));
    const seeded = await Store.open(dir, secrets);
    const { producer: _producer, ...bots } = seeded.state.bots;
    const { browsers: _browsers, channel: _channel, ...rest } = seeded.state;
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        ...rest,
        version: 3,
        bots: Object.fromEntries(
          Object.entries(bots).map(([id, record]) => {
            const { video: _video, ...tools } = record.tools;
            return [id, { ...record, tools }];
          }),
        ),
      }),
    );
    const store = await Store.open(dir, secrets);
    expect(store.state.version).toBe(5);
    expect(recordOf(store, "producer")).toMatchObject({ role: "producer", supervisor: "director" });
    expect(recordOf(store, "producer").tools.video).toBe(true);
    expect(recordOf(store, "writer").tools.video).toBe(false);
    expect(store.state.browsers.map((browser) => browser.id)).toEqual(["main"]);
    expect(store.state.channel).toBeNull();

    // A space without the team stays without it.
    const empty = fresh();
    const blank = await Store.open(empty, secrets, { team: false });
    const { browsers: _b, channel: _c, ...plain } = blank.state;
    writeFileSync(join(empty, "state.json"), JSON.stringify({ ...plain, version: 3 }));
    expect((await Store.open(empty, secrets)).state.bots).toEqual({});
  });

  it("brings a version 4 space forward: habits, and a job search Coordinator that coaches", async () => {
    const secrets = Secrets.open(join(fresh(), "secret.key"));
    const reopen = async (kind: "jobs" | "social") => {
      const dir = fresh();
      const seeded = await Store.open(dir, secrets, { kind });
      const { habits: _habits, ...rest } = seeded.state;
      const coordinator = seeded.state.bots.coordinator;
      writeFileSync(
        join(dir, "state.json"),
        JSON.stringify({
          ...rest,
          version: 4,
          routines: rest.routines.slice(0, kind === "jobs" ? 1 : 3),
          bots: coordinator
            ? { ...rest.bots, coordinator: { ...coordinator, tools: { ...coordinator.tools, browser: false } } }
            : rest.bots,
        }),
      );
      return Store.open(dir, secrets);
    };

    const jobs = await reopen("jobs");
    expect(jobs.state).toMatchObject({ version: 5, habits: [] });
    expect(recordOf(jobs, "coordinator").tools).toMatchObject({ browser: true, shell: false, screen: false });
    expect(recordOf(jobs, "finder").tools.browser).toBe(true);
    expect(jobs.state.routines.map((routine) => routine.name)).toEqual([
      "Daily job search",
      "Morning check-in",
      "Weekly review",
    ]);

    const social = await reopen("social");
    expect(social.state).toMatchObject({ version: 5, habits: [] });
    expect(social.state.routines.map((routine) => routine.name)).toEqual([
      "Morning trend scan",
      "Weekly content batch",
      "Reply to comments",
    ]);
  });

  it("seals secrets so a different key cannot open them", () => {
    const one = Secrets.open(join(fresh(), "k"));
    const two = Secrets.open(join(fresh(), "k"));
    const sealed = one.seal({ token: "abc" });
    expect(sealed).not.toContain("abc");
    expect(one.open(sealed)).toEqual({ token: "abc" });
    expect(() => two.open(sealed)).toThrow();
  });

  it("keeps credential secrets out of what the settings show", async () => {
    const dir = fresh();
    const secrets = Secrets.open(join(dir, "secret.key"));
    const store = await Store.open(dir, secrets);
    const input = { type: "login" as const, domain: "instagram.com", username: "brew", password: "hunter2" };
    await store.updateBot("publisher", (record) => ({
      ...record,
      credentials: [{ id: "c1", type: "login", ...describeCredential(input), secret: secrets.seal(input) }],
    }));
    const view = botView("publisher", recordOf(store, "publisher"), store.state);
    expect(JSON.stringify(view)).not.toContain("hunter2");
    expect(view.credentials).toEqual([{ id: "c1", type: "login", target: "instagram.com", detail: "brew" }]);
    expect(openCredentials(recordOf(store, "publisher"), secrets)).toEqual([input]);
  });

  it("ships built-in skills and lets your own override them", async () => {
    const library = new SkillLibrary(fresh());
    const builtIn = await library.list();
    expect(builtIn.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(["youtube-shorts", "vertical-video", "youtube-upload", "trend-research"]),
    );
    expect(builtIn.every((skill) => skill.builtIn && skill.description)).toBe(true);

    await library.save("---\nname: youtube-shorts\ndescription: Our own way.\n---\n\nDo it our way.");
    expect((await library.list()).find((skill) => skill.name === "youtube-shorts")).toEqual({
      name: "youtube-shorts",
      description: "Our own way.",
      builtIn: false,
    });
    await expect(library.save("no front matter")).rejects.toThrow(/front matter/);
    await library.remove("youtube-shorts");
    expect((await library.list()).find((skill) => skill.name === "youtube-shorts")?.builtIn).toBe(true);
  });

  it("gives a job search space its own built-in skills and none about social media", async () => {
    const skills = await new SkillLibrary(fresh(), jobSkillsDir).list();
    expect(skills.map((skill) => skill.name)).toEqual([
      "coaching-questions",
      "habit-plan",
      "interview-practice",
      "profile-review",
    ]);
    expect(skills.every((skill) => skill.builtIn && skill.description)).toBe(true);
  });
});

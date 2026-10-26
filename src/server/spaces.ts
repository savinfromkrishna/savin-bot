import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Preferences, SpaceKind } from "../shared/contracts.ts";
import { COMPATIBLE } from "../shared/providers.ts";
import type { AuthUser } from "./auth.ts";
import { normalizeBaseUrl } from "./llm/compatible.ts";
import type { OpenSpace, SpaceRecord, SpaceShared } from "./space.ts";
import { openSpace } from "./space.ts";
import { withoutProvider, writeJson } from "./store.ts";

export class SpaceError extends Error {}

const MAX_SPACES = 32;
/** What the single-space version kept at the top of the data folder. */
const legacyEntries = ["state.json", "runs", "workspace", "skills", "browser-profile"];

/** Every account's spaces. Each one is opened at start-up so its routines keep firing. */
export class Spaces {
  private open = new Map<string, OpenSpace>();
  private writes = Promise.resolve();

  private constructor(
    private readonly dataDir: string,
    private readonly shared: SpaceShared,
    private records: SpaceRecord[],
  ) {}

  static async load(dataDir: string, shared: SpaceShared) {
    const file = join(dataDir, "spaces.json");
    const records: SpaceRecord[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    const spaces = new Spaces(dataDir, shared, records);
    for (const record of records) await spaces.start(record);
    // A space's view includes its owner's model connections, so it refreshes when they change.
    shared.accounts.onChange((userId) => {
      for (const space of spaces.ownedBy(userId)) space.announce();
    });
    return spaces;
  }

  private dir(id: string) {
    return join(this.dataDir, "spaces", id);
  }

  private async start(record: SpaceRecord, options?: { team?: boolean; kind?: SpaceKind }) {
    const space = await openSpace(
      this.dir(record.id),
      () => this.records.find((other) => other.id === record.id) ?? record,
      this.shared,
      options,
    );
    this.open.set(record.id, space);
    return space;
  }

  private save() {
    const snapshot = this.records;
    this.writes = this.writes.then(() => writeJson(join(this.dataDir, "spaces.json"), snapshot));
    return this.writes;
  }

  get(id: string) {
    return this.open.get(id);
  }

  /** An account's spaces: its default first, then the rest in the order they were made. */
  ownedBy(ownerId: string): OpenSpace[] {
    return this.records
      .filter((record) => record.ownerId === ownerId)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.localeCompare(b.createdAt))
      .flatMap((record) => this.open.get(record.id) ?? []);
  }

  async create(ownerId: string, name: string, options: { team: boolean; kind?: SpaceKind; isDefault?: boolean }) {
    if (this.records.filter((record) => record.ownerId === ownerId).length >= MAX_SPACES) {
      throw new SpaceError(`You can have up to ${MAX_SPACES} spaces`);
    }
    const record: SpaceRecord = {
      id: randomUUID(),
      name,
      ownerId,
      isDefault: Boolean(options.isDefault),
      createdAt: new Date().toISOString(),
    };
    const space = await this.start(record, { team: options.team, kind: options.kind });
    // A new space starts on the same model as the account's default space.
    const home = this.ownedBy(ownerId).find((other) => other.record.isDefault);
    if (home) {
      const { active, thinking, backups } = home.store.state;
      await space.store.update((state) => ({ ...state, active, thinking, backups }));
    }
    this.records = [...this.records, record];
    await this.save();
    return space;
  }

  async rename(id: string, name: string) {
    this.records = this.records.map((record) => (record.id === id ? { ...record, name } : record));
    await this.save();
    this.open.get(id)?.announce();
  }

  /** Deletes a space and everything in it. The default space stays. */
  async remove(id: string) {
    const record = this.records.find((other) => other.id === id);
    if (!record) return;
    if (record.isDefault) throw new SpaceError("Your first space can't be deleted");
    await this.open.get(id)?.close();
    this.open.delete(id);
    this.records = this.records.filter((other) => other.id !== id);
    await this.save();
    await rm(this.dir(id), { recursive: true, force: true, maxRetries: 3 });
  }

  /** The space waiting for this Google sign-in callback. */
  forGoogle(state: string) {
    return [...this.open.values()].find((space) => space.integrations.owns(state));
  }

  /**
   * A new account's "Personal" space, with the social media team. The very first account also
   * takes over what the single-space version stored: its team, runs, files and browser sign-ins.
   */
  async bootstrap(user: AuthUser) {
    if (this.records.some((record) => record.ownerId === user.id)) return;
    const adopt = this.records.length === 0 && existsSync(join(this.dataDir, "state.json"));
    if (adopt) {
      const id = randomUUID();
      const legacy = JSON.parse(await readFile(join(this.dataDir, "state.json"), "utf8")) as {
        preferences?: Preferences;
        google?: { clientId: string | null; clientSecret: string | null };
      };
      await this.shared.accounts.update(user.id, (account) => ({
        ...account,
        ...(legacy.preferences && { preferences: { ...account.preferences, ...legacy.preferences } }),
        ...(legacy.google && { google: legacy.google }),
      }));
      await mkdir(this.dir(id), { recursive: true });
      for (const entry of legacyEntries) {
        if (existsSync(join(this.dataDir, entry))) await rename(join(this.dataDir, entry), join(this.dir(id), entry));
      }
      const record: SpaceRecord = {
        id,
        name: "Personal",
        ownerId: user.id,
        isDefault: true,
        createdAt: new Date().toISOString(),
      };
      await this.start(record);
      this.records = [...this.records, record];
      await this.save();
    } else {
      await this.create(user.id, "Personal", { team: true, isDefault: true });
    }
    await this.seedModelFromEnv(user.id);
  }

  /** A model in .env becomes the first account's server connection, so a fresh install works at once. */
  private async seedModelFromEnv(userId: string) {
    const { LLM_BASE_URL: baseUrl, LLM_MODEL: model, LLM_API_KEY: key } = process.env;
    if (!baseUrl || !model || this.records.length > 1) return;
    await this.shared.accounts.connectServer(
      userId,
      { baseUrl: normalizeBaseUrl(baseUrl), models: [model], reasoning: false },
      key,
    );
    for (const space of this.ownedBy(userId)) {
      await space.store.update((state) => ({ ...state, active: state.active ?? { providerId: COMPATIBLE, model } }));
    }
  }

  /** After a provider is disconnected, no space of the account keeps choosing it. */
  async forgetProvider(ownerId: string, provider: string) {
    for (const space of this.ownedBy(ownerId)) {
      await space.store.update((state) => withoutProvider(state, provider));
      space.announce();
    }
  }

  async closeAll() {
    await Promise.all([...this.open.values()].map((space) => space.close()));
    await this.writes;
  }
}

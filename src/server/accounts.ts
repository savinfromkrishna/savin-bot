import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import type { ModelConnectionView, Preferences } from "../shared/contracts.ts";
import { COMPATIBLE } from "../shared/providers.ts";
import { accountModels, catalog } from "./llm/catalog.ts";
import { type CompatibleServer, compatibleProvider } from "./llm/compatible.ts";
import { sealedCredentials } from "./llm/credentials.ts";
import type { ModelAccess } from "./llm/models.ts";
import type { Login } from "./llm/sign-in.ts";
import { SignIns } from "./llm/sign-in.ts";
import type { Secrets } from "./secrets.ts";
import { writeJson } from "./store.ts";

/** What belongs to a person rather than a space: model connections, appearance and the Google client. */
export type AccountRecord = {
  version: 1;
  /** Sealed model credentials by provider id: API keys and subscription tokens. */
  credentials: Record<string, string>;
  connections: ModelConnectionView[];
  preferences: Preferences;
  /** The OAuth client the YouTube integration signs in with; the secret is sealed. */
  google: { clientId: string | null; clientSecret: string | null };
};

export const defaultPreferences: Preferences = {
  theme: "system",
  sendWithEnter: true,
  showToolActivity: true,
  density: "comfortable",
  dictation: "en",
};

const fresh = (): AccountRecord => ({
  version: 1,
  credentials: {},
  connections: [],
  preferences: defaultPreferences,
  google: { clientId: null, clientSecret: null },
});

const providerName = (provider: string) => catalog().find((view) => view.id === provider)?.name ?? provider;

/** One JSON file per account, plus each account's pi model collection and its sign-ins in progress. */
export class Accounts {
  private records = new Map<string, AccountRecord>();
  private stores = new Map<string, CredentialStore>();
  private collections = new Map<string, MutableModels>();
  private writes = new Map<string, Promise<void>>();
  private listeners = new Set<(userId: string) => void>();
  readonly signIns: SignIns;

  /** `login` replaces the providers' own sign-in flows, for tests. */
  constructor(
    private readonly dir: string,
    readonly secrets: Secrets,
    login?: Login,
  ) {
    this.signIns = new SignIns(
      login ?? ((userId, provider, interaction) => this.models(userId).login(provider, "oauth", interaction)),
    );
  }

  private file(userId: string) {
    if (!/^[\w-]+$/.test(userId)) throw new Error("Invalid account id");
    return join(this.dir, `${userId}.json`);
  }

  get(userId: string): AccountRecord {
    let record = this.records.get(userId);
    if (!record) {
      try {
        const saved = JSON.parse(readFileSync(this.file(userId), "utf8")) as AccountRecord;
        // Preferences added since the file was written start at their defaults.
        record = { ...fresh(), ...saved, preferences: { ...defaultPreferences, ...saved.preferences } };
      } catch {
        record = fresh();
      }
      this.records.set(userId, record);
    }
    return record;
  }

  update(userId: string, change: (record: AccountRecord) => AccountRecord) {
    const next = change(this.get(userId));
    this.records.set(userId, next);
    const write = (this.writes.get(userId) ?? Promise.resolve())
      .then(() => mkdir(this.dir, { recursive: true }))
      .then(() => writeJson(this.file(userId), next));
    this.writes.set(
      userId,
      write.catch(() => {}),
    );
    for (const listener of this.listeners) listener(userId);
    return write;
  }

  /** Called with the account id whenever one of its settings changes, so its spaces can refresh. */
  onChange(listener: (userId: string) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The account's sealed credentials. One store per account, so every write to it runs in turn. */
  credentials(userId: string): CredentialStore {
    let store = this.stores.get(userId);
    if (!store) {
      store = sealedCredentials(
        {
          read: () => this.get(userId).credentials,
          write: (change) => this.update(userId, (record) => ({ ...record, credentials: change(record.credentials) })),
        },
        this.secrets,
      );
      this.stores.set(userId, store);
    }
    return store;
  }

  /** pi's providers for this account; credentials resolve, and refresh, from its sealed records. */
  models(userId: string): MutableModels {
    let models = this.collections.get(userId);
    if (!models) {
      models = accountModels(this.credentials(userId), this.server(userId));
      this.collections.set(userId, models);
    }
    return models;
  }

  access(userId: string): ModelAccess {
    return {
      models: this.models(userId),
      connected: new Set(this.get(userId).connections.map((connection) => connection.provider)),
    };
  }

  private server(userId: string): CompatibleServer | null {
    return this.get(userId).connections.find((connection) => connection.provider === COMPATIBLE)?.server ?? null;
  }

  private async saveConnection(userId: string, connection: Omit<ModelConnectionView, "label" | "connectedAt">) {
    await this.update(userId, (record) => ({
      ...record,
      connections: [
        ...record.connections.filter((other) => other.provider !== connection.provider),
        { ...connection, label: providerName(connection.provider), connectedAt: new Date().toISOString() },
      ],
    }));
  }

  async connectKey(userId: string, provider: string, key: string) {
    const view = catalog().find((entry) => entry.id === provider && entry.id !== COMPATIBLE);
    if (!view?.apiKey) throw new Error("This provider does not take an API key.");
    await this.credentials(userId).modify(provider, async () => ({ type: "api_key", key }));
    await this.saveConnection(userId, { provider, auth: "api_key", server: null });
  }

  /** Records a finished subscription sign-in; pi has already stored its credential. */
  recordSignIn(userId: string, provider: string) {
    return this.saveConnection(userId, { provider, auth: "oauth", server: null });
  }

  /** Your own OpenAI-compatible server. Omitting the key keeps the saved one; an empty one removes it. */
  async connectServer(userId: string, server: CompatibleServer, key?: string) {
    const credentials = this.credentials(userId);
    if (key === "") await credentials.delete(COMPATIBLE);
    else if (key) await credentials.modify(COMPATIBLE, async () => ({ type: "api_key", key }));
    await this.saveConnection(userId, { provider: COMPATIBLE, auth: "server", server });
    this.models(userId).setProvider(compatibleProvider(server));
  }

  async disconnect(userId: string, provider: string) {
    this.signIns.cancelProvider(userId, provider);
    await this.credentials(userId).delete(provider);
    await this.update(userId, (record) => ({
      ...record,
      connections: record.connections.filter((connection) => connection.provider !== provider),
    }));
    if (provider === COMPATIBLE) this.models(userId).deleteProvider(COMPATIBLE);
  }
}

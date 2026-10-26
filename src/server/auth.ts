import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";

export type AuthUser = { id: string; name: string; email: string };

/** Set by the server from the connection itself, so the rate limits know who is calling. */
export const CLIENT_IP_HEADER = "x-savin-client-ip";

/** The session secret: BETTER_AUTH_SECRET when set, otherwise a random one kept next to the data. */
function secretFrom(file: string) {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET;
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
  return readFileSync(file, "utf8").trim();
}

/**
 * Accounts the way savin does them: Better Auth with email and password, signed in right after
 * sign-up. Everything stays on this machine, in a SQLite file beside the rest of the data.
 */
export async function createAuth(options: {
  dataDir: string;
  /** The pages allowed to sign in: this app's own addresses. */
  origins: string[];
  /** Sets up a new account, such as its first space. */
  onUserCreated: (user: AuthUser) => Promise<void>;
  database?: DatabaseSync;
  /** Slows down repeated sign-in attempts; tests that sign in many times turn it off. */
  rateLimit?: boolean;
}) {
  const config = {
    appName: "savin Social",
    database: options.database ?? new DatabaseSync(join(options.dataDir, "auth.db")),
    secret: secretFrom(join(options.dataDir, "auth.secret")),
    // The app answers on more than one local address (the dev server and the built one).
    baseURL: {
      allowedHosts: options.origins.map((origin) => new URL(origin).host),
      fallback: options.origins.at(-1),
      protocol: "http",
    },
    basePath: "/api/auth",
    trustedOrigins: options.origins,
    emailAndPassword: { enabled: true, minPasswordLength: 8, autoSignIn: true },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await options.onUserCreated({ id: user.id, name: user.name, email: user.email });
          },
        },
      },
    },
    advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
    // On in every mode, not only in production, so guessing a password stays slow.
    rateLimit: { enabled: options.rateLimit ?? true, window: 60, max: 100 },
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions;
  const { runMigrations } = await getMigrations(config);
  await runMigrations();
  return betterAuth(config);
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;

/** The signed-in person for a request, or null. */
export async function userOf(auth: Auth, headers: Headers): Promise<AuthUser | null> {
  const session = await auth.api.getSession({ headers }).catch(() => null);
  return session ? { id: session.user.id, name: session.user.name, email: session.user.email } : null;
}

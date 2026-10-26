import { randomUUID } from "node:crypto";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { SignInBegin, SignInStatus } from "../../shared/contracts.ts";
import { signIns } from "./catalog.ts";

/** Runs a provider's own sign-in for an account and stores the credential it returns. */
export type Login = (userId: string, provider: string, interaction: AuthInteraction) => Promise<unknown>;

type Started = SignInBegin extends infer Begin
  ? Begin extends unknown
    ? Omit<Begin, "loginId" | "provider">
    : never
  : never;
type Session = {
  id: string;
  userId: string;
  provider: string;
  abort: AbortController;
  status: SignInStatus;
  /** Set while a sign-in that ends on a pasted code is waiting for it. */
  submitCode?: (code: string) => void;
  timer?: NodeJS.Timeout;
};

const START_TIMEOUT_MS = 30_000;
const DEFAULT_EXPIRY_S = 15 * 60;
const message = (error: unknown) => (error instanceof Error ? error.message : "Subscription sign-in failed.");

function https(url: string) {
  if (new URL(url).protocol !== "https:") throw new Error("Authorization URL must use HTTPS.");
  return url;
}

/**
 * Subscription sign-ins in progress, as in savin: the provider's flow waits in the background
 * while the person enters a device code (or finishes a link and pastes back the code) in their browser.
 */
export class SignIns {
  private sessions = new Map<string, Session>();

  constructor(private readonly login: Login) {}

  async begin(userId: string, provider: string, onConnected: () => Promise<void>): Promise<SignInBegin> {
    if (!signIns[provider]) {
      throw new Error(
        "In-app subscription sign-in is only available for ChatGPT Plus/Pro, Claude Pro/Max, GitHub Copilot, and SuperGrok.",
      );
    }
    // A new sign-in replaces one still waiting for the same account and provider.
    for (const other of this.sessions.values()) {
      if (other.userId === userId && other.provider === provider) this.end(other, "Sign-in replaced.");
    }
    const session: Session = {
      id: randomUUID(),
      userId,
      provider,
      abort: new AbortController(),
      status: { status: "pending" },
    };
    this.sessions.set(session.id, session);
    const { signal } = session.abort;

    let started!: (info: Started) => void;
    let failed!: (error: unknown) => void;
    const ready = new Promise<Started>((resolve, reject) => {
      started = resolve;
      failed = reject;
    });
    const interaction: AuthInteraction = {
      signal,
      async prompt(prompt) {
        if (prompt.type === "select") {
          const option = prompt.options.find((entry) => entry.id === "device_code");
          if (!option) throw new Error("Device-code sign-in is not available for this provider.");
          return option.id;
        }
        // GitHub Copilot asks for a GitHub Enterprise host first; blank means github.com.
        if (prompt.type === "text") return "";
        if (prompt.type !== "manual_code") throw new Error("Unexpected sign-in prompt.");
        return new Promise<string>((resolve, reject) => {
          const signals = [signal, prompt.signal].filter((entry): entry is AbortSignal => Boolean(entry));
          let removals: (() => void)[] = [];
          const stop = () => {
            session.submitCode = undefined;
            for (const remove of removals) remove();
            removals = [];
          };
          // Each listener keeps its own signal: an abort listener must never throw, or the server stops.
          removals = signals.map((entry) => {
            const onAbort = () => {
              stop();
              reject(entry.reason ?? new Error("Sign-in cancelled."));
            };
            entry.addEventListener("abort", onAbort, { once: true });
            return () => entry.removeEventListener("abort", onAbort);
          });
          const aborted = signals.find((entry) => entry.aborted);
          if (aborted) {
            stop();
            reject(aborted.reason ?? new Error("Sign-in cancelled."));
            return;
          }
          session.submitCode = (code) => {
            stop();
            resolve(code);
          };
        });
      },
      notify(event) {
        try {
          if (event.type === "device_code") {
            started({
              mode: "device-code",
              userCode: event.userCode,
              verificationUri: https(event.verificationUri),
              expiresInSeconds: event.expiresInSeconds ?? DEFAULT_EXPIRY_S,
            });
          } else if (event.type === "auth_url") {
            started({ mode: "auth-url", verificationUri: https(event.url), expiresInSeconds: DEFAULT_EXPIRY_S });
          }
        } catch (error) {
          failed(error);
        }
      },
    };

    void this.login(userId, provider, interaction)
      .then(onConnected)
      .then(() => {
        session.status = { status: "connected" };
      })
      .catch((error: unknown) => {
        session.status = { status: "error", error: message(error) };
        failed(error);
      })
      .finally(() => {
        // Keep the outcome around long enough for the waiting page to read it.
        clearTimeout(session.timer);
        session.timer = setTimeout(() => this.sessions.delete(session.id), 10 * 60_000);
        session.timer.unref();
      });

    const timeout = setTimeout(
      () => failed(new Error("Subscription sign-in did not start. Try again.")),
      START_TIMEOUT_MS,
    );
    try {
      const info = await ready;
      session.timer = setTimeout(() => this.end(session, "Sign-in expired."), info.expiresInSeconds * 1000);
      session.timer.unref();
      return { loginId: session.id, provider, ...info };
    } catch (error) {
      this.end(session, message(error));
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  status(userId: string, loginId: string): SignInStatus {
    const session = this.sessions.get(loginId);
    if (!session || session.userId !== userId) {
      return { status: "error", error: "Sign-in session not found. Start sign-in again." };
    }
    if (session.status.status !== "pending") this.sessions.delete(loginId);
    return session.status;
  }

  /** The pasted authorization code or callback URL, for sign-ins that end on a link. */
  submit(userId: string, loginId: string, code: string) {
    const session = this.sessions.get(loginId);
    if (!session || session.userId !== userId) throw new Error("Sign-in session not found. Start sign-in again.");
    if (session.status.status === "error") throw new Error(session.status.error);
    if (!code.trim()) throw new Error("Paste an authorization code or callback URL.");
    if (!session.submitCode) throw new Error("This sign-in is not waiting for a pasted code.");
    session.submitCode(code.trim());
  }

  cancel(userId: string, loginId: string) {
    const session = this.sessions.get(loginId);
    if (session?.userId === userId) this.end(session, "Sign-in cancelled.");
  }

  /** Stops every sign-in an account has waiting for a provider, before it is disconnected. */
  cancelProvider(userId: string, provider: string) {
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.provider === provider) this.end(session, "Sign-in cancelled.");
    }
  }

  private end(session: Session, reason: string) {
    clearTimeout(session.timer);
    session.abort.abort(new Error(reason));
    this.sessions.delete(session.id);
  }

  close() {
    for (const session of [...this.sessions.values()]) this.end(session, "Server stopped.");
  }
}

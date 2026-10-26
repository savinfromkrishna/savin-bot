import type { FormEvent } from "react";
import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { Loading } from "../lib/account.tsx";
import { authClient } from "../lib/auth.ts";
import { Logo } from "../shell/logo.tsx";
import { Button, Field, Input } from "../ui.tsx";

const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** savin's sign-in and sign-up page: email and password, signed in right after sign-up. */
export function AuthPage({ mode }: { mode: "in" | "up" }) {
  const session = authClient.useSession();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session.isPending) return <Loading />;
  if (session.data && !busy) return <Navigate to={mode === "up" ? "/onboarding" : "/app"} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!validEmail.test(address)) return setError("Enter a valid email");
    if (!password) return setError("Enter a password");
    setBusy(true);
    setError(null);
    try {
      try {
        localStorage.removeItem("space-id");
      } catch {}
      const result =
        mode === "up"
          ? await authClient.signUp.email({
              name: name.trim() || address.split("@")[0] || "User",
              email: address,
              password,
            })
          : await authClient.signIn.email({ email: address, password });
      if (result.error) throw new Error(result.error.message || "Could not continue");
      await session.refetch();
      navigate(mode === "up" ? "/onboarding" : "/app", { replace: true });
    } catch (failure) {
      setError(failure instanceof TypeError ? "Could not reach the server" : (failure as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="grid h-full place-items-center overflow-y-auto bg-background px-6 py-10">
      <form onSubmit={submit} className="w-full max-w-sm" noValidate>
        <div className="flex flex-col items-center text-center">
          <Logo className="size-11" />
          <h1 className="mt-5 text-2xl font-semibold tracking-tight">
            {mode === "up" ? "Create your savin Social" : "Sign in to savin Social"}
          </h1>
        </div>
        <div className="mt-8 space-y-4">
          {mode === "up" ? (
            <Field label="Name">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Your name"
                autoComplete="name"
              />
            </Field>
          ) : null}
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Your email address"
              autoComplete="email"
              required
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              autoComplete={mode === "up" ? "new-password" : "current-password"}
              minLength={8}
              required
            />
          </Field>
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" className="h-10 w-full rounded-full text-[14px]" busy={busy}>
            {busy ? "Working…" : mode === "up" ? "Create account" : "Continue with email"}
          </Button>
        </div>
        <p className="mt-6 text-center text-[13px] text-muted-foreground">
          {mode === "up" ? "Already have an account? " : "Don’t have an account? "}
          <Link to={mode === "up" ? "/sign-in" : "/sign-up"} className="font-medium text-foreground hover:underline">
            {mode === "up" ? "Sign in" : "Sign up"}
          </Link>
        </p>
      </form>
    </main>
  );
}

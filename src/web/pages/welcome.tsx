import { ArrowRight } from "lucide-react";
import { Link, Navigate } from "react-router-dom";
import { Loading } from "../lib/account.tsx";
import { authClient } from "../lib/auth.ts";
import { Logo } from "../shell/logo.tsx";

/** What a signed-out visitor sees first, as in savin. */
export function WelcomePage() {
  const session = authClient.useSession();
  if (session.isPending) return <Loading />;
  if (session.data) return <Navigate to="/app" replace />;
  return (
    <main className="grid h-full place-items-center bg-background px-6">
      <div className="flex flex-col items-center text-center">
        <Logo className="size-14" />
        <h1 className="mt-5 text-3xl font-semibold tracking-tight">savin Social</h1>
        <p className="mt-3 max-w-sm text-[15px] text-muted-foreground">
          Your team of always-on bots
          <br />
          for YouTube and social media.
        </p>
        <Link
          to="/sign-up"
          className="mt-8 inline-flex h-10 items-center gap-2 rounded-full bg-primary px-6 text-[14px] font-medium text-primary-foreground hover:opacity-90"
        >
          Sign up <ArrowRight className="size-4" />
        </Link>
        <Link to="/sign-in" className="mt-4 text-[13px] text-muted-foreground hover:text-foreground">
          Sign in
        </Link>
      </div>
    </main>
  );
}

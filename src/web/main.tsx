import "./styles.css";
import type { ReactNode } from "react";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AccountProvider, Loading, useAccount } from "./lib/account.tsx";
import { authClient } from "./lib/auth.ts";
import { LiveProvider } from "./lib/live.tsx";
import { AuthPage } from "./pages/auth-page.tsx";
import { OnboardingPage } from "./pages/onboarding.tsx";
import { WelcomePage } from "./pages/welcome.tsx";
import { AppShell } from "./shell/app-shell.tsx";

/** Pages that need a session; without one the person goes to sign in. */
function SignedIn({ children }: { children: ReactNode }) {
  const session = authClient.useSession();
  useEffect(() => {
    const signedOut = () => window.location.assign("/sign-in");
    window.addEventListener("signed-out", signedOut);
    return () => window.removeEventListener("signed-out", signedOut);
  }, []);
  if (session.isPending) return <Loading />;
  if (!session.data) return <Navigate to="/sign-in" replace />;
  return <AccountProvider>{children}</AccountProvider>;
}

/** The open space's live view; switching spaces starts it fresh. */
function SpaceApp() {
  const { space } = useAccount();
  return (
    <LiveProvider key={space.id}>
      <AppShell />
    </LiveProvider>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<WelcomePage />} />
          <Route path="/sign-in" element={<AuthPage mode="in" />} />
          <Route path="/sign-up" element={<AuthPage mode="up" />} />
          <Route
            path="/onboarding"
            element={
              <SignedIn>
                <OnboardingPage />
              </SignedIn>
            }
          />
          <Route
            path="/app/*"
            element={
              <SignedIn>
                <SpaceApp />
              </SignedIn>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </StrictMode>,
  );
}

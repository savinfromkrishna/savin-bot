import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Me, SpaceSummary } from "../../shared/contracts.ts";
import { Button, Spinner } from "../ui.tsx";
import { accountApi, setSpace } from "./api.ts";

type Account = {
  me: Me;
  /** The space the app is showing. */
  space: SpaceSummary;
  refresh: () => Promise<void>;
  switchSpace: (id: string) => void;
};

const AccountContext = createContext<Account | null>(null);

export function useAccount() {
  const account = useContext(AccountContext);
  if (!account) throw new Error("useAccount outside AccountProvider");
  return account;
}

const SPACE_KEY = "space-id";
const savedSpace = () => {
  try {
    return localStorage.getItem(SPACE_KEY);
  } catch {
    return null;
  }
};

export const Loading = ({ label }: { label?: string }) => (
  <div className="grid h-full place-items-center text-muted-foreground">
    <span className="flex items-center gap-2 text-[13px]">
      <Spinner className="size-4" /> {label}
    </span>
  </div>
);

/** Who is signed in and their spaces; the open space is remembered between visits. */
export function AccountProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(savedSpace);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(async () => setMe(await accountApi<Me>("GET", "/me")), []);

  useEffect(() => {
    refresh().catch(() => setFailed(true));
  }, [refresh]);

  if (!me) {
    return failed ? (
      <div className="grid h-full place-items-center">
        <div className="space-y-3 text-center">
          <p className="text-[13px] text-muted-foreground">Can't reach the server.</p>
          <Button
            onClick={() => {
              setFailed(false);
              refresh().catch(() => setFailed(true));
            }}
          >
            Retry now
          </Button>
        </div>
      </div>
    ) : (
      <Loading label="Opening your Space…" />
    );
  }
  const space = me.spaces.find((candidate) => candidate.id === spaceId) ?? me.spaces[0];
  if (!space) return <Loading />;
  // Before the children render, so their first calls already go to this space.
  setSpace(space.id);

  const switchSpace = (id: string) => {
    try {
      localStorage.setItem(SPACE_KEY, id);
    } catch {}
    setSpaceId(id);
  };
  return <AccountContext.Provider value={{ me, space, refresh, switchSpace }}>{children}</AccountContext.Provider>;
}

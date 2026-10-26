import { Menu } from "lucide-react";
import type { ReactNode } from "react";
import { createContext, lazy, Suspense, useContext, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { GroupPage, NewGroupDialog } from "../groups/group-page.tsx";
import { useLive } from "../lib/live.tsx";
import { useOverlay } from "../lib/overlay.ts";
import { ActivityPage } from "../pages/activity-page.tsx";
import { ApplicationsPage } from "../pages/applications-page.tsx";
import { GrowthPage } from "../pages/growth-page.tsx";
import { ThreadPage } from "../thread/thread-page.tsx";
import { Button, Spinner } from "../ui.tsx";
import { NewBotDialog, NewSpaceDialog } from "./create-dialogs.tsx";
import { Sidebar } from "./sidebar.tsx";

// Heavy, occasional views load on first use, so opening a chat stays light.
const ComputerOverlay = lazy(() =>
  import("../computer/overlay.tsx").then((module) => ({ default: module.ComputerOverlay })),
);
const IntegrationsDialog = lazy(() =>
  import("../integrations/integrations-dialog.tsx").then((module) => ({ default: module.IntegrationsDialog })),
);
const SettingsDialog = lazy(() =>
  import("../settings/settings-dialog.tsx").then((module) => ({ default: module.SettingsDialog })),
);
const RoutineEditor = lazy(() =>
  import("../panel/routine-editor.tsx").then((module) => ({ default: module.RoutineEditor })),
);
const CanvasPage = lazy(() => import("../pages/canvas-page.tsx").then((module) => ({ default: module.CanvasPage })));

const DrawerContext = createContext<() => void>(() => {});

/** The sidebar as an icon rail: as last chosen, or by default on narrower screens. Remembered per browser. */
function useRail() {
  const [rail, setRail] = useState(() => {
    try {
      const saved = localStorage.getItem("sidebar:rail");
      if (saved !== null) return saved === "true";
    } catch {}
    return window.innerWidth < 1100;
  });
  return {
    rail,
    toggle() {
      setRail(!rail);
      try {
        localStorage.setItem("sidebar:rail", String(!rail));
      } catch {}
    },
  };
}

/** The header every page shares; on phones it carries the button that opens the bot list. */
export function PageHeader({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  const openDrawer = useContext(DrawerContext);
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 md:px-5">
      <Button variant="ghost" size="icon" className="md:hidden" onClick={openDrawer} aria-label="Open bots">
        <Menu className="size-4" />
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </header>
  );
}

export function AppShell() {
  const { state, connected } = useLive();
  const overlay = useOverlay();
  const [drawer, setDrawer] = useState(false);
  const { rail, toggle } = useRail();

  if (!state) {
    return (
      <div className="grid h-full place-items-center text-muted-foreground">
        <Spinner className="size-5" />
      </div>
    );
  }

  return (
    <DrawerContext.Provider value={() => setDrawer(true)}>
      <div className="flex h-full overflow-hidden">
        <div className="hidden md:block">
          <Sidebar collapsed={rail} onToggle={toggle} />
        </div>
        {drawer ? (
          // biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop closes the drawer
          <div
            className="fixed inset-0 z-40 bg-[var(--overlay)] md:hidden"
            onMouseDown={(event) => event.target === event.currentTarget && setDrawer(false)}
          >
            <div className="h-full w-[300px] max-w-[85vw] shadow-2xl">
              <Sidebar onNavigate={() => setDrawer(false)} />
            </div>
          </div>
        ) : null}
        <main className="flex min-w-0 flex-1 flex-col bg-background">
          {connected ? null : (
            <div className="bg-destructive/10 px-4 py-1.5 text-center text-xs text-destructive">Reconnecting…</div>
          )}
          <Routes>
            <Route
              index
              element={
                <Suspense fallback={null}>
                  <CanvasPage />
                </Suspense>
              }
            />
            <Route path="activity" element={<ActivityPage />} />
            <Route path="applications" element={<ApplicationsPage />} />
            <Route path="growth" element={<GrowthPage />} />
            <Route path="bots/:botId" element={<ThreadPage />} />
            <Route path="g/:groupId" element={<GroupPage />} />
            <Route path="*" element={<Navigate to="/app" replace />} />
          </Routes>
        </main>
      </div>
      <Suspense fallback={null}>
        {overlay.settings ? <SettingsDialog section={overlay.settings} /> : null}
        {overlay.integrations ? <IntegrationsDialog view={overlay.integrations} /> : null}
        {overlay.routine ? <RoutineEditor id={overlay.routine} /> : null}
        {overlay.computer ? <ComputerOverlay botId={overlay.computer} /> : null}
      </Suspense>
      {overlay.create === "bot" ? <NewBotDialog onClose={() => overlay.set({ create: null })} /> : null}
      {overlay.create === "space" ? <NewSpaceDialog onClose={() => overlay.set({ create: null })} /> : null}
      {overlay.create === "group" ? <NewGroupDialog onClose={() => overlay.set({ create: null })} /> : null}
    </DrawerContext.Provider>
  );
}

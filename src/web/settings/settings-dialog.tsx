import { BrainCircuit, Gauge, Globe, Palette, Settings, UserRound, X } from "lucide-react";
import type { ReactNode } from "react";
import { useAppState } from "../lib/live.tsx";
import { useOverlay } from "../lib/overlay.ts";
import { Button, cx, Dialog } from "../ui.tsx";
import { BrandSettings } from "./brand.tsx";
import { BrowserSettings } from "./browsers.tsx";
import { CandidateSettings } from "./candidate.tsx";
import { GeneralSettings } from "./general.tsx";
import { ModelSettings } from "./models.tsx";
import { UsageSettings } from "./usage.tsx";

const allSections = [
  { id: "general", label: "General", icon: Settings },
  { id: "brand", label: "Brand", icon: Palette },
  { id: "candidate", label: "Candidate", icon: UserRound },
  { id: "models", label: "Models", icon: BrainCircuit },
  { id: "browsers", label: "Browsers", icon: Globe },
  { id: "usage", label: "Usage", icon: Gauge },
] as const;

/** A job search space has a candidate instead of a brand, and one browser. */
const sectionsFor = (kind: "social" | "jobs") =>
  allSections.filter((section) =>
    kind === "jobs" ? section.id !== "brand" && section.id !== "browsers" : section.id !== "candidate",
  );

export function SettingsPage({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{title}</h2>
        {description ? <p className="mt-1 text-[13px] text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}

export function SettingsDialog({ section }: { section: string }) {
  const overlay = useOverlay();
  const state = useAppState();
  const close = () => overlay.set({ settings: null });
  const sections = sectionsFor(state.space.kind);
  const current = sections.find((entry) => entry.id === section) ?? allSections[0];
  return (
    <Dialog title="Settings" onClose={close} wide>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-3 md:w-52 md:flex-col md:border-r md:border-b-0">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => overlay.set({ settings: id })}
              className={cx(
                "flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-3 text-[13px]",
                id === current.id
                  ? "bg-muted font-medium"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </nav>
        <div className="relative min-h-0 flex-1 overflow-y-auto px-5 py-6 md:px-8">
          <Button variant="ghost" size="icon" onClick={close} aria-label="Close" className="absolute top-4 right-4">
            <X className="size-4" />
          </Button>
          {current.id === "general" ? <GeneralSettings /> : null}
          {current.id === "brand" ? <BrandSettings /> : null}
          {current.id === "candidate" ? <CandidateSettings /> : null}
          {current.id === "models" ? <ModelSettings /> : null}
          {current.id === "browsers" ? <BrowserSettings /> : null}
          {current.id === "usage" ? <UsageSettings /> : null}
        </div>
      </div>
    </Dialog>
  );
}

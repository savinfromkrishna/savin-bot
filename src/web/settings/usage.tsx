import { useAppState } from "../lib/live.tsx";
import { SettingsPage } from "./settings-dialog.tsx";

const number = new Intl.NumberFormat();

export function UsageSettings() {
  const { usage } = useAppState();
  return (
    <SettingsPage title="Usage">
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: "Runs", value: usage.runs },
          { label: "Input tokens", value: usage.inputTokens },
          { label: "Output tokens", value: usage.outputTokens },
        ].map((stat) => (
          <div key={stat.label} className="rounded-2xl border border-border p-4">
            <p className="text-xs text-muted-foreground">{stat.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{number.format(stat.value)}</p>
          </div>
        ))}
      </div>
    </SettingsPage>
  );
}

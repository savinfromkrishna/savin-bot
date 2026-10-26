import { cx } from "../ui.tsx";

/** The app mark: a lead and two teammates. */
export function Logo({ className, inverted }: { className?: string; inverted?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cx("shrink-0", className)} aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="currentColor" />
      <circle cx="11" cy="16" r="4" className={inverted ?? "fill-background"} />
      <circle cx="22" cy="9.5" r="3" className={inverted ?? "fill-background"} />
      <circle cx="22" cy="22.5" r="3" className={inverted ?? "fill-background"} />
    </svg>
  );
}

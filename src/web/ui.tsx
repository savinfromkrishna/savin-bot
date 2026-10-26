import { ChevronDown, LoaderCircle, X } from "lucide-react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { useEffect, useRef, useState } from "react";

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

const buttonVariants = {
  primary: "bg-primary text-primary-foreground hover:opacity-90",
  outline: "border border-border bg-card hover:bg-muted",
  ghost: "hover:bg-muted",
  warning: "border border-warning/60 text-warning hover:bg-warning/10",
  danger: "text-destructive hover:bg-destructive/10",
};

const buttonSizes = {
  default: "h-8 px-3 text-[13px]",
  sm: "h-7 px-2.5 text-xs",
  icon: "size-8",
};

export function Button({
  variant = "outline",
  size = "default",
  busy,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof buttonVariants;
  size?: keyof typeof buttonSizes;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:pointer-events-none disabled:opacity-50",
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      disabled={busy || props.disabled}
    >
      {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
      {children}
    </button>
  );
}

const field =
  "w-full rounded-lg border border-input bg-card px-3 text-[13px] outline-none placeholder:text-muted-foreground focus:border-foreground/40 focus:ring-2 focus:ring-foreground/10";

export const Input = ({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
  <input className={cx(field, "h-9", className)} {...props} />
);

export const Textarea = ({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea className={cx(field, "resize-y py-2 leading-relaxed", className)} {...props} />
);

export const Select = ({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select className={cx(field, "h-9 pr-8", className)} {...props} />
);

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control arrives as children
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/** A row of choices; `wide` makes them fill the row like savin's large toggles. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  wide,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  wide?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx("gap-1.5", wide ? "grid grid-flow-col auto-cols-fr" : "inline-flex")}
    >
      {options.map((option) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control drawn with buttons
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx(
            "rounded-lg border px-3 font-medium transition",
            wide ? "h-9 text-[13px]" : "h-7 text-xs",
            value === option.value
              ? "border-foreground/50 bg-muted text-foreground"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx("relative h-5 w-9 shrink-0 rounded-full transition", checked ? "bg-primary" : "bg-input")}
    >
      <span
        className={cx(
          "absolute top-0.5 size-4 rounded-full bg-card shadow transition-all",
          checked ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

/** A labelled switch row with an optional description, as in savin's settings. */
export function SwitchRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{label}</span>
        {description ? <span className="block text-xs text-muted-foreground">{description}</span> : null}
      </span>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="tablist" className="inline-flex rounded-lg bg-muted p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx(
            "h-7 rounded-md px-3 text-xs font-medium transition",
            value === option.value
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Disclosure({
  label,
  children,
  defaultOpen,
}: {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="group" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center justify-between py-1 text-[13px] text-muted-foreground hover:text-foreground">
        {label}
        <ChevronDown className="size-4 transition group-open:rotate-180" />
      </summary>
      <div className="space-y-5 pt-3">{children}</div>
    </details>
  );
}

export function Dialog({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop closes the dialog
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[var(--overlay)] p-3 sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cx(
          "flex max-h-full w-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl outline-none",
          wide ? "h-[min(760px,100%)] max-w-5xl" : "max-w-lg",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function DialogClose({ onClose }: { onClose: () => void }) {
  return (
    <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
      <X className="size-4" />
    </Button>
  );
}

export function Section({ title, children, aside }: { title?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-3">
      {title ? (
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-semibold">{title}</h3>
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** A small menu that opens from a button and closes on a click outside or Escape. */
export function Menu({
  trigger,
  label,
  children,
  align = "start",
  up,
  className,
}: {
  trigger: ReactNode;
  label: string;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
  up?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => !root.current?.contains(event.target as Node) && setOpen(false);
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={root} className={cx("relative", className)}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center"
      >
        {trigger}
      </button>
      {open ? (
        <div
          role="menu"
          className={cx(
            "absolute z-50 min-w-48 rounded-xl border border-border bg-card p-1 shadow-xl",
            align === "end" ? "right-0" : "left-0",
            up ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  onSelect,
  children,
  danger,
}: {
  onSelect: () => void;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={cx(
        "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] hover:bg-muted",
        danger && "text-destructive",
      )}
    >
      {children}
    </button>
  );
}

export const Spinner = ({ className }: { className?: string }) => (
  <LoaderCircle className={cx("size-3.5 animate-spin", className)} />
);

export const ErrorText = ({ error }: { error: string | null | undefined }) =>
  error ? <p className="text-xs text-destructive">{error}</p> : null;

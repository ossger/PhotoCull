import { useEffect, useRef, useState, type ReactNode } from "react";

export interface DropdownItem {
  label: string;
  onSelect: () => void;
  hint?: string;
  disabled?: boolean;
  checked?: boolean;
}

// A small click-to-open menu. `trigger` renders the button contents; the
// button itself is styled by the caller via `buttonClass`.
export function Dropdown({
  trigger,
  items,
  buttonClass,
  title,
  align = "left",
}: {
  trigger: ReactNode;
  items: DropdownItem[];
  buttonClass: string;
  title?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        type="button"
        title={title}
        onClick={() => setOpen((o) => !o)}
        className={buttonClass}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute top-full mt-1 z-40 min-w-[11rem] py-1 rounded-md border border-line bg-panel2 shadow-lg ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
              className="w-full flex items-center justify-between gap-6 px-3 py-1.5 text-left text-sm hover:bg-line disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <span>
                {it.checked !== undefined && (
                  <span className="inline-block w-4 text-accent">{it.checked ? "✓" : ""}</span>
                )}
                {it.label}
              </span>
              {it.hint && <span className="text-xs text-muted">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

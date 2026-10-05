import { useCallback, useState } from "react";

// A number kept in localStorage (clamped to [min, max]). Storage failures —
// private mode, quota, a blocked origin — fall back to the default silently;
// the value is a convenience, never state that must survive.
export function usePersistentNumber(
  key: string,
  fallback: number,
  min: number,
  max: number,
): [number, (next: number) => void] {
  const clampTo = useCallback((v: number) => Math.round(Math.max(min, Math.min(max, v))), [min, max]);

  const [value, setValue] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(key);
      const n = raw == null ? NaN : Number(raw);
      return Number.isFinite(n) ? clampTo(n) : fallback;
    } catch {
      return fallback;
    }
  });

  const set = useCallback(
    (next: number) => {
      const v = clampTo(next);
      setValue(v);
      try {
        localStorage.setItem(key, String(v));
      } catch {
        // ignore storage failures (private mode, quota, etc.)
      }
    },
    [key, clampTo],
  );

  return [value, set];
}

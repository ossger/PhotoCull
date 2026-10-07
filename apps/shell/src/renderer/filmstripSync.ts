import { useEffect } from "react";
import type { FilmstripAction, FilmstripActionName, StoreSyncSnapshot } from "@shared/types";
import { useStore } from "./store";

// Keeps the torn-off filmstrip window's store in step with the main window's.
//
// The main window is the only authority — it alone talks to the worker. It
// mirrors the plain-data slices below into the pop-out (a full snapshot when
// asked, then just the slices whose reference changed). The pop-out never
// mutates those slices itself: its store actions are swapped for forwarders
// that ask the main window to run the real action, and its keypresses are
// replayed there through the normal hotkey handler. The result comes back as
// the next snapshot. Everything rides the main-process relay in main.ts.

// Slices the pop-out needs to render the same frames, in the same order,
// with the same selection / compare / rating state as the main window.
const SYNC_KEYS = [
  "shootRoot",
  "images",
  "scenes",
  "selectedSceneId",
  "selectedSceneIds",
  "selectedImageId",
  "selectedIds",
  "rangeAnchorId",
  "compareMode",
  "compareIds",
  "compareSyncZoom",
  "sortMode",
  "filters",
  "viewScope",
  "loading",
  "progress",
] as const;

type StoreState = ReturnType<typeof useStore.getState>;
type SyncKey = (typeof SYNC_KEYS)[number];

const FORWARDED_ACTIONS: readonly FilmstripActionName[] = [
  "selectImage",
  "selectScene",
  "toggleScene",
  "selectSceneRange",
  "toggleSelect",
  "selectRange",
  "extendRange",
  "setSelection",
  "selectAllInScene",
  "clearSelection",
  "toggleCompare",
  "toggleCompareMember",
  "exitCompare",
  "setPickMany",
  "setStarsMany",
];
const FORWARDED_SET = new Set<string>(FORWARDED_ACTIONS);

function snapshotOf(s: StoreState, prev?: StoreState): StoreSyncSnapshot {
  const out: StoreSyncSnapshot = {};
  for (const k of SYNC_KEYS) {
    if (!prev || prev[k] !== s[k]) out[k] = s[k];
  }
  return out;
}

export const isFilmstripWindow = (): boolean => window.location.hash === "#filmstrip";

// ----- main-window side -----

function runAction(action: FilmstripAction): void {
  if (action.kind === "call") {
    if (!FORWARDED_SET.has(action.name) || !Array.isArray(action.args)) return;
    const fn = useStore.getState()[action.name] as (...args: unknown[]) => unknown;
    Promise.resolve(fn(...action.args)).catch((err: unknown) => {
      useStore.setState({ error: err instanceof Error ? err.message : String(err) });
    });
    return;
  }
  if (action.kind === "key" && typeof action.key === "string") {
    // Replayed on window, where useHotkeys (and the loupe's Space handler)
    // listen — so every hotkey behaves exactly as if pressed here.
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: action.key,
        code: action.code,
        shiftKey: !!action.shiftKey,
        metaKey: !!action.metaKey,
        ctrlKey: !!action.ctrlKey,
        altKey: !!action.altKey,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
}

/** Main window: track pop-out state and, while popped out, feed it. */
export function useFilmstripHost(): void {
  const poppedOut = useStore((s) => s.filmstripPoppedOut);
  const setPoppedOut = useStore((s) => s.setFilmstripPoppedOut);

  useEffect(() => {
    const off = window.photocull.onFilmstripPoppedOut(setPoppedOut);
    // After a main-window reload the pop-out may already be open.
    window.photocull
      .isFilmstripPoppedOut()
      .then(setPoppedOut)
      .catch(() => undefined);
    return off;
  }, [setPoppedOut]);

  useEffect(() => {
    if (!poppedOut) return;
    const sendFull = () => window.photocull.sendStoreSync(snapshotOf(useStore.getState()));
    const offRequest = window.photocull.onStoreSyncRequest(sendFull);
    const offAction = window.photocull.onFilmstripAction(runAction);
    const unsubscribe = useStore.subscribe((s, prev) => {
      const diff = snapshotOf(s, prev);
      if (Object.keys(diff).length > 0) window.photocull.sendStoreSync(diff);
    });
    // Covers a pop-out that asked before this listener was ready.
    sendFull();
    return () => {
      offRequest();
      offAction();
      unsubscribe();
    };
  }, [poppedOut]);
}

// ----- pop-out side -----

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
}

/**
 * Pop-out window: call once before rendering. Swaps the local store's
 * mutating actions for forwarders, applies incoming snapshots, forwards
 * keypresses, and asks the main window for a first full snapshot.
 */
export function initFilmstripClient(): void {
  const forwarders: Record<string, (...args: unknown[]) => void> = {};
  for (const name of FORWARDED_ACTIONS) {
    forwarders[name] = (...args: unknown[]) =>
      window.photocull.sendFilmstripAction({ kind: "call", name, args });
  }
  useStore.setState(forwarders as unknown as Partial<StoreState>);

  window.photocull.onStoreSync((snapshot) => {
    const patch: Partial<Record<SyncKey, unknown>> = {};
    for (const k of SYNC_KEYS) {
      if (Object.prototype.hasOwnProperty.call(snapshot, k)) patch[k] = snapshot[k];
    }
    useStore.setState(patch as Partial<StoreState>);
  });

  window.addEventListener("keydown", (e) => {
    if (isTyping(e.target)) return;
    // Leave the OS/menu shortcuts (⌘W, ⌘Q, ⌘R, …) alone — except ⌘/Ctrl+A,
    // which is the app's select-all.
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() !== "a") return;
    if (["Shift", "Meta", "Control", "Alt", "Tab"].includes(e.key)) return;
    e.preventDefault(); // no arrow/space scrolling of the grid, no text select-all
    window.photocull.sendFilmstripAction({
      kind: "key",
      key: e.key,
      code: e.code,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
    });
  });

  // The preload fetches the worker handshake asynchronously; thumbnail URLs
  // are empty until it lands, so hold the first snapshot request until then
  // (bounded — after ~2 s ask anyway).
  let tries = 0;
  const request = () => {
    if (window.photocull.thumbUrl("probe") === "" && tries++ < 40) {
      window.setTimeout(request, 50);
      return;
    }
    window.photocull.requestStoreSync();
  };
  request();
}

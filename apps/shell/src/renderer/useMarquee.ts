import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "./store";

// Click-drag rubber-band selection, shared by the filmstrip and the grid
// view, plus the modifier-key click semantics (cmd/ctrl toggle, shift range,
// cmd+shift extend-range) both surfaces dispatch identically.

export interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const DRAG_THRESHOLD = 4; // px before an ordinary click becomes a marquee drag
const EDGE_ZONE = 40; // px from an edge that triggers auto-scroll
const EDGE_SPEED = 16; // max px scrolled per animation frame

interface DragState {
  originX: number; // content coords: client point + scroll offset at drag start
  originY: number;
  baseSelection: number[]; // selection when the drag started
  unionMode: boolean; // cmd/ctrl/shift held when the drag started
  started: boolean; // crossed DRAG_THRESHOLD — an actual marquee, not a click
}

// Content-space (scroll-independent) point, so the rect stays anchored to
// the content under the cursor even while auto-scroll moves the container.
function toContent(container: HTMLElement, clientX: number, clientY: number) {
  const rect = container.getBoundingClientRect();
  return {
    x: clientX - rect.left + container.scrollLeft,
    y: clientY - rect.top + container.scrollTop,
  };
}

// Hit-tests every child carrying data-image-id (set by both the filmstrip
// and the grid, also used for scrollIntoView) against the marquee rect.
// offsetLeft/Top are relative to the container (must be position: relative)
// and are scroll-invariant, matching the content-space coords above.
function hitIds(container: HTMLElement, rect: MarqueeRect): number[] {
  const hits: number[] = [];
  container.querySelectorAll<HTMLElement>("[data-image-id]").forEach((el) => {
    const left = el.offsetLeft;
    const top = el.offsetTop;
    const right = left + el.offsetWidth;
    const bottom = top + el.offsetHeight;
    const overlaps =
      left < rect.left + rect.width &&
      right > rect.left &&
      top < rect.top + rect.height &&
      bottom > rect.top;
    if (overlaps) {
      const id = Number(el.dataset.imageId);
      if (!Number.isNaN(id)) hits.push(id);
    }
  });
  return hits;
}

interface UseMarqueeResult {
  onPointerDown: React.PointerEventHandler<HTMLDivElement>;
  // Swallows the trailing click after a real drag so it doesn't also fire
  // the thumbnail's own onClick. Wire to the same container as onPointerDown.
  onClickCapture: React.MouseEventHandler<HTMLDivElement>;
  marqueeRect: MarqueeRect | null;
  // What the selection would be if the drag committed right now (union-mode
  // aware). Null when not dragging — callers fall back to the store's
  // selectedIds. Purely local state; the store isn't touched until pointerup,
  // so dragging across the filmstrip doesn't thrash the loupe mid-drag.
  previewIds: number[] | null;
}

/** Give it the same container ref the caller already uses for scrollIntoView. */
export function useMarquee(containerRef: React.RefObject<HTMLDivElement>): UseMarqueeResult {
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null);
  const [previewIds, setPreviewIds] = useState<number[] | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const hitsRef = useRef<number[]>([]); // mirrors previewIds without the async-state lag
  const didDragRef = useRef(false);
  const lastClientRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const listenersRef = useRef<{
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
    key: (e: KeyboardEvent) => void;
  } | null>(null);

  const applyDrag = useCallback(
    (clientX: number, clientY: number) => {
      const container = containerRef.current;
      const drag = dragRef.current;
      if (!container || !drag) return;
      const cur = toContent(container, clientX, clientY);
      const dx = cur.x - drag.originX;
      const dy = cur.y - drag.originY;
      if (!drag.started) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        drag.started = true;
        didDragRef.current = true;
      }
      const rect: MarqueeRect = {
        left: Math.min(drag.originX, cur.x),
        top: Math.min(drag.originY, cur.y),
        width: Math.abs(dx),
        height: Math.abs(dy),
      };
      setMarqueeRect(rect);
      const hits = hitIds(container, rect);
      const preview = drag.unionMode
        ? Array.from(new Set([...drag.baseSelection, ...hits]))
        : hits;
      hitsRef.current = preview;
      setPreviewIds(preview);
    },
    [containerRef],
  );

  const autoScrollTick = useCallback(() => {
    const container = containerRef.current;
    const client = lastClientRef.current;
    const drag = dragRef.current;
    if (!container || !client || !drag || !drag.started) {
      rafRef.current = null;
      return;
    }
    const rect = container.getBoundingClientRect();
    let scrolled = false;
    if (container.scrollWidth > container.clientWidth) {
      if (client.x < rect.left + EDGE_ZONE) {
        container.scrollLeft -= EDGE_SPEED * ((rect.left + EDGE_ZONE - client.x) / EDGE_ZONE);
        scrolled = true;
      } else if (client.x > rect.right - EDGE_ZONE) {
        container.scrollLeft += EDGE_SPEED * ((client.x - (rect.right - EDGE_ZONE)) / EDGE_ZONE);
        scrolled = true;
      }
    }
    if (container.scrollHeight > container.clientHeight) {
      if (client.y < rect.top + EDGE_ZONE) {
        container.scrollTop -= EDGE_SPEED * ((rect.top + EDGE_ZONE - client.y) / EDGE_ZONE);
        scrolled = true;
      } else if (client.y > rect.bottom - EDGE_ZONE) {
        container.scrollTop += EDGE_SPEED * ((client.y - (rect.bottom - EDGE_ZONE)) / EDGE_ZONE);
        scrolled = true;
      }
    }
    if (scrolled) applyDrag(client.x, client.y);
    rafRef.current = requestAnimationFrame(autoScrollTick);
  }, [containerRef, applyDrag]);

  const clearListeners = useCallback(() => {
    const listeners = listenersRef.current;
    if (!listeners) return;
    window.removeEventListener("pointermove", listeners.move);
    window.removeEventListener("pointerup", listeners.up);
    window.removeEventListener("keydown", listeners.key);
    listenersRef.current = null;
  }, []);

  const endDrag = useCallback(
    (commit: boolean) => {
      const drag = dragRef.current;
      if (commit && drag?.started) {
        const finalSelection = hitsRef.current;
        const primary =
          finalSelection[finalSelection.length - 1] ??
          drag.baseSelection[drag.baseSelection.length - 1] ??
          null;
        useStore.getState().setSelection(finalSelection, primary);
      }
      didDragRef.current = drag?.started ?? false;
      dragRef.current = null;
      hitsRef.current = [];
      lastClientRef.current = null;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setMarqueeRect(null);
      setPreviewIds(null);
      clearListeners();
    },
    [clearListeners],
  );

  const onPointerDown = useCallback<React.PointerEventHandler<HTMLDivElement>>(
    (e) => {
      if (e.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;
      const origin = toContent(container, e.clientX, e.clientY);
      dragRef.current = {
        originX: origin.x,
        originY: origin.y,
        baseSelection: useStore.getState().selectedIds,
        unionMode: e.metaKey || e.ctrlKey || e.shiftKey,
        started: false,
      };
      hitsRef.current = [];
      lastClientRef.current = { x: e.clientX, y: e.clientY };

      const onMove = (ev: PointerEvent) => {
        lastClientRef.current = { x: ev.clientX, y: ev.clientY };
        applyDrag(ev.clientX, ev.clientY);
        if (dragRef.current?.started && rafRef.current == null) {
          rafRef.current = requestAnimationFrame(autoScrollTick);
        }
      };
      const onUp = () => endDrag(true);
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") endDrag(false);
      };
      clearListeners();
      listenersRef.current = { move: onMove, up: onUp, key: onKey };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("keydown", onKey);
    },
    [containerRef, applyDrag, autoScrollTick, endDrag, clearListeners],
  );

  const onClickCapture = useCallback<React.MouseEventHandler<HTMLDivElement>>((e) => {
    if (didDragRef.current) {
      e.preventDefault();
      e.stopPropagation();
      didDragRef.current = false;
    }
  }, []);

  // Safety net: a drag that's mid-flight when the component unmounts (e.g.
  // scene switch) shouldn't leak window listeners or a pending rAF.
  useEffect(() => {
    return () => {
      clearListeners();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [clearListeners]);

  return { onPointerDown, onClickCapture, marqueeRect, previewIds };
}

// Modifier-key click semantics shared by the filmstrip and the grid:
//   plain click       → selectImage (replace)
//   cmd/ctrl click     → toggleSelect
//   shift click        → selectRange (from the anchor)
//   cmd/ctrl+shift click → extendRange (union a range into the selection)
export function useThumbClick(): (e: React.MouseEvent, id: number) => void {
  const selectImage = useStore((s) => s.selectImage);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const selectRange = useStore((s) => s.selectRange);
  const extendRange = useStore((s) => s.extendRange);
  return useCallback(
    (e: React.MouseEvent, id: number) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.shiftKey) extendRange(id);
      else if (meta) toggleSelect(id);
      else if (e.shiftKey) selectRange(id);
      else selectImage(id);
    },
    [selectImage, toggleSelect, selectRange, extendRange],
  );
}

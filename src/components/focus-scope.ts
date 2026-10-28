"use client";

import { useEffect, useRef, type RefObject } from "react";

/** Keeps keyboard focus in modal drawers and restores it when they close. */
export function useFocusScope<T extends HTMLElement>(open: boolean, scopeRef: RefObject<T | null>, close: () => void, modal = true, restoreSelector?: string) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open || !scopeRef.current) return;
    const scope = scopeRef.current;
    // Opening a modal can make the triggering control inert before this effect runs.
    const previous = (restoreSelector ? document.querySelector<HTMLElement>(restoreSelector) : null) || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const candidates = () => [...scope.querySelectorAll<HTMLElement>('a[href], summary, button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden" && !element.closest("[inert]"));
    const frame = requestAnimationFrame(() => {
      const initial = scope.querySelector<HTMLElement>("[data-initial-focus]") || candidates()[0] || scope;
      initial.focus();
    });
    const onKey = (event: KeyboardEvent) => {
      if (scope.closest("[inert]")) return;
      // A native editor dialog owns focus while it is above this drawer.
      const nativeDialog = document.querySelector("dialog[open]");
      if (nativeDialog && !scope.contains(nativeDialog)) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (!modal || event.key !== "Tab") return;
      const items = candidates();
      if (!items.length) { event.preventDefault(); scope.focus(); return; }
      const first = items[0]; const last = items[items.length - 1]; const current = document.activeElement;
      if (!scope.contains(current) || (event.shiftKey && current === first) || (!event.shiftKey && current === last)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected && !previous.closest("[inert]") && previous.getClientRects().length && getComputedStyle(previous).visibility !== "hidden") previous.focus();
    };
  }, [open, scopeRef, modal, restoreSelector]);
}

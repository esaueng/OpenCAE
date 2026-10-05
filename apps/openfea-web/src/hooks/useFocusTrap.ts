import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Makes a dialog accessible: when `active`, moves focus into the container,
 * traps Tab/Shift+Tab inside it, closes on Escape, and restores focus to the
 * previously focused element on deactivate.
 *
 * The effect depends ONLY on `active` so it runs once per open — not on every
 * parent re-render. `onClose` is read through a ref so the latest callback is
 * always used without re-subscribing; re-subscribing would re-run the
 * initial-focus step and steal focus mid-interaction whenever the parent
 * re-renders with a fresh inline `onClose` (e.g. selecting a material in the
 * library list).
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  active: boolean,
  onClose?: () => void,
) {
  const ref = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const getFocusable = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

    const focusable = getFocusable();
    if (focusable[0]) {
      focusable[0].focus();
    } else {
      if (!container.hasAttribute("tabindex")) container.tabIndex = -1;
      container.focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const items = getFocusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const activeEl = document.activeElement;
      if (!container.contains(activeEl)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && activeEl === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeEl === last) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener("keydown", handleKeyDown);
    return () => {
      container.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus?.();
    };
    // Intentionally only `active`: onClose is read via ref to avoid focus-steal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return ref;
}

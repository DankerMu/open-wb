import type { KeyboardEvent } from "react";

/** Keep Tab inside a modal rather than cycling into browser chrome. */
export function trapDialogFocus(event: KeyboardEvent<HTMLDialogElement>): void {
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget;
  const controls = Array.from(
    dialog.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]"),
  ).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(":disabled, [type=hidden]") &&
      !element.closest("[hidden], [inert]"),
  );
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

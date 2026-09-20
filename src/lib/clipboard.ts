/** Copy from a user gesture, including browsers on plain HTTP without Clipboard API. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch { /* Try the selection-based clipboard on browsers that block this API. */ }
  }
  const focused = document.activeElement;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.tabIndex = -1;
  field.setAttribute("aria-hidden", "true");
  Object.assign(field.style, { position: "fixed", opacity: "0", pointerEvents: "none" });
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand("copy")) throw new Error("Couldn’t copy the link. Try again.");
  } finally {
    field.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
}

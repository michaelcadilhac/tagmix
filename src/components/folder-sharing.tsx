"use client";

import { useEffect, useLayoutEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { copyText } from "@/lib/clipboard";
import { accountRequest, errorMessage } from "@/lib/account-client";
import type { FolderAccess, FolderSharing as Sharing } from "@/lib/account-types";

export function FolderSharing({ folderId, shareToken, userId, access, onChange }: { folderId: string; shareToken: string; userId: string; access: FolderAccess; onChange: (access: FolderAccess) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyPending = useRef(false);
  const saving = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyLink() {
    if (copyPending.current) return;
    copyPending.current = true;
    setOpen(false); setCopying(true); setCopied(false); setError(""); setMessage("");
    try {
      await copyText(`${window.location.origin}/shared/${shareToken}`);
      setCopied(true); setMessage("Share link copied.");
    } catch { setError("Couldn’t copy the link. Try again."); }
    finally { copyPending.current = false; setCopying(false); }
  }

  useLayoutEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    function position() {
      const menu = root.current?.querySelector<HTMLElement>('[role="menu"]');
      if (!menu) return;
      menu.style.left = "";
      menu.style.right = "";
      const bounds = menu.getBoundingClientRect();
      const shift = bounds.left < 14 ? 14 - bounds.left : Math.min(0, document.documentElement.clientWidth - 14 - bounds.right);
      menu.style.left = `${menu.offsetLeft + shift}px`;
      menu.style.right = "auto";
    }
    position();
    window.addEventListener("resize", position);
    document.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("resize", position); document.removeEventListener("pointerdown", outside); };
  }, [open]);

  function close() { setOpen(false); button.current?.focus(); }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    }
  }

  async function update(next: FolderAccess) {
    if (saving.current) return;
    if (next === access) { close(); return; }
    saving.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const data = await accountRequest<{ sharing: Sharing }>(`folders/${folderId}/sharing`, { userId, method: "PATCH", body: { access: next } });
      onChange(data.sharing.access);
      setMessage(`Sharing set to ${next === "view" ? "read-only" : "read/write"}.`);
      // Do not steal focus if the user moved away while the request was pending.
      if (root.current?.contains(document.activeElement)) close();
      else setOpen(false);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { saving.current = false; setBusy(false); }
  }

  return <div className="sharing-control" ref={root} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <div className="share-split" role="group" aria-label="Share folder">
      <button className="button button-primary copy-share-link" type="button" aria-label="Copy share link" aria-disabled={copying || undefined} onClick={() => void copyLink()}>
        <span className="copy-share-label">{copied ? "Copied!" : copying ? "Copying…" : "Copy share link"}</span>
      </button>
      <button ref={button} className="button button-primary sharing-toggle" type="button" aria-label="Sharing permissions" title="Sharing permissions" aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
        onClick={() => setOpen(!open)} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}><span aria-hidden="true">▾</span></button>
    </div>
    {open && <div className="sharing-dropdown" id={menuId} role="menu" aria-label="Anyone with the link" onKeyDown={navigate}>
      <p className="form-hint" role="presentation">Anyone with the link</p>
      {(["view", "edit"] as const).map((value) => <button key={value} type="button" role="menuitemradio" tabIndex={-1} aria-checked={access === value} aria-disabled={busy || undefined} onClick={() => void update(value)}>
        <span aria-hidden="true">{access === value ? "✓" : ""}</span>{value === "view" ? "Read-only" : "Read/write"}
      </button>)}
    </div>}
    <span className="sr-only" role="status">{busy ? "Saving…" : message}</span>
    {error && <p className="form-error sharing-error" role="alert">{error}</p>}
  </div>;
}

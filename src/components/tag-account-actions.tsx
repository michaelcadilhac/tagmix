"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import { useAccount } from "@/components/account-provider";
import { useAccountResource } from "@/components/account-resource";
import { accountRequest, errorMessage } from "@/lib/account-client";
import type { FolderSummary, SavedFolder } from "@/lib/account-types";

type FolderChoices = { folders: FolderSummary[]; savedFolderIds: string[] };

export function TagAccountActions({ tagId, pitchSemitones, children }: { tagId: number; pitchSemitones: number; children: ReactNode }) {
  const { user, loading } = useAccount();
  const resource = useAccountResource<FolderChoices>(`folders?tagId=${tagId}`, user?.id);
  // Keep memberships steady while refreshing the dropdown's choices.
  const [membership, setMembership] = useState<{ userId: string | undefined; data: FolderChoices | null }>({ userId: user?.id, data: null });
  if (membership.userId !== user?.id || (resource.data && membership.data !== resource.data)) {
    setMembership({ userId: user?.id, data: resource.data });
  }
  const membershipData = resource.data ?? (resource.loading && membership.userId === user?.id ? membership.data : null);
  const savedFolders = membershipData?.folders.filter((folder) => membershipData.savedFolderIds.includes(folder.id)) ?? [];
  const savedFolderIds = new Set(resource.data?.savedFolderIds);
  const folderChoices = [...(resource.data?.folders ?? [])].sort((a, b) => Number(savedFolderIds.has(b.id)) - Number(savedFolderIds.has(a.id)));
  const [menuState, setMenuState] = useState<"closed" | "loading" | "open">("closed");
  const [showSpinner, setShowSpinner] = useState(false);
  if (menuState === "loading" && !resource.loading) {
    setMenuState(resource.error ? "closed" : "open");
  }
  const open = menuState === "open";
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const controlRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const saving = useRef(false);

  useLayoutEffect(() => {
    if (menuState === "closed") return;
    const dropdown = dropdownRef.current;
    dropdown?.querySelector<HTMLElement>('[role="menu"]')?.focus({ preventScroll: true });
    function position() {
      if (!dropdown) return;
      dropdown.style.left = "0px";
      const bounds = dropdown.getBoundingClientRect();
      const shift = bounds.left < 12 ? 12 - bounds.left : Math.min(0, document.documentElement.clientWidth - 12 - bounds.right);
      dropdown.style.left = `${shift}px`;
      dropdown.style.maxHeight = `${Math.max(120, window.innerHeight - bounds.top - 12)}px`;
    }
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !controlRef.current?.contains(event.target)) setMenuState("closed");
    }
    position();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
    };
  }, [menuState]);

  useEffect(() => {
    if (menuState !== "loading") return;
    const timer = window.setTimeout(() => setShowSpinner(true), 500);
    return () => window.clearTimeout(timer);
  }, [menuState]);

  useLayoutEffect(() => {
    if (!open || resource.loading || creating) return;
    const menu = dropdownRef.current?.querySelector<HTMLElement>('[role="menu"]');
    if (menu === document.activeElement) menu?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [open, resource.loading, creating]);

  useEffect(() => {
    if (!user?.id) return;
    const controller = new AbortController();
    accountRequest("history", { userId: user.id, method: "POST", body: { tagId }, signal: controller.signal })
      .then(() => setHistoryError(""))
      .catch((failure) => { if (!controller.signal.aborted) setHistoryError(errorMessage(failure)); });
    return () => controller.abort();
  }, [tagId, user?.id, historyAttempt]);

  function close() { setMenuState("closed"); triggerRef.current?.focus({ preventScroll: true }); }

  function show() {
    setCreating(false); setError(""); setShowSpinner(false);
    if (user) {
      resource.reload();
      setMenuState("loading");
    } else setMenuState("open");
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...(dropdownRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  }

  async function save(folderId: string, name?: string) {
    if (!user || saving.current) return;
    saving.current = true;
    setBusy(true); setError(""); setMessage("");
    try {
      if (name !== undefined) {
        if (!name.trim()) throw new Error("Enter a folder name.");
        const created = await accountRequest<{ folder: SavedFolder }>("folders", { userId: user.id, method: "POST", body: { name: name.trim() } });
        folderId = created.folder.id;
      }
      const saved = await accountRequest<{ folder: SavedFolder }>(`folders/${folderId}/tags`, { userId: user.id, method: "POST", body: { tagId, pitchSemitones } });
      setMessage(`Saved to “${saved.folder.name}”.`);
      if (dropdownRef.current && (document.activeElement === document.body || controlRef.current?.contains(document.activeElement))) close();
      else setMenuState("closed");
      setCreating(false);
      resource.reload();
    } catch (failure) { setError(errorMessage(failure)); resource.reload(); }
    finally { saving.current = false; setBusy(false); }
  }

  async function remove(folderId: string) {
    if (!user || saving.current) return;
    saving.current = true;
    setBusy(true); setError(""); setMessage("");
    try {
      const removed = await accountRequest<{ folder: SavedFolder }>(`folders/${folderId}/tags/${tagId}`, { userId: user.id, method: "DELETE" });
      setMessage(`Removed from “${removed.folder.name}”.`);
      if (dropdownRef.current && (document.activeElement === document.body || controlRef.current?.contains(document.activeElement))) close();
      else setMenuState("closed");
      resource.reload();
    } catch (failure) { setError(errorMessage(failure)); resource.reload(); }
    finally { saving.current = false; setBusy(false); }
  }

  function createFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save("", String(new FormData(event.currentTarget).get("name") ?? ""));
  }

  return <div className="tag-account-actions">
    <div className="workspace-title-row">
      <div className="tag-save-control" ref={controlRef}
        onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setMenuState("closed"); }}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
        <button ref={triggerRef} className="tag-save-button" aria-label="Save to folder" title="Save to folder" aria-haspopup="menu" aria-expanded={open} aria-busy={menuState === "loading"} aria-controls={`save-tag-${tagId}`} disabled={loading}
          onClick={() => { if (menuState !== "closed") close(); else show(); }}
          onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (menuState === "closed") show(); else if (open) dropdownRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus(); } }} type="button">
          {menuState === "loading" && showSpinner ? <span className="bookmark-spinner" aria-hidden="true" /> : <Icon name="bookmark" size={22} fill={savedFolders.length ? "currentColor" : "none"} />}
        </button>
        {menuState === "loading" && <span className="sr-only" role="status">Loading folders…</span>}
        {open && <div className="save-tag-dropdown" ref={dropdownRef}>
          <p className="save-tag-heading" id={`save-tag-heading-${tagId}`}>Save to folder</p>
          {user && resource.loading && <p className="form-hint" role="status">Loading folders…</p>}
          <div role="menu" id={`save-tag-${tagId}`} aria-labelledby={`save-tag-heading-${tagId}`} tabIndex={-1} onKeyDown={navigate}>
            {!user ? <Link role="menuitem" tabIndex={-1} href={`/account?next=/tags/${tagId}`}>Sign in to save a tag</Link> : <>
              {folderChoices.map((folder) => {
                const saved = savedFolderIds.has(folder.id);
                if (saved) return <div className="saved-folder-option" role="group" aria-label={`${folder.name} — already saved`} key={folder.id} data-folder-id={folder.id}>
                  <span className="saved-folder-label"><Icon name="check" size={16} /><span className="save-folder-name">{folder.name}{folder.access === "view" && <span className="form-hint">Read-only</span>}</span></span>
                  <Link className="saved-folder-action" role="menuitem" tabIndex={-1} href={`/folders/${folder.id}`} aria-label={`View folder “${folder.name}”`} title="View folder"><Icon name="eye" size={18} /></Link>
                  <button className="saved-folder-action remove-folder-tag" role="menuitem" tabIndex={-1} type="button" disabled={busy || folder.access === "view"} onClick={() => void remove(folder.id)} aria-label={`Remove tag from “${folder.name}”`} title={folder.access === "view" ? "Read-only folder" : "Remove tag from folder"}><Icon name="x" size={18} /></button>
                </div>;
                return <button className="save-folder-option" role="menuitem" tabIndex={-1} type="button" key={folder.id} data-folder-id={folder.id} disabled={busy || folder.access === "view"} onClick={() => void save(folder.id)}>
                  <span className="save-folder-name">{folder.name}</span>
                  {folder.access === "view" && <span className="form-hint">Read-only</span>}
                </button>;
              })}
              <button className="new-folder-option" role="menuitem" tabIndex={-1} type="button" disabled={busy || resource.loading} onClick={() => setCreating(true)}><Icon name="plus" size={16} />New folder…</button>
            </>}
          </div>
          {user && creating && <form className="save-tag-form" onSubmit={createFolder}>
            <label>New folder name<input autoFocus name="name" maxLength={100} required disabled={busy} /></label>
            <div className="save-tag-buttons">
              <button className="button button-secondary" type="button" onClick={close}>Cancel</button>
              <button className="button button-primary" disabled={busy || resource.loading}>{busy ? "Saving…" : "Create & save"}</button>
            </div>
          </form>}
          {busy && !creating && <p className="form-hint" role="status">Updating…</p>}
          {user && resource.error && <p className="form-error" role="alert">{resource.error} <button className="text-link" type="button" onClick={resource.reload}>Retry</button></p>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>}
      </div>
      {children}
    </div>
    {!loading && user && <>
      {!open && resource.error && <p className="form-error" role="alert">{resource.error} <button className="text-link" type="button" onClick={show}>Retry</button></p>}
      {historyError && <p className="form-error" role="alert">Could not update history: {historyError} <button className="text-link" onClick={() => setHistoryAttempt((value) => value + 1)}>Retry</button></p>}
    </>}
    {message && <p className="sr-only" role="status">{message}</p>}
    {!open && error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}

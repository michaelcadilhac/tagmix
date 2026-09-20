"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useAccount } from "@/components/account-provider";
import { useAccountResource } from "@/components/account-resource";
import { accountRequest, errorMessage } from "@/lib/account-client";
import type { FolderSummary, SavedFolder } from "@/lib/account-types";

export function TagAccountActions({ tagId, pitchSemitones }: { tagId: number; pitchSemitones: number }) {
  const { user, loading } = useAccount();
  const resource = useAccountResource<{ folders: FolderSummary[]; savedFolderIds: string[] }>(`folders?tagId=${tagId}`, user?.id);
  const savedFolders = resource.data?.folders.filter((folder) => resource.data?.savedFolderIds.includes(folder.id)) ?? [];
  const [open, setOpen] = useState(false);
  const [folderChoice, setFolderChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const backdropPressed = useRef(false);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const trigger = triggerRef.current;
    const root = document.documentElement;
    const { overflow, scrollbarGutter } = root.style;
    root.style.scrollbarGutter = "stable";
    root.style.overflow = "hidden";
    dialog.showModal();
    return () => {
      dialog.close();
      root.style.overflow = overflow;
      root.style.scrollbarGutter = scrollbarGutter;
      trigger?.focus({ preventScroll: true });
    };
  }, [open, user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    const controller = new AbortController();
    accountRequest("history", { userId: user.id, method: "POST", body: { tagId }, signal: controller.signal })
      .then(() => setHistoryError(""))
      .catch((failure) => { if (!controller.signal.aborted) setHistoryError(errorMessage(failure)); });
    return () => controller.abort();
  }, [tagId, user?.id, historyAttempt]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) return;
    const data = new FormData(event.currentTarget);
    setBusy(true); setError(""); setMessage("");
    try {
      let folderId = String(data.get("folder") ?? "");
      const name = String(data.get("name") ?? "").trim();
      if (folderId === "new" && !name) throw new Error("Enter a folder name.");
      if (name) {
        const created = await accountRequest<{ folder: SavedFolder }>("folders", { userId: user.id, method: "POST", body: { name } });
        folderId = created.folder.id;
      }
      if (!folderId) throw new Error("Choose a folder or enter a new folder name.");
      const saved = await accountRequest<{ folder: SavedFolder }>(`folders/${folderId}/tags`, { userId: user.id, method: "POST", body: { tagId, pitchSemitones } });
      setMessage(`Saved to “${saved.folder.name}”.`);
      setOpen(false);
      setFolderChoice("");
      resource.reload();
    } catch (failure) { setError(errorMessage(failure)); resource.reload(); }
    finally { setBusy(false); }
  }

  return <section className="tag-account-actions" aria-label="Your tag library">
    {loading ? <p role="status">Loading…</p> : !user ? <Link className="button button-secondary" href={`/account?next=/tags/${tagId}`}>Sign in to save tag</Link> : <>
      <div className="tag-save-row">
        <button ref={triggerRef} className="button button-secondary" aria-haspopup="dialog" aria-expanded={open} aria-controls={`save-tag-${tagId}`} onClick={() => { setOpen(true); setError(""); resource.reload(); }} type="button">Save to folder</button>
        {resource.loading ? <span className="form-hint" role="status">Loading folders…</span> : savedFolders.length > 0 && <div className="folder-membership"><span>Saved in</span>{savedFolders.map((folder) => <Link key={folder.id} href={`/folders/${folder.id}`}>{folder.name}</Link>)}</div>}
      </div>
      {!open && resource.error && <p className="form-error" role="alert">{resource.error} <button className="text-link" type="button" onClick={resource.reload}>Retry</button></p>}
      {open && <dialog ref={dialogRef} className="save-tag-dialog" id={`save-tag-${tagId}`} aria-labelledby={`save-tag-heading-${tagId}`}
        onCancel={(event) => { event.preventDefault(); setOpen(false); }}
        onPointerDown={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          backdropPressed.current = event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
        }}
        onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (backdropPressed.current && event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) setOpen(false);
          backdropPressed.current = false;
        }}>
        <header className="save-tag-heading">
          <h2 id={`save-tag-heading-${tagId}`}>Save to folder</h2>
          <button className="dialog-close" type="button" aria-label="Close save to folder" onClick={() => setOpen(false)}><span aria-hidden="true">×</span></button>
        </header>
        <form className="save-tag-form" onSubmit={save}>
        <label>Folder<select name="folder" value={folderChoice} onChange={(event) => setFolderChoice(event.target.value)} disabled={busy || resource.loading}><option value="">Choose a folder</option>{resource.data?.folders.map((folder) => <option key={folder.id} value={folder.id} disabled={folder.access === "view" || resource.data?.savedFolderIds.includes(folder.id)}>{folder.name}{folder.access === "view" ? " — read-only" : resource.data?.savedFolderIds.includes(folder.id) ? " — already saved" : ""}</option>)}<option value="new">New folder…</option></select></label>
        {folderChoice === "new" && <label>New folder name<input autoFocus name="name" maxLength={100} required disabled={busy} /></label>}
        {resource.loading && <p className="form-hint" role="status">Loading folders…</p>}
        {resource.error && <p className="form-error" role="alert">{resource.error} <button className="text-link" type="button" onClick={resource.reload}>Retry</button></p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="save-tag-buttons">
          <button className="button button-secondary" type="button" onClick={() => setOpen(false)}>Cancel</button>
          <button className="button button-primary" disabled={busy || resource.loading || !folderChoice}>{busy ? "Saving…" : "Save tag"}</button>
        </div>
        </form>
      </dialog>}
      {historyError && <p className="form-error" role="alert">Could not update history: {historyError} <button className="text-link" onClick={() => setHistoryAttempt((value) => value + 1)}>Retry</button></p>}
    </>}
    {message && <p className="sr-only" role="status">{message}</p>}
    {!open && error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}

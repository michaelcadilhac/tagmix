"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AccountRequired, useAccount } from "@/components/account-provider";
import { useAccountResource } from "@/components/account-resource";
import { accountRequest, errorMessage } from "@/lib/account-client";
import { FolderSharing } from "@/components/folder-sharing";
import { PitchControl } from "@/components/pitch-control";
import { formatPitchSemitones } from "@/lib/pitch";
import type { FolderSummary, SavedFolder, SavedTag, SharedFolder } from "@/lib/account-types";

export function SavedFolders() {
  const { user } = useAccount();
  const resource = useAccountResource<{ folders: FolderSummary[] }>("folders", user?.id, true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) return;
    const name = String(new FormData(event.currentTarget).get("name"));
    setBusy(true); setError("");
    try {
      const { folder } = await accountRequest<{ folder: SavedFolder }>("folders", { userId: user.id, method: "POST", body: { name } });
      router.push(`/folders/${folder.id}`);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  return <><h1>My folders</h1>
    <AccountRequired>
      <form className="inline-form" onSubmit={create}><label>New folder name<input name="name" maxLength={100} required /></label><button className="button button-primary" disabled={busy}>Create folder</button></form>
      {error && <p className="form-error" role="alert">{error}</p>}
      {resource.loading && <p role="status">Loading folders…</p>}
      {resource.error && <p role="alert">{resource.error} <button className="text-link" onClick={resource.reload}>Retry</button></p>}
      {resource.data?.folders.length === 0 && <p className="library-empty">No folders yet. Create one to start saving tags.</p>}
      <ul className="folder-grid">{resource.data?.folders.map((folder) => <li key={folder.id}><Link href={`/folders/${folder.id}`}><h2>{folder.name}</h2><span>{folder.count} {folder.count === 1 ? "tag" : "tags"}{folder.access !== "owner" && ` · ${folder.access === "edit" ? "Shared · Can edit" : "Read-only"}`}</span></Link></li>)}</ul>
    </AccountRequired>
  </>;
}

export function SavedTagLink({ tag, pitchSemitones, showPitch = false }: { tag: SavedTag; pitchSemitones?: number; showPitch?: boolean }) {
  const href = `/tags/${tag.id}${pitchSemitones === undefined ? "" : `?pitch=${pitchSemitones}`}`;
  return <Link className="saved-tag-link" href={href}><strong>{tag.title}</strong><span>{[tag.version, tag.key && `Key: ${tag.key}`, showPitch && pitchSemitones !== undefined && formatPitchSemitones(pitchSemitones)].filter(Boolean).join(" · ") || `Tag #${tag.id}`}</span></Link>;
}

export function FolderEditor({ folderId }: { folderId: string }) {
  const { user } = useAccount();
  const resource = useAccountResource<{ folder: SavedFolder }>(`folders/${folderId}`, user?.id, true);
  const folder = resource.data?.folder;
  const canEdit = folder?.access !== "view";
  const isOwner = folder?.access === "owner";
  const [busy, setBusy] = useState(false);
  // aria-disabled keeps focus and styling stable during short saves. Guard the
  // handlers as well, including repeated clicks before React updates the DOM.
  const saving = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [renaming, setRenaming] = useState(false);
  const router = useRouter();

  async function mutate(path: string, method: string, body?: unknown) {
    if (!user || saving.current) return;
    saving.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await accountRequest<{ folder: SavedFolder }>(`folders/${folderId}${path}`, { userId: user.id, method, body });
      resource.replace(data);
      setNotice("Folder saved.");
      if (method === "PATCH" && path === "") setRenaming(false);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { saving.current = false; setBusy(false); }
  }

  function move(index: number, destination: number) {
    if (!folder || destination < 0 || destination >= folder.tags.length) return;
    const tagIds = folder.tags.map((tag) => tag.id);
    const [id] = tagIds.splice(index, 1);
    tagIds.splice(destination, 0, id);
    void mutate("/order", "PUT", { tagIds, revision: folder.revision });
  }

  async function leaveFolder() {
    if (!user || saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try {
      await accountRequest(`folders/${folderId}/membership`, { userId: user.id, method: "DELETE" });
      router.push("/folders");
    } catch (failure) { saving.current = false; setBusy(false); setError(errorMessage(failure)); }
  }

  async function deleteFolder() {
    if (!user || !folder || saving.current || !window.confirm(`Delete “${folder.name}”? Its share link will stop working.`)) return;
    saving.current = true;
    setBusy(true); setError("");
    try {
      await accountRequest(`folders/${folderId}`, { userId: user.id, method: "DELETE" });
      router.push("/folders");
    } catch (failure) { saving.current = false; setError(errorMessage(failure)); setBusy(false); }
  }

  return <><AccountRequired>
    {resource.loading && <p role="status">Loading folder…</p>}
    {resource.error && <p role="alert">{resource.error} <button className="text-link" onClick={resource.reload}>Retry</button></p>}
    {folder && <>
      <header className="library-heading folder-heading">
        <div><h1>{folder.name}</h1><p className="form-hint">{folder.count} {folder.count === 1 ? "tag" : "tags"}{!isOwner && ` · ${canEdit ? "Shared · Can edit" : "Read-only"}`}</p>{!isOwner && <p className="folder-owner form-hint">Owner: {folder.ownerEmail}</p>}</div>
        <div className="folder-toolbar">
          {isOwner && <button className="button button-secondary rename-toggle" aria-disabled={busy || undefined} aria-expanded={renaming} aria-controls="rename-folder" onClick={() => { if (!saving.current) setRenaming(!renaming); }} type="button">{renaming ? "Cancel" : "Rename"}</button>}
          {isOwner && user && <FolderSharing folderId={folderId} shareToken={folder.shareToken} userId={user.id} access={folder.shareAccess} onChange={(shareAccess) => resource.update((current) => ({ folder: { ...current.folder, shareAccess } }))} />}
        </div>
      </header>
      {isOwner && renaming && <form className="inline-form" id="rename-folder" onSubmit={(event) => { event.preventDefault(); void mutate("", "PATCH", { name: new FormData(event.currentTarget).get("name") }); }}>
        <label>Folder name<input autoFocus key={folder.name} name="name" defaultValue={folder.name} maxLength={100} required readOnly={busy} /></label><button className="button button-primary" aria-disabled={busy || undefined}>Save name</button>
      </form>}
      <p className="sr-only" role="status">{busy ? "Saving…" : notice}</p>
      {folder.tags.length === 0 && <p className="library-empty">{canEdit ? "No tags yet. Find a tag using Browse tags in the menu, then choose “Save to folder.”" : "No tags in this folder yet."}</p>}
      <ol className="saved-tag-list">{folder.tags.map((tag, index) => <li key={tag.id}>
        <span className="tag-position">{index + 1}</span><SavedTagLink tag={tag} pitchSemitones={tag.pitchSemitones} showPitch={!canEdit} />
        {canEdit && <div className="folder-tag-actions">
          <div className="folder-pitch" role="group" aria-label={`Pitch for ${tag.title}`}>
            <span>Pitch</span>
            <PitchControl compact tagTitle={tag.title} value={tag.pitchSemitones} saving={busy} onChange={(pitchSemitones) => void mutate(`/tags/${tag.id}`, "PATCH", { pitchSemitones, revision: folder.revision })} />
          </div>
          <button aria-label={`Move ${tag.title} up`} disabled={index === 0} aria-disabled={busy || undefined} onClick={() => move(index, index - 1)} type="button">↑</button>
          <button aria-label={`Move ${tag.title} down`} disabled={index === folder.tags.length - 1} aria-disabled={busy || undefined} onClick={() => move(index, index + 1)} type="button">↓</button>
          <button aria-disabled={busy || undefined} aria-label={`Remove ${tag.title} from folder`} onClick={() => void mutate(`/tags/${tag.id}`, "DELETE")} type="button">Remove</button>
        </div>}
      </li>)}</ol>
      {isOwner ? <button className="text-link danger-button" aria-disabled={busy || undefined} onClick={() => void deleteFolder()} type="button">Delete folder</button> : <button className="text-link" aria-disabled={busy || undefined} onClick={() => void leaveFolder()} type="button">Remove from my folders</button>}
    </>}
    {error && <p className="form-error" role="alert">{error} <button className="text-link" onClick={() => { setError(""); resource.reload(); }}>Reload folder</button></p>}
  </AccountRequired></>;
}

export function SharedFolderView({ token }: { token: string }) {
  const { user, loading } = useAccount();
  const router = useRouter();
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ folder?: SharedFolder; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/shared/${encodeURIComponent(token)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        setState({ folder: data.folder });
      }).catch((error) => { if (!controller.signal.aborted) setState({ error: errorMessage(error) }); });
    return () => controller.abort();
  }, [attempt, token]);

  async function importFolder(copy: boolean) {
    if (!user || importing) return;
    setImporting(true); setImportError("");
    try {
      const { folder } = await accountRequest<{ folder: SavedFolder }>(copy ? "folders/import" : "folders/add-shared", {
        userId: user.id, method: "POST", body: { token },
      });
      router.push(`/folders/${folder.id}`);
    } catch (failure) { setImportError(errorMessage(failure)); setImporting(false); }
  }
  return <><p className="eyebrow">Shared folder</p>
    {state.error ? <><h1>Folder unavailable</h1><p role="alert">{state.error}</p><button className="button button-secondary" onClick={() => setAttempt((value) => value + 1)}>Try again</button></> : state.folder ? <>
      <header className="library-heading folder-heading">
        <div><h1>{state.folder.name}</h1><p className="form-hint">{state.folder.tags.length} {state.folder.tags.length === 1 ? "tag" : "tags"} · {state.folder.access === "edit" ? "Can edit" : "Read-only"}</p><p className="folder-owner form-hint">Owner: {state.folder.ownerEmail}</p></div>
        {!loading && <div className="folder-toolbar">{[false, true].map((copy) => {
          const label = copy ? "Add a copy to my folders" : "Add to my folders";
          const className = `button ${copy ? "button-secondary import-folder" : "button-primary add-shared-folder"}`;
          return user ? <button key={label} className={className} disabled={importing} onClick={() => void importFolder(copy)} type="button">{label}</button>
            : <Link key={label} className={className} href={`/account?next=${encodeURIComponent(`/shared/${token}`)}`}>{label}</Link>;
        })}</div>}
      </header>
      {importError && <p className="form-error" role="alert">{importError}</p>}
      {!state.folder.tags.length && <p className="library-empty">No tags in this folder yet.</p>}
      <ol className="saved-tag-list">{state.folder.tags.map((tag, index) => <li key={tag.id}><span className="tag-position">{index + 1}</span><SavedTagLink tag={tag} pitchSemitones={tag.pitchSemitones} showPitch /></li>)}</ol>
    </> : <p role="status">Loading shared folder…</p>}
  </>;
}

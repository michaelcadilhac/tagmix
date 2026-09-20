"use client";

import { useState } from "react";
import { AccountRequired, useAccount } from "@/components/account-provider";
import { useAccountResource } from "@/components/account-resource";
import { SavedTagLink } from "@/components/saved-folders";
import { accountRequest, errorMessage } from "@/lib/account-client";
import type { HistoryItem } from "@/lib/account-types";

export function RecentHistory() {
  const { user } = useAccount();
  const resource = useAccountResource<{ items: HistoryItem[]; hasMore: boolean }>("history", user?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function clear() {
    if (!user || !window.confirm("Clear your recently viewed tags? Your folders and marks will be kept.")) return;
    setBusy(true); setError("");
    try {
      await accountRequest("history", { userId: user.id, method: "DELETE" });
      resource.replace({ items: [], hasMore: false });
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function more() {
    if (!user || !resource.data) return;
    setBusy(true); setError("");
    try {
      const next = await accountRequest<{ items: HistoryItem[]; hasMore: boolean }>(`history?offset=${resource.data.items.length}`, { userId: user.id });
      const items = new Map(resource.data.items.map((item) => [item.id, item]));
      for (const item of next.items) if (!items.has(item.id)) items.set(item.id, item);
      resource.replace({ items: [...items.values()], hasMore: next.hasMore });
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  return <><h1>Recently viewed</h1><AccountRequired>
    {resource.loading && <p role="status">Loading history…</p>}
    {(error || resource.error) && <p className="form-error" role="alert">{error || resource.error} <button className="text-link" onClick={resource.reload}>Reload</button></p>}
    {resource.data && <>
      {resource.data.items.length ? <button className="button button-secondary" disabled={busy} onClick={() => void clear()} type="button">Clear history</button> : <p className="library-empty">Tags you open while signed in will appear here.</p>}
      <ul className="saved-tag-list">{resource.data.items.map((tag) => <li key={tag.id}><SavedTagLink tag={tag} /><time dateTime={tag.viewedAt}>{new Date(tag.viewedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</time></li>)}</ul>
      {resource.data.hasMore && <button className="button button-secondary" disabled={busy} onClick={() => void more()}>Load more</button>}
    </>}
  </AccountRequired></>;
}

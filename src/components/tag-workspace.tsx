"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import { Mixer } from "@/components/mixer";
import { ScoreViewer } from "@/components/score-viewer";
import { formatCount } from "@/lib/format";
import type { Tag } from "@/lib/types";

function qualityCopy(tag: Tag): { label: string; description: string } {
  if (tag.audioQuality === "isolated") {
    return {
      label: "Isolated source parts",
      description: "Each learning track already contains only its named voice.",
    };
  }
  if (tag.audioQuality === "extractable") {
    return {
      label: "Parts cleanly extracted",
      description: "The named voice and the three reference voices use separate stereo channels; TagMix plays only the named-voice channel.",
    };
  }
  return {
    label: "Best-effort source mix",
    description: "The named voice is emphasized, but the recording may also contain the other voices, so quiet reference parts may remain in playback.",
  };
}

function WorkspaceLoading() {
  return (
    <div className="workspace-page workspace-loading" aria-label="Loading tag">
      <div className="workspace-title-skeleton">
        <span className="skeleton skeleton-short" />
        <span className="skeleton skeleton-heading" />
        <span className="skeleton skeleton-line" />
      </div>
      <div className="workspace-grid">
        <div className="workspace-panel skeleton-panel" />
        <div className="workspace-panel skeleton-panel" />
      </div>
    </div>
  );
}

export function TagWorkspace({ tagId }: { tagId: string }) {
  const [retry, setRetry] = useState(0);
  const requestUrl = useMemo(
    () => `/api/tags/${encodeURIComponent(tagId)}?attempt=${retry}`,
    [retry, tagId],
  );
  const [requestState, setRequestState] = useState<{ key: string; tag: Tag | null; error: string }>({
    key: "",
    tag: null,
    error: "",
  });
  const tag = requestState.tag;
  const loading = requestState.key !== requestUrl;
  const error = requestState.key === requestUrl ? requestState.error : "";

  useEffect(() => {
    const controller = new AbortController();
    fetch(requestUrl, { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as Tag | { error?: string };
        if (!response.ok) throw new Error("error" in payload ? payload.error : "This tag could not be loaded.");
        setRequestState({ key: requestUrl, tag: payload as Tag, error: "" });
      })
      .catch((requestError: unknown) => {
        if ((requestError as Error).name !== "AbortError") {
          setRequestState((current) => ({
            key: requestUrl,
            tag: current.tag,
            error: requestError instanceof Error ? requestError.message : "This tag could not be loaded.",
          }));
        }
      });
    return () => controller.abort();
  }, [requestUrl]);

  if (loading && !tag) return <WorkspaceLoading />;

  if (error || !tag) {
    return (
      <section className="empty-page">
        <span className="empty-page-note" aria-hidden="true">♭</span>
        <p className="eyebrow">Couldn’t cue that tag</p>
        <h1>{error || "Tag not found."}</h1>
        <p>It may have changed in the source library, or the library may be temporarily unavailable.</p>
        <div className="button-row">
          <button className="button button-primary" onClick={() => setRetry((value) => value + 1)} type="button">Try again</button>
          <Link className="button button-secondary" href="/">Back to library</Link>
        </div>
      </section>
    );
  }

  const quality = qualityCopy(tag);
  const subtitle = [tag.alternateTitle && `aka “${tag.alternateTitle}”`, tag.version].filter(Boolean).join(" · ");

  return (
    <article className="workspace-page">
      <Link className="back-link" href="/"><Icon name="arrow-left" size={17} /> All tags</Link>

      <header className="workspace-hero">
        <div className="workspace-heading">
          <p className="eyebrow">Rehearsal room</p>
          <h1>{tag.title}</h1>
          {subtitle && <p className="workspace-subtitle">{subtitle}</p>}
        </div>
        <dl className="workspace-facts">
          <div><dt>Key</dt><dd>{tag.key || "—"}</dd></div>
          <div><dt>Style</dt><dd>{tag.style}</dd></div>
          <div><dt>Rating</dt><dd>{tag.rating === null ? "—" : `${tag.rating.toFixed(1)} ★`}</dd></div>
          <div><dt>Listens</dt><dd>{formatCount(tag.downloads)}</dd></div>
        </dl>
      </header>

      <div className="workspace-grid">
        <ScoreViewer
          originalUrl={tag.sheet.url}
          sheetType={tag.sheet.type}
          tagId={tag.id}
          title={tag.title}
        />
        <Mixer key={tag.id} tag={tag} />
      </div>

      <section className="tag-notes" aria-labelledby="about-heading">
        <div>
          <p className="eyebrow">About this tag</p>
          <h2 id="about-heading">Credits & notes</h2>
        </div>
        <div className="tag-notes-grid">
          <div className="note-wide"><h3>Learning-track audio</h3><p><strong>{quality.label}.</strong> {quality.description}</p></div>
          {tag.arranger && <div><h3>Arranged by</h3><p>{tag.arranger}</p></div>}
          {tag.quartet && <div><h3>Learning tracks</h3><p>{tag.quartet}</p></div>}
          {tag.provider && <div><h3>Provided by</h3><p>{tag.provider}</p></div>}
          {tag.lyrics && <div className="note-wide"><h3>Lyrics</h3><p>{tag.lyrics}</p></div>}
          {tag.notes && <div className="note-wide"><h3>Source notes</h3><p>{tag.notes}</p></div>}
        </div>
        <a className="source-link" href={tag.sourcePageUrl} rel="noreferrer" target="_blank">
          View original tag page <Icon name="external" size={16} />
        </a>
      </section>
    </article>
  );
}

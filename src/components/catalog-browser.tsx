"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import { formatCount, formatDate } from "@/lib/format";
import type { CatalogListResponse, TagSummary } from "@/lib/types";

const PAGE_SIZE = 36;

function TagCard({ tag, index }: { tag: TagSummary; index: number }) {
  const detail = [tag.alternateTitle && `aka “${tag.alternateTitle}”`, tag.version]
    .filter(Boolean)
    .join(" · ");

  return (
    <Link className="tag-card" href={`/tags/${tag.id}`} style={{ "--card-order": index } as React.CSSProperties}>
      <div className="tag-card-topline">
        <span className="tag-id">#{tag.id}</span>
      </div>
      <div className="tag-card-copy">
        <h3>{tag.title}</h3>
        {detail && <p className="tag-card-detail">{detail}</p>}
      </div>
      <dl className="tag-card-meta">
        <div>
          <dt>Style</dt>
          <dd>{tag.style}</dd>
        </div>
        <div>
          <dt>Key</dt>
          <dd>{tag.key || "—"}</dd>
        </div>
        <div>
          <dt>Rating</dt>
          <dd>{tag.rating === null ? "—" : `${tag.rating.toFixed(1)} ★`}</dd>
        </div>
      </dl>
      <div className="tag-card-footer">
        <span>{tag.arranger ? `Arr. ${tag.arranger}` : "Arranger unknown"}</span>
        <span className="card-arrow" aria-hidden="true"><Icon name="chevron-right" size={18} /></span>
      </div>
    </Link>
  );
}

function CatalogSkeleton() {
  return (
    <div className="tag-grid" aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => (
        <div className="tag-card tag-card-skeleton" key={index}>
          <span className="skeleton skeleton-short" />
          <span className="skeleton skeleton-title" />
          <span className="skeleton skeleton-line" />
          <span className="skeleton skeleton-meta" />
        </div>
      ))}
    </div>
  );
}

export function CatalogBrowser() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [style, setStyle] = useState("");
  const [sort, setSort] = useState("relevance");
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const requestUrl = useMemo(() => {
    const parameters = new URLSearchParams({
      page: String(page),
      limit: String(PAGE_SIZE),
      sort,
    });
    if (query) parameters.set("q", query);
    if (style) parameters.set("style", style);
    parameters.set("attempt", String(retry));
    return `/api/tags?${parameters}`;
  }, [page, query, retry, sort, style]);
  const [requestState, setRequestState] = useState<{
    key: string;
    data: CatalogListResponse | null;
    error: string;
  }>({ key: "", data: null, error: "" });
  const data = requestState.data;
  const loading = requestState.key !== requestUrl;
  const error = requestState.key === requestUrl ? requestState.error : "";

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(input.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(requestUrl, { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as CatalogListResponse | { error?: string };
        if (!response.ok) throw new Error("error" in payload ? payload.error : "The catalog is unavailable.");
        setRequestState({ key: requestUrl, data: payload as CatalogListResponse, error: "" });
      })
      .catch((requestError: unknown) => {
        if ((requestError as Error).name !== "AbortError") {
          setRequestState((current) => ({
            key: requestUrl,
            data: current.data,
            error: requestError instanceof Error ? requestError.message : "The catalog is unavailable.",
          }));
        }
      });

    return () => controller.abort();
  }, [requestUrl]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const resultMessage = useMemo(() => {
    if (!data) return "Loading the library…";
    if (query) return `${formatCount(data.total)} ${data.total === 1 ? "match" : "matches"} for “${query}”`;
    return `${formatCount(data.total)} rehearsal-ready tags`;
  }, [data, query]);

  function updateStyle(nextStyle: string) {
    setStyle(nextStyle);
    setPage(1);
  }

  function updateSort(nextSort: string) {
    setSort(nextSort);
    setPage(1);
  }

  return (
    <>
      <section className="catalog-hero">
        <div className="hero-music-lines" aria-hidden="true"><i /><i /><i /><i /><i /></div>
        <div className="hero-copy">
          <p className="eyebrow"><Icon name="spark" size={16} /> Four parts. Your mix.</p>
          <h1>Find your note.<br /><em>Hear the lock.</em></h1>
          <p className="hero-description">
            Search the four-part tag library, follow a cleanly cropped score, and shape every voice around you.
          </p>
          <div className="hero-actions">
            <Link className="button button-secondary" href="/tools">
              <Icon name="music" size={18} /> Open pitch pipe & piano
            </Link>
          </div>
        </div>
        <div className="hero-stat" aria-label={data ? `${data.catalogSize} compatible tags` : "Loading tag count"}>
          <strong>{data ? formatCount(data.catalogSize) : "—"}</strong>
          <span>complete<br />four-part tags</span>
        </div>
      </section>

      <section className="catalog-section" aria-labelledby="catalog-heading">
        <div className="search-panel">
          <label className="search-field">
            <span className="sr-only">Search tags, arrangers, or versions</span>
            <Icon name="search" size={23} />
            <input
              autoComplete="off"
              onChange={(event) => setInput(event.target.value)}
              placeholder="Search a title, arranger, or version…"
              type="search"
              value={input}
            />
            {input && (
              <button aria-label="Clear search" className="search-clear" onClick={() => setInput("")} type="button">×</button>
            )}
          </label>
          <div className="catalog-filters">
            <label>
              <span>Voicing</span>
              <select onChange={(event) => updateStyle(event.target.value)} value={style}>
                <option value="">All styles</option>
                {data?.styles.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label>
              <span>Sort</span>
              <select onChange={(event) => updateSort(event.target.value)} value={sort}>
                <option value="relevance">Best match</option>
                <option value="title">Title A–Z</option>
                <option value="rating">Highest rated</option>
                <option value="popular">Most downloaded</option>
                <option value="recent">Recently updated</option>
              </select>
            </label>
          </div>
        </div>

        <div className="catalog-heading-row">
          <div>
            <p className="eyebrow">Ready to rehearse</p>
            <h2 id="catalog-heading">{resultMessage}</h2>
          </div>
          {data && <p className="catalog-freshness">Library updated {formatDate(data.sourceStamp || data.fetchedAt)}</p>}
        </div>

        {error ? (
          <div className="catalog-error" role="alert">
            <span aria-hidden="true">♩</span>
            <h3>We couldn’t reach the tag library.</h3>
            <p>{error}</p>
            <button className="button button-primary" onClick={() => setRetry((value) => value + 1)} type="button">Try again</button>
          </div>
        ) : !data || (loading && !data) ? (
          <CatalogSkeleton />
        ) : data.items.length ? (
          <>
            <div className={`tag-grid ${loading ? "is-refreshing" : ""}`} aria-busy={loading}>
              {data.items.map((tag, index) => <TagCard index={index} key={tag.id} tag={tag} />)}
            </div>
            <nav className="pagination" aria-label="Catalog pages">
              <button
                className="button button-secondary"
                disabled={page <= 1 || loading}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                type="button"
              >
                <Icon name="chevron-left" size={18} /> Previous
              </button>
              <span>Page {page} of {totalPages}</span>
              <button
                className="button button-secondary"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                type="button"
              >
                Next <Icon name="chevron-right" size={18} />
              </button>
            </nav>
          </>
        ) : (
          <div className="catalog-empty">
            <span aria-hidden="true">𝄽</span>
            <h3>No tags found on that note.</h3>
            <p>Try fewer words or choose another voicing.</p>
            <button className="button button-secondary" onClick={() => { setInput(""); updateStyle(""); }} type="button">Clear filters</button>
          </div>
        )}
      </section>
    </>
  );
}

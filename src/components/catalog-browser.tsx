"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import { formatCount } from "@/lib/format";
import { isCatalogSort } from "@/lib/search";
import type { CatalogListResponse, TagSummary } from "@/lib/types";

const PAGE_SIZE = 36;

function updateSearch(values: Record<string, string>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  // Keep the current results in history without adding an entry per keystroke.
  // Next.js also updates useSearchParams when native history is changed.
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

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
  const parameters = useSearchParams();
  const urlInput = parameters.get("q") ?? "";
  // Input changes must be synchronous to preserve the caret; Next updates the
  // URL in a transition. Also reconcile input when Back/Forward restores a URL.
  const [input, setInput] = useState(urlInput);
  const [lastUrlInput, setLastUrlInput] = useState(urlInput);
  if (lastUrlInput !== urlInput) {
    setLastUrlInput(urlInput);
    setInput(urlInput);
  }
  const query = urlInput.trim();
  const style = parameters.get("style") ?? "";
  const requestedSort = parameters.get("sort") ?? "relevance";
  const sort = isCatalogSort(requestedSort) ? requestedSort : "relevance";
  const requestedPage = Number(parameters.get("page") ?? 1);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
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
    const controller = new AbortController();
    // Debounce requests, while saving the URL immediately even if a tag is opened
    // before the debounce finishes. Restoring a URL must not reset its page.
    const timer = window.setTimeout(() => {
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
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [requestUrl]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const resultMessage = useMemo(() => {
    if (!data) return "Loading the library…";
    if (query) return `${formatCount(data.total)} ${data.total === 1 ? "match" : "matches"} for “${query}”`;
    return `${formatCount(data.total)} rehearsal-ready tags`;
  }, [data, query]);

  function updateStyle(nextStyle: string) {
    updateSearch({ style: nextStyle, page: "" });
  }

  function updateInput(value: string) {
    setInput(value);
    updateSearch({ q: value, page: "" });
  }

  function updateSort(nextSort: string) {
    updateSearch({ sort: nextSort === "relevance" ? "" : nextSort, page: "" });
  }

  return (
    <>
      <section className="catalog-hero">
        <div className="hero-music-lines" aria-hidden="true"><i /><i /><i /><i /><i /></div>
        <div className="hero-copy">
          <h1>Find a <em>tag.</em></h1>
        </div>
      </section>

      <section className="catalog-section" aria-labelledby="catalog-heading">
        <div className="search-panel">
          <label className="search-field">
            <span className="sr-only">Search tags, arrangers, or versions</span>
            <Icon name="search" size={23} />
            <input
              autoComplete="off"
              onChange={(event) => updateInput(event.target.value)}
              placeholder="Search a title, arranger, or version…"
              type="search"
              value={input}
            />
            {input && (
              <button aria-label="Clear search" className="search-clear" onClick={() => updateInput("")} type="button">×</button>
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
            <h2 id="catalog-heading">{resultMessage}</h2>
          </div>
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
                onClick={() => updateSearch({ page: page > 2 ? String(page - 1) : "" })}
                type="button"
              >
                <Icon name="chevron-left" size={18} /> Previous
              </button>
              <span>Page {page} of {totalPages}</span>
              <button
                className="button button-secondary"
                disabled={page >= totalPages || loading}
                onClick={() => updateSearch({ page: String(Math.min(totalPages, page + 1)) })}
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
            <button className="button button-secondary" onClick={() => updateSearch({ q: "", style: "", page: "" })} type="button">Clear filters</button>
          </div>
        )}
      </section>
    </>
  );
}

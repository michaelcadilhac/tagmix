"use client";

import Image from "next/image";
import { useState } from "react";
import { Icon } from "@/components/icons";
import { NoteTools } from "@/components/note-tools";

type ScoreViewerProps = {
  originalUrl: string;
  sheetType: string;
  tagId: number;
  title: string;
};

export function ScoreViewer({ originalUrl, sheetType, tagId, title }: ScoreViewerProps) {
  const [zoom, setZoom] = useState(100);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  function changeZoom(change: number) {
    setZoom((value) => Math.min(180, Math.max(70, value + change)));
  }

  return (
    <section className="workspace-panel score-panel" aria-labelledby="score-heading">
      <header className="panel-header">
        <div>
          <h2 id="score-heading">Sheet music</h2>
        </div>
        <div className="score-tools" aria-label="Score zoom controls">
          <button aria-label="Zoom out" disabled={zoom <= 70} onClick={() => changeZoom(-10)} type="button">
            <Icon name="zoom-out" size={18} />
          </button>
          <span>{zoom}%</span>
          <button aria-label="Zoom in" disabled={zoom >= 180} onClick={() => changeZoom(10)} type="button">
            <Icon name="zoom-in" size={18} />
          </button>
        </div>
      </header>

      <div className={`score-stage ${loading ? "is-loading" : ""} ${failed ? "has-error" : ""}`}>
        {loading && !failed && (
          <div className="score-loading" role="status">
            <span className="loading-note">♪</span>
            <strong>Preparing the score</strong>
          </div>
        )}
        {failed ? (
          <div className="score-error" role="alert">
            <span aria-hidden="true">♭</span>
            <strong>The score preview isn’t available.</strong>
            <p>You can still open the original {sheetType.toLocaleUpperCase()} score.</p>
            <a className="button button-secondary" href={originalUrl} rel="noreferrer" target="_blank">
              Open original <Icon name="external" size={16} />
            </a>
          </div>
        ) : (
          <div className={`score-scroll ${loading ? "is-loading" : ""}`}>
            <div className="score-image-wrap" style={{ width: `${zoom}%` }}>
              <Image
                alt={`Sheet music for ${title}`}
                height={1800}
                onError={() => { setFailed(true); setLoading(false); }}
                onLoad={() => setLoading(false)}
                priority
                sizes="(max-width: 900px) 100vw, 60vw"
                src={`/api/tags/${tagId}/sheet`}
                unoptimized
                width={1400}
              />
            </div>
          </div>
        )}
      </div>
      <footer className="score-footer">
        <a href={originalUrl} rel="noreferrer" target="_blank">Original file <Icon name="external" size={14} /></a>
      </footer>
      <NoteTools collapsible />
    </section>
  );
}

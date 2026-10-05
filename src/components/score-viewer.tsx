"use client";

import Image from "next/image";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { NoteTools } from "@/components/note-tools";

type ScoreViewerProps = {
  originalUrl: string;
  sheetType: string;
  tagId: number;
  title: string;
  pitchSemitones: number;
};

export function ScoreViewer({ originalUrl, sheetType, tagId, title, pitchSemitones }: ScoreViewerProps) {
  const [zoom, setZoom] = useState(100);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const [fullscreenZoom, setFullscreenZoom] = useState(100);
  const [fullscreen, setFullscreen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const fullscreenSurface = useRef<HTMLDivElement>(null);
  const fullscreenScroll = useRef<HTMLDivElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const zoomRef = useRef(fullscreenZoom);
  const anchor = useRef<{ x: number; y: number; left: number; top: number; ratio: number } | null>(null);

  useLayoutEffect(() => {
    zoomRef.current = fullscreenZoom;
    const scroller = fullscreenScroll.current;
    if (scroller && anchor.current) {
      const { x, y, left, top, ratio } = anchor.current;
      scroller.scrollLeft = (left + x) * ratio - x;
      scroller.scrollTop = (top + y) * ratio - y;
      anchor.current = null;
    }
  }, [fullscreenZoom]);

  useEffect(() => {
    if (!fullscreen) return;
    const scroller = fullscreenScroll.current;
    if (!scroller) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    let pinch: { distance: number; zoom: number } | null = null;
    const distance = (touches: TouchList) => Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    );
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      event.preventDefault();
      pinch = { distance: distance(event.touches), zoom: zoomRef.current };
    };
    const move = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !pinch) return;
      event.preventDefault();
      const next = Math.min(400, Math.max(50, Math.round(pinch.zoom * distance(event.touches) / Math.max(1, pinch.distance))));
      if (next === zoomRef.current) return;
      const bounds = scroller.getBoundingClientRect();
      anchor.current = {
        x: (event.touches[0].clientX + event.touches[1].clientX) / 2 - bounds.left,
        y: (event.touches[0].clientY + event.touches[1].clientY) / 2 - bounds.top,
        left: scroller.scrollLeft, top: scroller.scrollTop, ratio: next / zoomRef.current,
      };
      setFullscreenZoom(next);
    };
    const end = () => { pinch = null; };
    scroller.addEventListener("touchstart", start, { passive: false });
    scroller.addEventListener("touchmove", move, { passive: false });
    scroller.addEventListener("touchend", end);
    scroller.addEventListener("touchcancel", end);
    const fullscreenChanged = () => {
      if (!document.fullscreenElement) dialog.current?.close();
    };
    document.addEventListener("fullscreenchange", fullscreenChanged);
    return () => {
      document.body.style.overflow = previousOverflow;
      scroller.removeEventListener("touchstart", start);
      scroller.removeEventListener("touchmove", move);
      scroller.removeEventListener("touchend", end);
      scroller.removeEventListener("touchcancel", end);
      document.removeEventListener("fullscreenchange", fullscreenChanged);
    };
  }, [fullscreen]);

  function openFullscreen() {
    setFullscreenZoom(100);
    dialog.current?.showModal();
    setFullscreen(true);
    // The modal fills the viewport on browsers without element fullscreen (including iPhone Safari).
    if (fullscreenSurface.current?.requestFullscreen) void fullscreenSurface.current.requestFullscreen().catch(() => {});
  }

  function closeFullscreen() {
    if (document.fullscreenElement === fullscreenSurface.current) void document.exitFullscreen().catch(() => {});
    setFullscreen(false);
    fullscreenButton.current?.focus();
  }

  function changeZoom(change: number) {
    setZoom((value) => Math.min(180, Math.max(70, value + change)));
  }

  return (
    <section className="workspace-panel score-panel" aria-labelledby="score-heading">
      <header className="panel-header">
        <div>
          <h2 id="score-heading">Sheet music</h2>
        </div>
        <div className="score-actions">
          <div className="score-tools" aria-label="Score zoom controls">
            <button aria-label="Zoom out" disabled={zoom <= 70} onClick={() => changeZoom(-10)} type="button">
              <Icon name="zoom-out" size={18} />
            </button>
            <span>{zoom}%</span>
            <button aria-label="Zoom in" disabled={zoom >= 180} onClick={() => changeZoom(10)} type="button">
              <Icon name="zoom-in" size={18} />
            </button>
          </div>
          <button className="score-fullscreen-button" ref={fullscreenButton} aria-label="View sheet music fullscreen" disabled={loading || failed} onClick={openFullscreen} type="button">
            <Icon name="fullscreen" size={18} />
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
      <NoteTools collapsible pitchSemitones={pitchSemitones} />
      <dialog className="score-fullscreen" ref={dialog} aria-labelledby="fullscreen-score-heading" onClose={closeFullscreen}>
        <div className="score-fullscreen-content" ref={fullscreenSurface}>
          <header className="score-fullscreen-toolbar">
            <h2 id="fullscreen-score-heading">Sheet music</h2>
            <div className="score-tools" aria-label="Fullscreen score zoom controls">
              <button aria-label="Zoom out fullscreen score" disabled={fullscreenZoom <= 50} onClick={() => setFullscreenZoom((value) => Math.max(50, value - 25))} type="button"><Icon name="zoom-out" size={18} /></button>
              <button className="score-zoom-reset" aria-label="Reset fullscreen score zoom" onClick={() => setFullscreenZoom(100)} type="button">{fullscreenZoom}%</button>
              <button aria-label="Zoom in fullscreen score" disabled={fullscreenZoom >= 400} onClick={() => setFullscreenZoom((value) => Math.min(400, value + 25))} type="button"><Icon name="zoom-in" size={18} /></button>
            </div>
            <button className="score-fullscreen-exit button button-secondary" onClick={() => dialog.current?.close()} type="button" autoFocus><Icon name="x" size={18} /> Exit</button>
          </header>
          <div className="score-fullscreen-scroll" ref={fullscreenScroll} tabIndex={0} aria-label="Sheet music; pinch to zoom and swipe to pan">
            {fullscreen && <div className="score-image-wrap" style={{ width: `${fullscreenZoom}%` }}>
              <Image alt={`Sheet music for ${title}`} height={1800} width={1400} src={`/api/tags/${tagId}/sheet`} unoptimized draggable={false} />
            </div>}
          </div>
        </div>
      </dialog>
    </section>
  );
}

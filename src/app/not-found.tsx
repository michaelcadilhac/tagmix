import Link from "next/link";

export default function NotFound() {
  return (
    <section className="empty-page">
      <span className="empty-page-note" aria-hidden="true">♭</span>
      <p className="eyebrow">Lost the pitch?</p>
      <h1>That tag isn’t in this set.</h1>
      <p>It may not have all four learning tracks and sheet music.</p>
      <Link className="button button-primary" href="/">Browse available tags</Link>
    </section>
  );
}

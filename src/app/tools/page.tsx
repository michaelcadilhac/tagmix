import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { NoteTools } from "@/components/note-tools";

export const metadata: Metadata = {
  title: "Pitch tools",
  description: "Use a chromatic pitch pipe and piano keyboard to find rehearsal notes.",
};

export default function ToolsPage() {
  return (
    <article className="tools-page">
      <Link className="back-link" href="/"><Icon name="arrow-left" size={17} /> Back to tag library</Link>
      <header className="tools-page-hero">
        <p className="eyebrow"><Icon name="music" size={16} /> Quick reference</p>
        <h1>Find your note.</h1>
        <p>Use a pitch-pipe tone or the piano keyboard before a rehearsal—no tag required.</p>
      </header>
      <NoteTools />
    </article>
  );
}

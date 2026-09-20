import type { Metadata } from "next";
import { NoteTools } from "@/components/note-tools";

export const metadata: Metadata = {
  title: "Pitch tools",
  description: "Use a chromatic pitch pipe and piano keyboard to find rehearsal notes.",
};

export default function ToolsPage() {
  return (
    <article className="tools-page">
      <header className="tools-page-hero">
        <h1>Pitch pipe & piano</h1>
      </header>
      <NoteTools />
    </article>
  );
}

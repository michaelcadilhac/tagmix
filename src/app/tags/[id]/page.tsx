import type { Metadata } from "next";
import { TagWorkspace } from "@/components/tag-workspace";
import { getTag } from "@/lib/catalog";
import { pitchFromUrl } from "@/lib/pitch";

type PageProps = { params: Promise<{ id: string }>; searchParams: Promise<{ pitch?: string | string[] }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  try {
    const tag = await getTag(Number(id));
    return tag
      ? { title: tag.title, description: `Practice ${tag.title} with sheet music and a four-part mixer.` }
      : { title: `Tag ${id}` };
  } catch {
    return { title: `Tag ${id}` };
  }
}

export default async function TagPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const initialPitch = pitchFromUrl((await searchParams).pitch);
  return <TagWorkspace key={`${id}:${initialPitch ?? "device"}`} tagId={id} initialPitch={initialPitch} />;
}

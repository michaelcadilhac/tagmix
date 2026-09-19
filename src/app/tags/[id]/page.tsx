import type { Metadata } from "next";
import { TagWorkspace } from "@/components/tag-workspace";
import { getTag } from "@/lib/catalog";

type PageProps = { params: Promise<{ id: string }> };

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

export default async function TagPage({ params }: PageProps) {
  const { id } = await params;
  return <TagWorkspace tagId={id} />;
}

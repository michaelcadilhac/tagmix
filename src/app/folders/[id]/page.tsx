import { FolderEditor } from "@/components/saved-folders";
export const metadata = { title: "Saved folder" };
export default async function FolderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <section className="library-page"><FolderEditor key={id} folderId={id} /></section>;
}

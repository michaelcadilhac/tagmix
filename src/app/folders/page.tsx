import { SavedFolders } from "@/components/saved-folders";
export const metadata = { title: "Saved folders" };
export default function FoldersPage() {
  return <section className="library-page"><SavedFolders /></section>;
}

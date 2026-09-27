import { permanentRedirect } from "next/navigation";
import { accountStore } from "@/lib/account-store";
import { isAccountError } from "@/lib/account-errors";
import { SharedFolderView } from "@/components/saved-folders";
import type { SharedFolder } from "@/lib/account-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Shared folder", robots: { index: false, follow: false } };
export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let canonical = token;
  let initialFolder: SharedFolder | undefined;
  let initialError = "";
  try {
    const store = accountStore();
    canonical = store.canonicalShareToken(token);
    // Use the same public projection as the shared API, never account data.
    initialFolder = store.sharedFolder(canonical);
  } catch (error) {
    if (!isAccountError(error) || error.status !== 404) throw error;
    initialError = error.message;
  }
  if (canonical !== token) permanentRedirect(`/shared/${canonical}`);
  return <section className="library-page"><SharedFolderView key={token} token={token} initialFolder={initialFolder} initialError={initialError} /></section>;
}

import { permanentRedirect } from "next/navigation";
import { accountStore } from "@/lib/account-store";
import { isAccountError } from "@/lib/account-errors";
import { SharedFolderView } from "@/components/saved-folders";
export const metadata = { title: "Shared folder", robots: { index: false, follow: false } };
export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let canonical = token;
  try { canonical = accountStore().canonicalShareToken(token); }
  catch (error) { if (!isAccountError(error) || error.status !== 404) throw error; }
  if (canonical !== token) permanentRedirect(`/shared/${canonical}`);
  return <section className="library-page"><SharedFolderView key={token} token={token} /></section>;
}

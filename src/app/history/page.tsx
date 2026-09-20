import { RecentHistory } from "@/components/recent-history";
export const metadata = { title: "Recently viewed" };
export default function HistoryPage() {
  return <section className="library-page"><RecentHistory /></section>;
}

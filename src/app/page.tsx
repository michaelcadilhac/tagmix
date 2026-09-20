import { CatalogBrowser } from "@/components/catalog-browser";
import { Suspense } from "react";

export default function HomePage() {
  return <Suspense fallback={<p role="status">Loading the library…</p>}><CatalogBrowser /></Suspense>;
}

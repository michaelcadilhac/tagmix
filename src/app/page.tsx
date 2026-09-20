import { CatalogBrowser } from "@/components/catalog-browser";
import { getCatalogList } from "@/lib/catalog-list";
import { catalogRequestUrl, readCatalogQuery } from "@/lib/catalog-query";

export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (value !== undefined) parameters.set(key, Array.isArray(value) ? value[0] : value);
  }
  parameters.set("limit", "36");
  const query = readCatalogQuery(parameters);
  let data;
  try {
    data = await getCatalogList(parameters);
  } catch {
    return <CatalogBrowser initialError="The tag catalog could not be loaded." />;
  }
  return <CatalogBrowser initialResult={{ key: catalogRequestUrl(query), query: query.query, data }} />;
}

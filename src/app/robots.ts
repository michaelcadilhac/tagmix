import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Shared pages are readable by link; their noindex metadata keeps them
      // out of search results without blocking tools from reading the list.
      disallow: ["/account", "/folders", "/history", "/api/account/", "/api/shared/"],
    },
  };
}

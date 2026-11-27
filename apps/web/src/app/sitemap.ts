import type { MetadataRoute } from "next";
import { site } from "@/lib/site";
import { getRegistryReader } from "@/server/registry";
import { sitemapEntries } from "@/server/sitemap";

/**
 * Rendered on request, like the index explorer: the registry reader bounds its reads with its own cache, and a
 * sitemap built at build time would list the build machine's view of the registry.
 */
export const revalidate = 0;

/**
 * Public pages and every published index (see `src/lib/public-routes.ts`). Routes under /dev are internal
 * references and are excluded. /wallet and /portfolio are listed without a query: a lookup of one address
 * (`/wallet?address=`) is marked `noindex` by the page.
 */
export default function sitemap(): Promise<MetadataRoute.Sitemap> {
  return sitemapEntries(site.url, getRegistryReader());
}

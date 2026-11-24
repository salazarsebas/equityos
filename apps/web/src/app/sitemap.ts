import type { MetadataRoute } from "next";
import { site } from "@/lib/site";

/**
 * Public pages only. Routes under /dev are internal references and are excluded. /wallet and /portfolio are listed
 * without a query: a lookup of one address (`/wallet?address=`) is marked `noindex` by the page.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    "/",
    "/indexes",
    "/assets",
    "/studio",
    "/portfolio",
    "/wallet",
    "/developers",
    "/developers/api",
    "/developers/spec",
  ].map((path) => ({
    url: new URL(path, site.url).toString(),
  }));
}

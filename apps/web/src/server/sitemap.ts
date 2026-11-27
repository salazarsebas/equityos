import "server-only";
import { PUBLIC_PAGES } from "@/lib/public-routes";
import { MAX_PAGE_SIZE, type RegistryReader } from "./registry";

/**
 * One URL of the sitemap, structurally the entry Next.js expects. Declared here so that this module, and its unit
 * tests, do not load the Next.js global types.
 */
export interface SitemapEntry {
  readonly url: string;
  readonly lastModified?: Date;
}

/** The sitemap protocol allows at most this many URLs in one file. */
export const SITEMAP_URL_LIMIT = 50_000;

/**
 * The public pages, then one entry per published index at its canonical URL with the time of its latest version.
 *
 * When the registry is not deployed, or cannot be read, only the fixed pages are listed: the sitemap is a hint to
 * crawlers, and an incomplete one is better than none. A read failure is logged so it is not lost.
 */
export async function sitemapEntries(
  origin: string,
  reader: Pick<RegistryReader, "listIndexes">,
): Promise<SitemapEntry[]> {
  const fixed: SitemapEntry[] = PUBLIC_PAGES.map((path) => ({ url: new URL(path, origin).toString() }));
  try {
    const indexes: SitemapEntry[] = [];
    const room = SITEMAP_URL_LIMIT - fixed.length;
    let offset = 0;
    for (;;) {
      const page = await reader.listIndexes({ offset, limit: MAX_PAGE_SIZE });
      if (page.status !== "ok") break;
      for (const { identifier, latest } of page.indexes) {
        if (indexes.length >= room) break;
        indexes.push({
          url: new URL(`/indexes/${identifier}`, origin).toString(),
          lastModified: new Date(Number(latest.publishedAt) * 1000),
        });
      }
      offset += page.indexes.length;
      if (page.indexes.length === 0 || offset >= page.total || indexes.length >= room) break;
    }
    return [...fixed, ...indexes];
  } catch (error) {
    console.error("sitemap: the registry could not be read, only the fixed pages are listed", error);
    return fixed;
  }
}

/**
 * The page routes a search engine may index, and the ones it may not with the reason. The sitemap lists the public
 * ones, and a test fails when a page route under `src/app` appears in neither list, so a new page is classified on
 * purpose.
 */
export const PUBLIC_PAGES = [
  "/",
  "/indexes",
  "/assets",
  "/studio",
  "/portfolio",
  "/wallet",
  "/developers",
  "/developers/api",
  "/developers/spec",
  "/network",
] as const;

/**
 * Route patterns as they appear under `src/app`, without the route groups. Index pages are public but are listed
 * one by one from the registry, so the pattern itself is not a URL.
 */
export const NON_SITEMAP_PAGES: Readonly<Record<string, string>> = {
  "/dev/components": "internal component reference, disallowed in robots.txt",
  "/indexes/[identifier]": "listed per index from the registry",
  "/indexes/[identifier]/versions/[version]": "a past version: the canonical URL of an index is its latest version",
};

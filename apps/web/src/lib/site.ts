/** Product facts shared by page metadata and page content. */
export const site = {
  name: "EquityOS",
  tagline: "Programmable index infrastructure for tokenized stocks on Base.",
  description:
    "EquityOS lets anyone define an index of tokenized stocks as a transparent, deterministic methodology, publish it, and let others replicate it from their own wallets.",
  repositoryUrl: "https://github.com/salazarsebas/equityos",
  /** Public origin of the deployment, used for canonical URLs, robots.txt and the sitemap. */
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
} as const;

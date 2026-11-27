import { expect, type Page, test } from "@playwright/test";
import { PUBLIC_PAGES } from "../src/lib/public-routes";

/**
 * What a search engine reads: on every public page a title, a description, a canonical URL, Open Graph data and
 * no `noindex`; structured data on the landing and index pages; a sitemap whose URLs all resolve and include the
 * published indexes; self-hosted fonts, each one preloaded; no unsized image.
 */
const DIVERSIFIED = "diversified-equity-d622e2a5";
const INDEX_PAGE = `/indexes/${DIVERSIFIED}`;
const pages: readonly string[] = [...PUBLIC_PAGES, INDEX_PAGE];

interface PageMetadata {
  readonly title: string;
  readonly description: string | null;
  readonly canonical: string | null;
  readonly ogTitle: string | null;
  readonly ogDescription: string | null;
  readonly robots: string | null;
  readonly lang: string | null;
  readonly h1Count: number;
  readonly unsizedImages: number;
}

function readMetadata(page: Page): Promise<PageMetadata> {
  return page.evaluate(() => {
    const meta = (selector: string) => document.head.querySelector(selector)?.getAttribute("content") ?? null;
    return {
      title: document.title,
      description: meta('meta[name="description"]'),
      canonical: document.head.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null,
      ogTitle: meta('meta[property="og:title"]'),
      ogDescription: meta('meta[property="og:description"]'),
      robots: meta('meta[name="robots"]'),
      lang: document.documentElement.getAttribute("lang"),
      h1Count: document.querySelectorAll("h1").length,
      unsizedImages: [...document.images].filter(
        (image) => !image.hasAttribute("width") || !image.hasAttribute("height"),
      ).length,
    };
  });
}

async function jsonLd(page: Page): Promise<Record<string, unknown>[]> {
  const texts = await page.locator('script[type="application/ld+json"]').allTextContents();
  return texts.map((text) => JSON.parse(text) as Record<string, unknown>);
}

test.describe("metadata of every public page", () => {
  for (const route of pages) {
    test(`${route} has a title, a description, a canonical URL and Open Graph data`, async ({ page }) => {
      const response = await page.goto(route);
      expect(response?.status()).toBe(200);
      const metadata = await readMetadata(page);
      expect(metadata.title.length).toBeGreaterThan(0);
      expect(metadata.title.length).toBeLessThanOrEqual(90);
      expect(metadata.description?.length ?? 0).toBeGreaterThanOrEqual(50);
      expect(metadata.description?.length ?? 0).toBeLessThanOrEqual(300);
      expect(metadata.canonical === null ? null : new URL(metadata.canonical).pathname).toBe(route);
      expect(metadata.ogTitle).not.toBeNull();
      expect(metadata.ogDescription).not.toBeNull();
      expect(metadata.robots ?? "").not.toContain("noindex");
      expect(metadata.lang).toBe("en");
      expect(metadata.h1Count).toBe(1);
      expect(metadata.unsizedImages).toBe(0);
    });
  }

  test("no two public pages share a title or a description", async ({ page }) => {
    const titles: string[] = [];
    const descriptions: string[] = [];
    for (const route of pages) {
      await page.goto(route);
      const metadata = await readMetadata(page);
      titles.push(metadata.title);
      descriptions.push(metadata.description ?? "");
    }
    expect(new Set(titles).size).toBe(pages.length);
    expect(new Set(descriptions).size).toBe(pages.length);
  });
});

test.describe("structured data", () => {
  test("the landing page describes the site", async ({ page }) => {
    await page.goto("/");
    const description = await page.locator('meta[name="description"]').getAttribute("content");
    const [data, ...rest] = await jsonLd(page);
    expect(rest).toEqual([]);
    expect(data).toMatchObject({ "@context": "https://schema.org", "@type": "WebSite", name: "EquityOS", description });
  });

  test("an index page describes the version it shows, with the values on the page", async ({ page }) => {
    await page.goto(INDEX_PAGE);
    const name = (await page.getByRole("heading", { level: 1 }).textContent()) ?? "";
    const description = await page.locator('meta[name="description"]').getAttribute("content");
    const tag = (await page.getByText(/^v\d+, latest$/).textContent()) ?? "";
    const [data, ...rest] = await jsonLd(page);
    expect(rest).toEqual([]);
    expect(data).toMatchObject({ "@type": "Dataset", name, description, version: tag.slice(1, tag.indexOf(",")) });
    expect(new URL(String(data?.url)).pathname).toBe(INDEX_PAGE);
    expect(Date.parse(String(data?.dateModified))).toBeGreaterThanOrEqual(Date.parse(String(data?.datePublished)));
  });
});

test.describe("crawling", () => {
  test("every sitemap URL resolves, and the published indexes are listed", async ({ page, request }) => {
    const sitemap = await request.get("/sitemap.xml");
    expect(sitemap.status()).toBe(200);
    const paths = [...(await sitemap.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map(
      ([, url]) => new URL(url ?? "").pathname,
    );
    expect(paths.slice(0, PUBLIC_PAGES.length)).toEqual([...PUBLIC_PAGES]);
    expect(paths).toContain(INDEX_PAGE);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      expect((await readMetadata(page)).robots ?? "", path).not.toContain("noindex");
    }
  });

  test("robots.txt keeps crawlers out of the internal pages and points to the sitemap", async ({ request }) => {
    const text = await (await request.get("/robots.txt")).text();
    expect(text).toContain("Disallow: /dev/");
    expect(text).toMatch(/^Sitemap: https?:\/\/[^\s]+\/sitemap\.xml$/m);
  });
});

test.describe("fonts", () => {
  for (const route of ["/", INDEX_PAGE]) {
    test(`${route} loads only self-hosted fonts, each one preloaded`, async ({ page }) => {
      const loaded: string[] = [];
      page.on("request", (request) => {
        if (request.resourceType() === "font") loaded.push(new URL(request.url()).pathname);
      });
      const response = await page.goto(route);
      await page.evaluate(() => document.fonts.ready);
      const preloaded = (response?.headers().link ?? "")
        .split(",")
        .filter((entry) => entry.includes('as="font"'))
        .map((entry) => /<([^>]+)>/.exec(entry)?.[1] ?? "");
      expect(loaded.length).toBeGreaterThan(0);
      for (const path of loaded) {
        expect(path).toMatch(/^\/_next\/static\/media\/[^/]+\.woff2$/);
        expect(preloaded).toContain(path);
      }
    });
  }
});

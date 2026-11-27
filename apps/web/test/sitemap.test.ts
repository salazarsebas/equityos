import { describe, expect, spyOn, test } from "bun:test";
import { PUBLIC_PAGES } from "../src/lib/public-routes";
import type { RegistryReader } from "../src/server/registry/reader";
import type { IndexSummary } from "../src/server/registry/types";
import { SITEMAP_URL_LIMIT, sitemapEntries } from "../src/server/sitemap";
import { recordedRegistry } from "./api/support";

const ORIGIN = "https://equityos.example";
type Lister = Pick<RegistryReader, "listIndexes">;

function urls(entries: readonly { url: string }[]): string[] {
  return entries.map(({ url }) => url);
}

describe("sitemap", () => {
  test("lists the public pages, then every recorded index at its canonical URL with its latest version time", async () => {
    const reader = recordedRegistry();
    const entries = await sitemapEntries(ORIGIN, reader);
    const listed = await reader.listIndexes({ limit: 50 });
    if (listed.status !== "ok") throw new Error("the recorded registry is deployed");

    expect(urls(entries.slice(0, PUBLIC_PAGES.length))).toEqual(PUBLIC_PAGES.map((path) => `${ORIGIN}${path}`));
    const indexEntries = entries.slice(PUBLIC_PAGES.length);
    expect(listed.total).toBeGreaterThan(0);
    expect(indexEntries).toHaveLength(listed.total);
    expect(indexEntries).toEqual(
      listed.indexes.map(({ identifier, latest }) => ({
        url: `${ORIGIN}/indexes/${identifier}`,
        lastModified: new Date(Number(latest.publishedAt) * 1000),
      })),
    );
    expect(new Set(urls(entries)).size).toBe(entries.length);
  });

  test("lists only the public pages when the registry holds no index", async () => {
    expect(urls(await sitemapEntries(ORIGIN, recordedRegistry("registry-empty")))).toEqual(
      PUBLIC_PAGES.map((path) => `${ORIGIN}${path}`),
    );
  });

  test("lists only the public pages when the registry is not deployed", async () => {
    const reader: Lister = {
      listIndexes: async () => ({
        status: "registry_not_deployed",
        chainId: 8453,
        registry: "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c",
        reason: "no_code",
      }),
    };
    expect(await sitemapEntries(ORIGIN, reader)).toHaveLength(PUBLIC_PAGES.length);
  });

  test("lists the public pages and logs the failure when the registry cannot be read", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const reader: Lister = {
        listIndexes: () => Promise.reject(new Error("upstream unavailable")),
      };
      expect(await sitemapEntries(ORIGIN, reader)).toHaveLength(PUBLIC_PAGES.length);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  test("reads every page of the registry and stops at the protocol limit", async () => {
    const reader = recordedRegistry();
    const first = await reader.listIndexes({ limit: 1 });
    if (first.status !== "ok") throw new Error("the recorded registry is deployed");
    const template = first.indexes[0] as IndexSummary;
    const total = SITEMAP_URL_LIMIT + 120;
    const offsets: number[] = [];
    const paged: Lister = {
      listIndexes: async (request = {}) => {
        const offset = request.offset ?? 0;
        offsets.push(offset);
        const limit = Math.min(request.limit ?? 50, total - offset);
        const indexes = Array.from({ length: limit }, (_, i) => ({
          ...template,
          identifier: `index-${offset + i}`,
        }));
        return { status: "ok", total, offset, indexes };
      },
    };
    const entries = await sitemapEntries(ORIGIN, paged);
    expect(entries).toHaveLength(SITEMAP_URL_LIMIT);
    expect(entries.at(-1)?.url).toBe(`${ORIGIN}/indexes/index-${SITEMAP_URL_LIMIT - PUBLIC_PAGES.length - 1}`);
    expect(offsets.slice(0, 3)).toEqual([0, 50, 100]);
    expect(offsets.at(-1)).toBeLessThan(SITEMAP_URL_LIMIT);
  });

  test("stops when a page comes back empty before the announced total", async () => {
    const reader: Lister = {
      listIndexes: async (request = {}) => ({ status: "ok", total: 10, offset: request.offset ?? 0, indexes: [] }),
    };
    expect(await sitemapEntries(ORIGIN, reader)).toHaveLength(PUBLIC_PAGES.length);
  });
});

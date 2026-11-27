import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { NON_SITEMAP_PAGES, PUBLIC_PAGES } from "../src/lib/public-routes";

const APP = join(import.meta.dir, "../src/app");

/** Every page route under `src/app`, as a URL pattern, without route groups. */
function pageRoutes(directory = APP): string[] {
  const routes: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "api" && directory === APP) continue;
      routes.push(...pageRoutes(path));
    } else if (entry.name === "page.tsx") {
      const segments = relative(APP, directory)
        .split(sep)
        .filter((segment) => segment !== "" && !(segment.startsWith("(") && segment.endsWith(")")));
      routes.push(`/${segments.join("/")}`);
    }
  }
  return routes.sort();
}

describe("public routes", () => {
  test("every page route is either in the sitemap or excluded with a reason", () => {
    const classified = new Set<string>([...PUBLIC_PAGES, ...Object.keys(NON_SITEMAP_PAGES)]);
    expect(pageRoutes().filter((route) => !classified.has(route))).toEqual([]);
  });

  test("names no route that does not exist", () => {
    const routes = new Set(pageRoutes());
    expect([...PUBLIC_PAGES, ...Object.keys(NON_SITEMAP_PAGES)].filter((route) => !routes.has(route))).toEqual([]);
  });

  test("lists each public page once and never one it also excludes", () => {
    expect(new Set(PUBLIC_PAGES).size).toBe(PUBLIC_PAGES.length);
    expect(PUBLIC_PAGES.filter((route) => route in NON_SITEMAP_PAGES)).toEqual([]);
  });
});

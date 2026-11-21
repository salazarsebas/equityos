import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { primaryNavigation } from "../src/lib/navigation";

describe("primary navigation", () => {
  test("has at least one entry and no duplicates", () => {
    const hrefs = primaryNavigation.map((item) => item.href);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  for (const { label, href } of primaryNavigation) {
    test(`"${label}" links to a page that exists: ${href}`, () => {
      const page = new URL(`../src/app${href === "/" ? "" : href}/page.tsx`, import.meta.url);
      expect(existsSync(page)).toBe(true);
    });
  }
});

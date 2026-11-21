import { expect, test } from "bun:test";
import manifest from "../package.json" with { type: "json" };
import { SDK_VERSION } from "../src/index.ts";

test("SDK_VERSION matches the package manifest version", () => {
  expect<string>(SDK_VERSION).toBe(manifest.version);
});

test("SDK_VERSION is a semantic version", () => {
  expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});

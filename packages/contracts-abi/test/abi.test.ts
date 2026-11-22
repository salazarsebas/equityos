import { describe, expect, test } from "bun:test";
import { ABI_SOURCES, artifactAbi, artifactsExist } from "../scripts/sources.ts";
import { indexRegistryAbi, rebalanceLogAbi } from "../src/index.ts";

/**
 * The comparison needs the output of `forge build`. Without it the tests are skipped, so that the suite runs
 * where Foundry is not installed. The `integration` CI job builds the contracts and sets
 * `CONTRACT_ARTIFACTS=required`, which turns a missing artifact into a failure instead of a skip.
 */
const required = process.env.CONTRACT_ARTIFACTS === "required";
const exported = { indexRegistryAbi, rebalanceLogAbi };

describe("ABI modules", () => {
  test("the build artifacts are present when they are required", () => {
    if (required) expect(artifactsExist()).toBe(true);
  });

  for (const { contract, exportName } of ABI_SOURCES) {
    test.skipIf(!required && !artifactsExist())(`${exportName} equals the ABI of the ${contract} artifact`, () => {
      expect<unknown>(exported[exportName]).toEqual(artifactAbi(contract));
    });
  }

  test("the registry ABI declares what the reader depends on", () => {
    const names = new Set(indexRegistryAbi.map((item) => `${item.type}:${item.name}`));
    for (const name of [
      "function:indexCount",
      "function:indexIdAt",
      "function:exists",
      "function:versionExists",
      "function:getIndex",
      "function:getVersion",
      "function:specOf",
      "function:constituentsOf",
      "event:IndexCreated",
      "event:VersionPublished",
      "event:IndexDeprecated",
    ]) {
      expect(names).toContain(name);
    }
    expect(rebalanceLogAbi.some((item) => item.type === "event" && item.name === "RebalanceRecorded")).toBe(true);
  });
});

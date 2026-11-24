import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSeedIndexes } from "../../scripts/seed/indexes";
import { RegistryConfigurationError, RegistryUpstreamError } from "../../src/server/registry/errors";
import { createRegistryReader, registryMode } from "../../src/server/registry/reader";
import { loadRegistryReplay } from "../../src/server/registry/replay";

const FIXTURE = new URL("../fixtures/registry", import.meta.url).pathname;

function directoryWith(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), "registry-replay-"));
  writeFileSync(join(directory, "registry.json"), content);
  return directory;
}

describe("registry replay", () => {
  test("serves the recorded local chain through the reader: the seed, verified as on the chain", async () => {
    const replay = loadRegistryReplay(FIXTURE);
    expect(replay.config).toMatchObject({ chainId: 31_337, confirmations: 0n });
    expect(replay.blockNumber).toBe(9n);
    const reader = createRegistryReader({ config: replay.config, client: replay.client });
    const page = await reader.listIndexes();
    if (page.status !== "ok") throw new Error(page.status);
    const seeds = buildSeedIndexes(31_337);
    expect(page.total).toBe(seeds.length);
    expect(page.indexes.map(({ latest }) => latest.specHash)).toEqual(
      seeds.map(({ versions }) => versions.at(-1)?.specHash ?? "0x"),
    );
    expect(page.indexes.map(({ latest }) => latest.conformant)).toEqual([false, true, true, true, true]);
    expect(page.indexes.map(({ head }) => head.deprecatedAt !== null)).toEqual(seeds.map((seed) => seed.deprecated));
    const versions = await reader.listVersions(page.indexes[4]?.head.indexId ?? "0x");
    expect(versions).toMatchObject({ status: "ok", total: 2 });
  });

  test("a read the recording does not hold fails as an upstream failure, never as an empty answer", async () => {
    const { config, client } = loadRegistryReplay(FIXTURE);
    const reader = createRegistryReader({ config, client });
    await expect(reader.getEvents()).rejects.toBeInstanceOf(RegistryUpstreamError);
  });

  test("a missing or malformed recording is a configuration error", () => {
    expect(() => loadRegistryReplay("/nonexistent")).toThrow(RegistryConfigurationError);
    const cases = [
      "[]",
      '{"chainId":1,"blockNumber":"1","blockTimestamp":1,"calls":[]}',
      '{"chainId":31337,"blockNumber":1,"blockTimestamp":1,"calls":[]}',
      '{"chainId":31337,"blockNumber":"1","blockTimestamp":"1","calls":[]}',
      '{"chainId":31337,"blockNumber":"1","blockTimestamp":1,"calls":{}}',
      '{"chainId":31337,"blockNumber":"1","blockTimestamp":1,"calls":[{"callData":"0x00"}]}',
    ];
    for (const content of cases) {
      expect(() => loadRegistryReplay(directoryWith(content))).toThrow("REGISTRY_REPLAY_DIR holds an unusable");
    }
  });

  test("the mode is replay exactly when the variable names a directory", () => {
    expect(registryMode({ NODE_ENV: "test" })).toBe("live");
    expect(registryMode({ NODE_ENV: "test", REGISTRY_REPLAY_DIR: "  " })).toBe("live");
    expect(registryMode({ NODE_ENV: "test", REGISTRY_REPLAY_DIR: "test/fixtures/registry" })).toBe("replay");
  });

  test("a deployment, or a production build without the test flag, refuses the replay", () => {
    const production = { NODE_ENV: "production", REGISTRY_REPLAY_DIR: "test/fixtures/registry" };
    expect(() => registryMode(production)).toThrow(RegistryConfigurationError);
    expect(() => registryMode(production)).toThrow(/REGISTRY_REPLAY_DIR is set in a production build/);
    expect(registryMode({ ...production, EQUITYOS_REPLAY_FOR_TESTS: "1" })).toBe("replay");
    for (const VERCEL_ENV of ["production", "preview", "development"]) {
      const deployed = { ...production, VERCEL_ENV, EQUITYOS_REPLAY_FOR_TESTS: "1" };
      expect(() => registryMode(deployed)).toThrow(/REGISTRY_REPLAY_DIR is set on a deployment/);
      expect(() => registryMode({ ...deployed, NODE_ENV: "development" })).toThrow(RegistryConfigurationError);
    }
  });
});

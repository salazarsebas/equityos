import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient } from "viem";
import { REFERENCE_FEEDS } from "../../src/server/market/feeds";
import {
  buildMarketSnapshot,
  createMarketData,
  listAssets,
  MissingConfigurationError,
  marketDataMode,
} from "../../src/server/market/index";
import { loadReplay } from "../../src/server/market/replay";
import { fixtureFetch, fixtureTransport, onchainFixture, TOKENS } from "./support";

const FIXTURES = fileURLToPath(new URL("../fixtures/market", import.meta.url));

describe("replay of a recording", () => {
  test("yields the same snapshot as the live path fed with the same recording", async () => {
    const at = onchainFixture.blockTimestamp;
    const { assetList, onchain } = await loadReplay(FIXTURES);
    const replayed = buildMarketSnapshot(
      { value: assetList, fetchedAt: at, servedStale: false, error: null },
      { value: onchain, fetchedAt: at, servedStale: false, error: null },
      at,
      "replay",
    );
    const live = await createMarketData({
      fetch: fixtureFetch().fetch,
      client: createPublicClient({ transport: fixtureTransport(onchainFixture).transport }),
      now: () => at,
    }).getSnapshot();
    expect(replayed).toEqual(live);
    expect(replayed.onchain.blockNumber).toBe(60_489_401n);
  });

  test("a directory without a recording is a configuration error that names the variable", async () => {
    await expect(loadReplay(join(FIXTURES, "missing"))).rejects.toThrow(MissingConfigurationError);
    await expect(loadReplay(join(FIXTURES, "missing"))).rejects.toThrow(/MARKET_REPLAY_DIR/);
  });

  test("a recording of the wrong shape is rejected instead of being read loosely", async () => {
    const directory = mkdtempSync(join(tmpdir(), "equityos-replay-"));
    writeFileSync(join(directory, "asset-list.json"), JSON.stringify({ pages: [] }));
    await expect(loadReplay(directory)).rejects.toThrow(/lists no token/);
    writeFileSync(join(directory, "asset-list.json"), "[]");
    await expect(loadReplay(directory)).rejects.toThrow(/not an object/);
  });

  test("the mode is replay exactly when the variable names a directory", () => {
    expect(marketDataMode({ NODE_ENV: "test" })).toBe("live");
    expect(marketDataMode({ NODE_ENV: "test", MARKET_REPLAY_DIR: "  " })).toBe("live");
    expect(marketDataMode({ NODE_ENV: "test", MARKET_REPLAY_DIR: "test/fixtures/market" })).toBe("replay");
    expect(marketDataMode({ NODE_ENV: "development", MARKET_REPLAY_DIR: "test/fixtures/market" })).toBe("replay");
  });

  test("a production build refuses the replay unless the browser tests set their flag", () => {
    const production = { NODE_ENV: "production", MARKET_REPLAY_DIR: "test/fixtures/market" };
    expect(() => marketDataMode(production)).toThrow(MissingConfigurationError);
    expect(() => marketDataMode(production)).toThrow(/MARKET_REPLAY_DIR is set in a production build/);
    expect(() => marketDataMode({ ...production, EQUITYOS_REPLAY_FOR_TESTS: "true" })).toThrow(
      MissingConfigurationError,
    );
    expect(marketDataMode({ ...production, EQUITYOS_REPLAY_FOR_TESTS: "1" })).toBe("replay");
    // Without a recording to replay there is nothing to refuse.
    expect(marketDataMode({ NODE_ENV: "production" })).toBe("live");
  });

  test("a deployment refuses the replay in every environment, with or without the test flag", () => {
    for (const VERCEL_ENV of ["production", "preview", "development"]) {
      for (const NODE_ENV of ["production", "development", "test"]) {
        const env = { NODE_ENV, VERCEL_ENV, MARKET_REPLAY_DIR: "test/fixtures/market", EQUITYOS_REPLAY_FOR_TESTS: "1" };
        expect(() => marketDataMode(env)).toThrow(/MARKET_REPLAY_DIR is set on a deployment/);
      }
      expect(marketDataMode({ NODE_ENV: "production", VERCEL_ENV })).toBe("live");
    }
  });

  test("the replayed service never labels a price live or delayed", async () => {
    // The recorded NVDA round was published at 23:42:40 UTC on the Friday, in the post-market session. Moving the
    // recorded clock to one minute after it would make the price live on the live path.
    const at = onchainFixture.blockTimestamp;
    const { assetList, onchain } = await loadReplay(FIXTURES);
    const updatedAt = 1_795_218_160;
    const fresh = (mode: "live" | "replay") =>
      buildMarketSnapshot(
        { value: assetList, fetchedAt: at, servedStale: false, error: null },
        {
          value: { ...onchain, blockTimestamp: updatedAt + 60 },
          fetchedAt: updatedAt + 60,
          servedStale: false,
          error: null,
        },
        updatedAt + 60,
        mode,
      );
    expect(fresh("live").assets.get(TOKENS.NVDA)?.referencePrice?.status).toBe("live");
    expect(fresh("replay").assets.get(TOKENS.NVDA)?.referencePrice?.status).toBe("last_close");
    for (const { referencePrice } of fresh("replay").assets.values()) {
      expect(["last_close", "unavailable", undefined]).toContain(referencePrice?.status);
    }
  });
});

describe("listAssets", () => {
  test("orders by symbol and filters by eligibility", async () => {
    const at = onchainFixture.blockTimestamp;
    const { assetList, onchain } = await loadReplay(FIXTURES);
    const snapshot = buildMarketSnapshot(
      { value: assetList, fetchedAt: at, servedStale: false, error: null },
      { value: onchain, fetchedAt: at, servedStale: false, error: null },
      at,
      "replay",
    );
    const all = listAssets(snapshot).map((entry) => entry.asset.symbol);
    expect(all).toHaveLength(17);
    expect(all).toEqual([...all].sort());
    expect(
      listAssets(snapshot, true)
        .map((entry) => entry.asset.address)
        .sort(),
    ).toEqual([...REFERENCE_FEEDS.keys()].sort());
    expect(listAssets(snapshot, false)).toHaveLength(4);
  });
});

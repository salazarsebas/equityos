import { describe, expect, test } from "bun:test";
import { specHash } from "@equityos/core";
import { RegistryUpstreamError } from "../../src/server/registry";
import { blockRanges, createEventScanner } from "../../src/server/registry/events";
import {
  buildSpec,
  CREATOR,
  DEPLOY_BLOCK,
  FakeChain,
  OTHER_CREATOR,
  REBALANCE_LOG,
  REGISTRY,
  rebalanceTopics,
} from "./support";

function scannerOf(
  chain: FakeChain,
  overrides: { chunkBlocks?: bigint; confirmations?: bigint; maxChunks?: number } = {},
) {
  return createEventScanner({
    client: chain.client(),
    registry: REGISTRY,
    rebalanceLog: REBALANCE_LOG,
    deployBlock: DEPLOY_BLOCK,
    chunkBlocks: overrides.chunkBlocks ?? 100n,
    confirmations: overrides.confirmations ?? 0n,
    ...(overrides.maxChunks === undefined ? {} : { maxChunksPerScan: overrides.maxChunks }),
  });
}

describe("blockRanges", () => {
  test("covers the blocks with inclusive ranges of at most the size, without gap or overlap", () => {
    expect(blockRanges(100n, 100n, 10n)).toEqual([{ from: 100n, to: 100n }]);
    expect(blockRanges(100n, 109n, 10n)).toEqual([{ from: 100n, to: 109n }]);
    expect(blockRanges(100n, 110n, 10n)).toEqual([
      { from: 100n, to: 109n },
      { from: 110n, to: 110n },
    ]);
    expect(blockRanges(0n, 24n, 10n)).toEqual([
      { from: 0n, to: 9n },
      { from: 10n, to: 19n },
      { from: 20n, to: 24n },
    ]);
    expect(blockRanges(5n, 7n, 1n)).toEqual([
      { from: 5n, to: 5n },
      { from: 6n, to: 6n },
      { from: 7n, to: 7n },
    ]);
  });

  test("is empty when there is nothing to cover and rejects an empty range size", () => {
    expect(blockRanges(101n, 100n, 10n)).toEqual([]);
    expect(() => blockRanges(0n, 10n, 0n)).toThrow(RangeError);
  });
});

describe("createEventScanner", () => {
  test("decodes the four events with their block timestamp, in order", async () => {
    const chain = new FakeChain();
    const v1 = buildSpec();
    const v2 = buildSpec({ weightsBps: [10_000] });
    const indexId = chain.createIndex(v1);
    const createdAt = chain.blockNumber;
    chain.publishVersion(indexId, { specBytes: v2.specBytes, constituents: [], composition: 0 });
    chain.recordRebalance(OTHER_CREATOR, indexId, 2);
    chain.deprecate(indexId);
    const scan = await scannerOf(chain).scan();
    const origin = (blockNumber: bigint, logIndex = 0) => ({
      blockNumber,
      blockTimestamp: chain.timestampOf(blockNumber),
      transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      logIndex,
    });
    expect(scan).toEqual({
      fromBlock: DEPLOY_BLOCK,
      scannedToBlock: chain.blockNumber,
      targetBlock: chain.blockNumber,
      complete: true,
      events: [
        {
          ...origin(createdAt),
          type: "index_created",
          indexId,
          creator: CREATOR,
          salt: expect.stringMatching(/^0x0{63}1$/),
        },
        {
          ...origin(createdAt, 1),
          type: "version_published",
          indexId,
          version: 1,
          specHash: specHash(v1.specBytes),
          creator: CREATOR,
          composition: "static",
          specSize: v1.specBytes.length,
          constituentCount: 4,
        },
        {
          ...origin(createdAt + 1n),
          type: "version_published",
          indexId,
          version: 2,
          specHash: specHash(v2.specBytes),
          creator: CREATOR,
          composition: "rule_based",
          specSize: v2.specBytes.length,
          constituentCount: 0,
        },
        { ...origin(createdAt + 2n), type: "rebalance_recorded", account: OTHER_CREATOR, indexId, version: 2 },
        { ...origin(createdAt + 3n), type: "index_deprecated", indexId, creator: CREATOR },
      ],
    });
  });

  test("requests contiguous ranges from the deploy block, none wider than the chunk size", async () => {
    const chain = new FakeChain();
    chain.maxLogRange = 100n;
    chain.createIndex(buildSpec());
    chain.mine(248n);
    chain.createIndex(buildSpec());
    const scan = await scannerOf(chain).scan();
    expect(chain.blockNumber).toBe(DEPLOY_BLOCK + 250n);
    expect(chain.logRanges).toEqual([
      { from: 1_000n, to: 1_099n },
      { from: 1_100n, to: 1_199n },
      { from: 1_200n, to: 1_250n },
    ]);
    expect(scan.events.map(({ type, blockNumber }) => `${type}@${blockNumber}`)).toEqual([
      "index_created@1001",
      "version_published@1001",
      "index_created@1250",
      "version_published@1250",
    ]);
  });

  test("finds an event in the first and in the last block of a range exactly once", async () => {
    const chain = new FakeChain();
    chain.maxLogRange = 10n;
    chain.mine(8n);
    for (let i = 0; i < 3; i += 1) chain.recordRebalance(CREATOR, specHash(new Uint8Array([i])), 1);
    const scan = await scannerOf(chain, { chunkBlocks: 10n }).scan();
    expect(chain.logRanges).toEqual([
      { from: 1_000n, to: 1_009n },
      { from: 1_010n, to: 1_011n },
    ]);
    expect(scan.events.map(({ blockNumber }) => blockNumber)).toEqual([1_009n, 1_010n, 1_011n]);
  });

  test("a later scan requests only the blocks after the last one scanned", async () => {
    const chain = new FakeChain();
    const scanner = scannerOf(chain);
    const indexId = chain.createIndex(buildSpec());
    expect((await scanner.scan()).events).toHaveLength(2);
    expect((await scanner.scan()).events).toHaveLength(2);
    expect(chain.logRanges).toEqual([{ from: 1_000n, to: 1_001n }]);
    chain.deprecate(indexId);
    const scan = await scanner.scan();
    expect(chain.logRanges).toEqual([
      { from: 1_000n, to: 1_001n },
      { from: 1_002n, to: 1_002n },
    ]);
    expect(scan.events.map(({ type }) => type)).toEqual(["index_created", "version_published", "index_deprecated"]);
    expect(scan.scannedToBlock).toBe(1_002n);
  });

  test("stays behind the head by the confirmations", async () => {
    const chain = new FakeChain();
    const scanner = scannerOf(chain, { confirmations: 5n });
    chain.createIndex(buildSpec());
    chain.mine(3n);
    expect(await scanner.scan()).toMatchObject({ events: [], scannedToBlock: null, targetBlock: 999n, complete: true });
    expect(chain.logRanges).toEqual([]);
    chain.mine(2n);
    expect(await scanner.scan()).toMatchObject({ scannedToBlock: 1_001n, targetBlock: 1_001n, complete: true });
    expect(chain.logRanges).toEqual([{ from: 1_000n, to: 1_001n }]);
  });

  test("covers a long history over several scans and says so", async () => {
    const chain = new FakeChain();
    chain.mine(449n);
    chain.createIndex(buildSpec());
    const scanner = scannerOf(chain, { maxChunks: 2 });
    expect(await scanner.scan()).toMatchObject({ events: [], scannedToBlock: 1_199n, complete: false });
    expect(await scanner.scan()).toMatchObject({ events: [], scannedToBlock: 1_399n, complete: false });
    const last = await scanner.scan();
    expect(last).toMatchObject({ scannedToBlock: 1_450n, targetBlock: 1_450n, complete: true });
    expect(last.events).toHaveLength(2);
    expect(chain.logRanges).toHaveLength(5);
  });

  test("a failed range is an upstream failure and is requested again, the ranges before it are kept", async () => {
    const chain = new FakeChain();
    chain.createIndex(buildSpec());
    chain.mine(150n);
    const scanner = scannerOf(chain);
    let requests = 0;
    chain.fail = (method) => {
      if (method === "eth_getLogs") requests += 1;
      return method === "eth_getLogs" && requests === 2;
    };
    const error = await scanner.scan().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RegistryUpstreamError);
    const scan = await scanner.scan();
    expect(scan.events).toHaveLength(2);
    expect(scan.complete).toBe(true);
    // The failed request never reached the chain: the first range is not asked again, the second one is.
    expect(requests).toBe(3);
    expect(chain.logRanges).toEqual([
      { from: 1_000n, to: 1_099n },
      { from: 1_100n, to: 1_151n },
    ]);
  });

  test("an endpoint that rejects the range is an upstream failure", async () => {
    const chain = new FakeChain();
    chain.maxLogRange = 50n;
    chain.mine(80n);
    await expect(scannerOf(chain).scan()).rejects.toBeInstanceOf(RegistryUpstreamError);
    expect((await scannerOf(chain, { chunkBlocks: 50n }).scan()).complete).toBe(true);
  });

  test("reads the block when a log carries no timestamp, once per block", async () => {
    const chain = new FakeChain();
    chain.logsCarryTimestamp = false;
    chain.createIndex(buildSpec());
    const scan = await scannerOf(chain).scan();
    expect(scan.events.map(({ blockTimestamp }) => blockTimestamp)).toEqual([
      chain.timestampOf(1_001n),
      chain.timestampOf(1_001n),
    ]);
    expect(chain.methods.filter((method) => method === "eth_getBlockByNumber")).toHaveLength(1);
  });

  test("ignores an event emitted by the contract that does not declare it", async () => {
    const chain = new FakeChain();
    const indexId = chain.createIndex(buildSpec());
    chain.mine(1n);
    chain.emitRaw(REGISTRY, rebalanceTopics(CREATOR, indexId, 1));
    chain.recordRebalance(CREATOR, indexId, 1);
    const rebalances = (await scannerOf(chain).scan()).events.filter(({ type }) => type === "rebalance_recorded");
    expect(rebalances.map(({ blockNumber }) => blockNumber)).toEqual([chain.blockNumber]);
  });

  test("concurrent scans share one pass", async () => {
    const chain = new FakeChain();
    chain.createIndex(buildSpec());
    const scanner = scannerOf(chain);
    const [a, b] = await Promise.all([scanner.scan(), scanner.scan()]);
    expect(a).toBe(b);
    expect(chain.logRanges).toHaveLength(1);
  });
});

import { describe, expect, test } from "bun:test";
import { type Address, createPublicClient, encodeAbiParameters, encodeFunctionData, type Hex } from "viem";
import { aggregatorAbi, b20AssetAbi, b20FactoryAbi } from "../../src/server/market/abis";
import { MissingConfigurationError, UpstreamError } from "../../src/server/market/errors";
import { REFERENCE_FEEDS } from "../../src/server/market/feeds";
import { B20_FACTORY_ADDRESS, MULTICALL3_ADDRESS, readOnchain } from "../../src/server/market/onchain";
import { FIXTURE_TOKENS, type FixtureTransportOptions, fixtureTransport, onchainFixture, TOKENS } from "./support";

type Override = NonNullable<FixtureTransportOptions["override"]>;

function read(options: FixtureTransportOptions = {}, tokens: readonly Address[] = FIXTURE_TOKENS) {
  const { transport, requests } = fixtureTransport(onchainFixture, options);
  return { snapshot: readOnchain(createPublicClient({ transport }), tokens), requests };
}

const uint = (value: bigint): Hex => encodeAbiParameters([{ type: "uint256" }], [value]);
const bool = (value: boolean): Hex => encodeAbiParameters([{ type: "bool" }], [value]);
const tokenCallData = (functionName: (typeof b20AssetAbi)[number]["name"]) =>
  functionName === "isPaused"
    ? encodeFunctionData({ abi: b20AssetAbi, functionName, args: [0] })
    : encodeFunctionData({ abi: b20AssetAbi, functionName });

/** Replaces the answer of one token function. */
function tokenOverride(
  token: Address,
  functionName: (typeof b20AssetAbi)[number]["name"],
  answer: { success: boolean; returnData: Hex },
): Override {
  const callData = tokenCallData(functionName);
  return (call) => (call.target.toLowerCase() === token && call.callData === callData ? answer : undefined);
}

function feedOverride(
  token: Address,
  functionName: (typeof aggregatorAbi)[number]["name"],
  answer: { success: boolean; returnData: Hex },
): Override {
  const proxy = REFERENCE_FEEDS.get(token)?.proxy.toLowerCase();
  const callData = encodeFunctionData({ abi: aggregatorAbi, functionName });
  return (call) => (call.target.toLowerCase() === proxy && call.callData === callData ? answer : undefined);
}

function initializedOverride(token: Address, answer: { success: boolean; returnData: Hex }): Override {
  const callData = encodeFunctionData({ abi: b20FactoryAbi, functionName: "isB20Initialized", args: [token] });
  return (call) => (call.target === B20_FACTORY_ADDRESS && call.callData === callData ? answer : undefined);
}

const REVERT = { success: false, returnData: "0x" } as const;

describe("readOnchain with the recorded block", () => {
  test("reads every token and feed at the recorded block with two RPC requests", async () => {
    const { snapshot, requests } = read();
    const result = await snapshot;
    expect(requests).toEqual(["eth_getBlockByNumber", "eth_call"]);
    expect(result.blockNumber).toBe(60_489_401n);
    expect(result.blockTimestamp).toBe(1_795_288_255);
    expect([...result.tokens.keys()]).toEqual([...FIXTURE_TOKENS]);
    expect(result.feeds.size).toBe(13);
    for (const token of result.tokens.values()) expect(token.status).toBe("ok");
    for (const feed of result.feeds.values()) expect(feed.status).toBe("ok");
  });

  test("decodes token state as integers in their onchain units", async () => {
    const result = await read().snapshot;
    expect(result.tokens.get(TOKENS.NVDA)).toEqual({
      status: "ok",
      state: {
        decimals: 8,
        totalSupply: 6_201_973_777_574n,
        multiplierWad: 1_000_537_939_576_369_481n,
        pendingMultiplier: null,
        transfersPaused: false,
      },
    });
    expect(result.tokens.get(TOKENS.SNDK)).toMatchObject({ state: { multiplierWad: 8_000_000_000_000_000_000n } });
    expect(result.tokens.get(TOKENS.RKT)).toMatchObject({ status: "ok", state: { totalSupply: 0n } });
  });

  test("decodes the feed round, decimals and description", async () => {
    const result = await read().snapshot;
    expect(result.feeds.get(TOKENS.NVDA)).toEqual({
      status: "ok",
      decimals: 8,
      description: "Coinbase NVDA",
      round: {
        roundId: 36_893_488_147_419_104_856n,
        answer: 12_982_480_034n,
        updatedAt: 1_795_218_160,
        answeredInRound: 36_893_488_147_419_104_856n,
      },
    });
    expect(result.feeds.has(TOKENS.APP)).toBe(false);
  });

  test("every recorded feed answers with the identity in the feed map", async () => {
    const result = await read().snapshot;
    expect([...result.feeds.keys()].sort()).toEqual([...REFERENCE_FEEDS.keys()].sort());
    for (const [token, feed] of REFERENCE_FEEDS) {
      expect(result.feeds.get(token)).toMatchObject({ status: "ok", decimals: 8, description: feed.description });
    }
  });

  test("feed map keys are lowercase addresses and proxies are unique", () => {
    for (const token of REFERENCE_FEEDS.keys()) expect(token).toMatch(/^0x[0-9a-f]{40}$/);
    const proxies = [...REFERENCE_FEEDS.values()].map((feed) => feed.proxy.toLowerCase());
    expect(new Set(proxies).size).toBe(proxies.length);
  });
});

describe("readOnchain batching", () => {
  test("splits a large read into several multicalls and keeps every result aligned", async () => {
    // 80 addresses that hold no token push the read past 500 calls, so the feed calls land in a second request.
    const absent = Array.from(
      { length: 80 },
      (_, index): Address => `0xb2${(index + 1).toString(16).padStart(38, "f")}`,
    );
    const tokens = [...absent.slice(0, 40), ...FIXTURE_TOKENS, ...absent.slice(40)];
    const override: Override = (call) => {
      if (call.target === B20_FACTORY_ADDRESS && absent.some((address) => call.callData.endsWith(address.slice(2)))) {
        return { success: true, returnData: bool(false) };
      }
      return absent.some((address) => address === call.target.toLowerCase()) ? REVERT : undefined;
    };
    const { snapshot, requests } = read({ override }, tokens);
    const result = await snapshot;

    expect(requests).toEqual(["eth_getBlockByNumber", "eth_call", "eth_call"]);
    for (const address of absent) expect(result.tokens.get(address)).toEqual({ status: "not_initialized" });
    const baseline = await read().snapshot;
    for (const token of FIXTURE_TOKENS) {
      expect(result.tokens.get(token)).toEqual(baseline.tokens.get(token) ?? { status: "read_failed" });
      expect(result.feeds.get(token)).toEqual(baseline.feeds.get(token));
    }
  });

  test("a failed request rejects the whole read as an upstream failure, never as reverting calls", async () => {
    const absent = Array.from(
      { length: 80 },
      (_, index): Address => `0xb2${(index + 1).toString(16).padStart(38, "f")}`,
    );
    const override: Override = (call) =>
      call.target === MULTICALL3_ADDRESS ? undefined : { success: true, returnData: bool(false) };
    const { snapshot } = read({ override, failEthCall: (attempt) => attempt === 2 }, absent);
    const error = await snapshot.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ code: "upstream_failure", source: "base_rpc" });
  });

  test("a failed block request is an upstream failure", async () => {
    const { transport } = fixtureTransport(onchainFixture);
    const client = createPublicClient({ transport });
    const failing = {
      getBlock: () => Promise.reject(new Error("rate limited")),
      readContract: client.readContract,
    };
    await expect(readOnchain(failing, FIXTURE_TOKENS)).rejects.toMatchObject({ code: "upstream_failure" });
  });
});

describe("readOnchain with partial multicall failure", () => {
  test("a reverting token call fails that token only", async () => {
    const result = await read({ override: tokenOverride(TOKENS.NVDA, "totalSupply", REVERT) }).snapshot;
    expect(result.tokens.get(TOKENS.NVDA)).toEqual({ status: "read_failed" });
    expect(result.feeds.get(TOKENS.NVDA)?.status).toBe("ok");
    for (const [token, tokenRead] of result.tokens) {
      if (token !== TOKENS.NVDA) expect(tokenRead.status).toBe("ok");
    }
  });

  for (const functionName of ["decimals", "multiplier", "newUIMultiplier", "effectiveAt", "isPaused"] as const) {
    test(`a reverting ${functionName}() leaves the token without state instead of a default`, async () => {
      const result = await read({ override: tokenOverride(TOKENS.SNDK, functionName, REVERT) }).snapshot;
      expect(result.tokens.get(TOKENS.SNDK)).toEqual({ status: "read_failed" });
    });
  }

  test("return data that does not decode is a failed read, not a zero", async () => {
    const empty = { success: true, returnData: "0x" } as const;
    const result = await read({ override: tokenOverride(TOKENS.NVDA, "totalSupply", empty) }).snapshot;
    expect(result.tokens.get(TOKENS.NVDA)).toEqual({ status: "read_failed" });
  });

  test("a reverting feed call fails that feed only and leaves the token readable", async () => {
    const result = await read({ override: feedOverride(TOKENS.NVDA, "latestRoundData", REVERT) }).snapshot;
    expect(result.feeds.get(TOKENS.NVDA)).toEqual({ status: "read_failed" });
    expect(result.tokens.get(TOKENS.NVDA)?.status).toBe("ok");
    expect(result.feeds.get(TOKENS.SNDK)?.status).toBe("ok");
  });

  test("a reverting initialization check is a failed read", async () => {
    const result = await read({ override: initializedOverride(TOKENS.NVDA, REVERT) }).snapshot;
    expect(result.tokens.get(TOKENS.NVDA)).toEqual({ status: "read_failed" });
  });

  test("an address the factory does not report as initialized has no state, whatever else it answers", async () => {
    const result = await read({
      override: initializedOverride(TOKENS.NVDA, { success: true, returnData: bool(false) }),
    }).snapshot;
    expect(result.tokens.get(TOKENS.NVDA)).toEqual({ status: "not_initialized" });
  });
});

describe("readOnchain token flags", () => {
  test("reports paused transfers", async () => {
    const paused = { success: true, returnData: bool(true) };
    const result = await read({ override: tokenOverride(TOKENS.NVDA, "isPaused", paused) }).snapshot;
    expect(result.tokens.get(TOKENS.NVDA)).toMatchObject({ status: "ok", state: { transfersPaused: true } });
    expect(result.tokens.get(TOKENS.SNDK)).toMatchObject({ status: "ok", state: { transfersPaused: false } });
  });

  test("reports a multiplier update as pending only while its effective time is ahead of the block", async () => {
    const pendingValue = { success: true, returnData: uint(2_000_000_000_000_000_000n) };
    const at = (effectiveAt: number): Override => {
      const value = tokenOverride(TOKENS.NVDA, "newUIMultiplier", pendingValue);
      const time = tokenOverride(TOKENS.NVDA, "effectiveAt", { success: true, returnData: uint(BigInt(effectiveAt)) });
      return (call) => value(call) ?? time(call);
    };
    const ahead = await read({ override: at(onchainFixture.blockTimestamp + 1) }).snapshot;
    expect(ahead.tokens.get(TOKENS.NVDA)).toMatchObject({
      state: {
        multiplierWad: 1_000_537_939_576_369_481n,
        pendingMultiplier: {
          multiplierWad: 2_000_000_000_000_000_000n,
          effectiveAt: onchainFixture.blockTimestamp + 1,
        },
      },
    });
    const matured = await read({ override: at(onchainFixture.blockTimestamp) }).snapshot;
    expect(matured.tokens.get(TOKENS.NVDA)).toMatchObject({ state: { pendingMultiplier: null } });
  });

  test("a timestamp too large for a safe integer is a failed read", async () => {
    const huge = { success: true, returnData: uint(2n ** 200n) };
    const result = await read({ override: tokenOverride(TOKENS.NVDA, "effectiveAt", huge) }).snapshot;
    expect(result.tokens.get(TOKENS.NVDA)).toEqual({ status: "read_failed" });
  });
});

describe("readOnchain chain check", () => {
  test("rejects an endpoint that is not Base mainnet", async () => {
    const override: Override = (call) =>
      call.target === MULTICALL3_ADDRESS ? { success: true, returnData: uint(1n) } : undefined;
    const error = await read({ override }).snapshot.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(MissingConfigurationError);
    expect(error).toMatchObject({ code: "missing_configuration", variable: "BASE_RPC_URL" });
  });
});

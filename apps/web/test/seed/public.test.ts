import { describe, expect, test } from "bun:test";
import { DEPLOYMENTS, indexRegistryAbi } from "@equityos/contracts-abi";
import { verifyVersion } from "@equityos/core";
import {
  type Address,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  type Hex,
  keccak256,
  numberToHex,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  formatReport,
  type SeedPublicEnvironment,
  SeedPublicRefusedError,
  seedPublic,
} from "../../scripts/seed-public";
import {
  CAPPED_MAX_WEIGHT_BPS,
  cappedProportionalWeightsBps,
  IneligibleConstituentsError,
  LARGE_TECHNOLOGY_TICKERS,
  selectPublicSeed,
  tickerOf,
  tokenOf,
} from "../../scripts/seed/public-indexes";
import { createMarketData, type MarketSnapshot } from "../../src/server/market/index";
import { fixtureFetch, fixtureTransport, onchainFixture } from "../market/support";

const SEPOLIA = 84_532;
const MAINNET = 8453;
const REGISTRY = DEPLOYMENTS[SEPOLIA].registry;
/** Stand-in runtime code: the unit tests have no contract build, so the expected hash is passed in. */
const CODE: Hex = "0x6080604052";
const CODE_HASH = keccak256(CODE);
/** The deployment map with both live chains recorded, as it will be after the deployment. */
const DEPLOYED = {
  ...DEPLOYMENTS,
  [MAINNET]: { ...DEPLOYMENTS[MAINNET], deployBlock: 1_000n },
  [SEPOLIA]: { ...DEPLOYMENTS[SEPOLIA], deployBlock: 1_000n },
};
const CREATOR: Address = "0x00000000000000000000000000000000000c0ffe";

/** The recorded Base mainnet block of `test/fixtures/market`, read through the live market data service. */
async function recordedSnapshot(): Promise<MarketSnapshot> {
  const rpc = fixtureTransport(onchainFixture);
  const marketData = createMarketData({
    fetch: fixtureFetch().fetch,
    sleep: async () => {},
    client: createPublicClient({ transport: rpc.transport }),
    now: () => onchainFixture.blockTimestamp,
  });
  return marketData.getSnapshot();
}

interface ChainOptions {
  readonly chainId?: number;
  readonly code?: Hex;
  readonly balance?: bigint;
  /** A different index id from `computeIndexId`, as a contract that is not the registry would return. */
  readonly wrongIndexId?: boolean;
  /** `eth_estimateGas` fails, as it does for a call that would revert. */
  readonly revert?: boolean;
}

/**
 * An in-memory registry chain behind a viem transport. It answers the reads of the seed from its own state and
 * applies `createIndex` from signed raw transactions. Nothing leaves the process. Every method is recorded.
 */
function fakeChain(options: ChainOptions = {}) {
  const chainId = options.chainId ?? SEPOLIA;
  const methods: string[] = [];
  const indexes = new Map<Hex, { creator: Address; specHash: Hex }>();
  const receipts = new Map<Hex, unknown>();
  let nonce = 0;
  let block = 2_000n;
  const answerCall = (data: Hex): Hex => {
    const call = decodeFunctionData({ abi: indexRegistryAbi, data });
    if (call.functionName === "computeIndexId") {
      const [creator, salt] = call.args;
      const id = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [creator, salt]));
      const result = options.wrongIndexId ? keccak256(id) : id;
      return encodeFunctionResult({ abi: indexRegistryAbi, functionName: "computeIndexId", result });
    }
    if (call.functionName === "exists") {
      const result = indexes.has(call.args[0]);
      return encodeFunctionResult({ abi: indexRegistryAbi, functionName: "exists", result });
    }
    if (call.functionName === "getVersion") {
      const index = indexes.get(call.args[0]);
      if (index === undefined) throw new Error("VersionNotFound");
      return encodeFunctionResult({
        abi: indexRegistryAbi,
        functionName: "getVersion",
        result: {
          specHash: index.specHash,
          publishedAt: 1n,
          publishedBlock: 1n,
          composition: 2,
          specSize: 1,
          constituentCount: 1,
        },
      });
    }
    throw new Error(`unexpected call ${call.functionName}`);
  };
  const transport = custom(
    {
      async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
        methods.push(method);
        const args = Array.isArray(params) ? params : [];
        switch (method) {
          case "eth_chainId":
            return numberToHex(chainId);
          case "eth_getCode":
            return options.code ?? CODE;
          case "eth_call":
            return answerCall((args[0] as { data: Hex }).data);
          case "eth_estimateGas":
            if (options.revert) throw new Error("execution reverted");
            return numberToHex(400_000);
          case "eth_getBalance":
            return numberToHex(options.balance ?? 10n ** 17n);
          case "eth_blockNumber":
            return numberToHex(block);
          case "eth_getBlockByNumber":
            return {
              number: numberToHex(block),
              hash: keccak256(numberToHex(block)),
              timestamp: "0x1",
              baseFeePerGas: numberToHex(5_000_000n),
              gasLimit: "0x1c9c380",
              gasUsed: "0x0",
              transactions: [],
            };
          case "eth_maxPriorityFeePerGas":
            return numberToHex(1_000_000n);
          case "eth_getTransactionCount":
            return numberToHex(nonce);
          case "eth_sendRawTransaction": {
            const raw = args[0] as TransactionSerialized;
            const sender = (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase() as Address;
            const transaction = parseTransaction(raw);
            if (transaction.chainId !== chainId) throw new Error("wrong chain id");
            const call = decodeFunctionData({ abi: indexRegistryAbi, data: transaction.data ?? "0x" });
            if (call.functionName !== "createIndex") throw new Error("unexpected transaction");
            const [salt, spec] = call.args;
            const indexId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [sender, salt]));
            const specHash = keccak256(spec);
            indexes.set(indexId, { creator: sender, specHash });
            nonce += 1;
            block += 1n;
            const hash = keccak256(raw);
            // Every topic of these events is a single value: no array, no null.
            const log = (topics: readonly unknown[], data: Hex, logIndex: number) => ({
              address: REGISTRY,
              topics,
              data,
              blockNumber: numberToHex(block),
              blockHash: keccak256(numberToHex(block)),
              transactionHash: hash,
              transactionIndex: "0x0",
              logIndex: numberToHex(logIndex),
              removed: false,
            });
            receipts.set(hash, {
              transactionHash: hash,
              transactionIndex: "0x0",
              blockHash: keccak256(numberToHex(block)),
              blockNumber: numberToHex(block),
              from: sender,
              to: REGISTRY,
              cumulativeGasUsed: "0x1",
              gasUsed: "0x1",
              effectiveGasPrice: "0x1",
              contractAddress: null,
              logsBloom: `0x${"0".repeat(512)}`,
              status: "0x1",
              type: "0x2",
              logs: [
                log(
                  encodeEventTopics({
                    abi: indexRegistryAbi,
                    eventName: "IndexCreated",
                    args: { indexId, creator: sender },
                  }),
                  encodeAbiParameters([{ type: "bytes32" }], [salt]),
                  0,
                ),
                log(
                  encodeEventTopics({
                    abi: indexRegistryAbi,
                    eventName: "VersionPublished",
                    args: { indexId, version: 1, specHash },
                  }),
                  encodeAbiParameters(
                    [{ type: "address" }, { type: "uint8" }, { type: "uint32" }, { type: "uint16" }],
                    [sender, 2, 1, 1],
                  ),
                  1,
                ),
              ],
            });
            return hash;
          }
          case "eth_getTransactionReceipt":
            return receipts.get(args[0] as Hex) ?? null;
          default:
            throw new Error(`unexpected RPC method ${method}`);
        }
      },
    },
    { retryCount: 0 },
  );
  return { transport, methods, indexes };
}

async function run(
  chain: ReturnType<typeof fakeChain>,
  env: SeedPublicEnvironment,
  send = false,
  snapshot: () => Promise<MarketSnapshot> = recordedSnapshot,
) {
  return seedPublic({
    transport: chain.transport,
    snapshot,
    env,
    send,
    deployments: DEPLOYED,
    expectedCodeHash: CODE_HASH,
  });
}

async function refusal(promise: Promise<unknown>): Promise<SeedPublicRefusedError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof SeedPublicRefusedError)) throw new Error(`expected a refusal, got ${String(error)}`);
  return error;
}

describe("refusals, before anything is sent", () => {
  test.each([1, 10, 31_337, 11_155_111])("refuses chain %d after reading only the chain id", async (chainId) => {
    const chain = fakeChain({ chainId });
    expect((await refusal(run(chain, { SEED_CREATOR: CREATOR }))).code).toBe("unsupported_chain");
    expect(chain.methods).toEqual(["eth_chainId"]);
  });

  test.each([undefined, "", "1", "TRUE", "yes"])("refuses Base mainnet with SEED_MAINNET=%p", async (value) => {
    const chain = fakeChain({ chainId: MAINNET });
    const error = await refusal(run(chain, { SEED_CREATOR: CREATOR, SEED_MAINNET: value }));
    expect(error.code).toBe("mainnet_not_confirmed");
    expect(chain.methods).toEqual(["eth_chainId"]);
  });

  test("refuses a chain the deployment map records no registry on: the real map today", async () => {
    for (const chainId of [SEPOLIA, MAINNET]) {
      const chain = fakeChain({ chainId });
      const promise = seedPublic({
        transport: chain.transport,
        snapshot: recordedSnapshot,
        env: { SEED_CREATOR: CREATOR, SEED_MAINNET: "true" },
        send: false,
      });
      expect((await refusal(promise)).code).toBe("not_in_deployment_map");
      expect(chain.methods).toEqual(["eth_chainId"]);
    }
  });

  test("refuses when the registry address has no code, or code other than the expected build", async () => {
    const empty = fakeChain({ code: "0x" });
    expect((await refusal(run(empty, { SEED_CREATOR: CREATOR }))).code).toBe("registry_code_missing");
    const other = fakeChain({ code: "0x6000" });
    expect((await refusal(run(other, { SEED_CREATOR: CREATOR }))).code).toBe("registry_code_mismatch");
    expect(other.methods).toEqual(["eth_chainId", "eth_getCode"]);
  });

  test("refuses without a creator, with a malformed key and with a key that is not SEED_CREATOR", async () => {
    expect((await refusal(run(fakeChain(), {}))).code).toBe("no_creator");
    expect((await refusal(run(fakeChain(), { SEED_CREATOR: "0x1234" }))).code).toBe("no_creator");
    const malformed = await refusal(run(fakeChain(), { SEED_PRIVATE_KEY: "0xabc123" }));
    expect(malformed.code).toBe("invalid_key");
    expect(malformed.message).not.toContain("abc123");
    const key = generatePrivateKey();
    const mismatch = await refusal(run(fakeChain(), { SEED_PRIVATE_KEY: key, SEED_CREATOR: CREATOR }));
    expect(mismatch.code).toBe("creator_mismatch");
    expect(mismatch.message).not.toContain(key.slice(2));
  });

  test("refuses to send without a key, before reading the market", async () => {
    const chain = fakeChain();
    const error = await refusal(run(chain, { SEED_CREATOR: CREATOR }, true));
    expect(error.code).toBe("send_requires_key");
    expect(chain.methods).toEqual(["eth_chainId", "eth_getCode"]);
  });

  test("refuses market data served from cache after a failure", async () => {
    const stale = async () => {
      const snapshot = await recordedSnapshot();
      return { ...snapshot, onchain: { ...snapshot.onchain, servedStale: true } };
    };
    const error = await refusal(run(fakeChain(), { SEED_CREATOR: CREATOR }, false, stale));
    expect(error.code).toBe("market_data_stale");
  });

  test("aborts listing every constituent that is not index-eligible with a usable price", async () => {
    const meta = tokenOf("META");
    const aapl = tokenOf("AAPL");
    const degraded = async (): Promise<MarketSnapshot> => {
      const snapshot = await recordedSnapshot();
      const assets = new Map(snapshot.assets);
      const metaEntry = assets.get(meta);
      const aaplEntry = assets.get(aapl);
      if (metaEntry === undefined || aaplEntry === undefined) throw new Error("fixture lacks META or AAPL");
      assets.set(meta, { ...metaEntry, eligibility: { eligible: false, reasons: ["not_minted"] } });
      assets.set(aapl, {
        ...aaplEntry,
        referencePrice: { status: "unavailable", source: "chainlink", reason: "stale_feed", lastObserved: null },
      });
      return { ...snapshot, assets };
    };
    const chain = fakeChain();
    const error = await run(chain, { SEED_CREATOR: CREATOR }, false, degraded).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IneligibleConstituentsError);
    if (!(error instanceof IneligibleConstituentsError)) return;
    expect(error.ineligible.map(({ ticker }) => ticker).sort()).toEqual(["AAPL", "META"]);
    expect(error.message).toContain("META");
    expect(error.message).toContain("not_minted");
    expect(error.message).toContain("price_unavailable");
    expect(chain.methods).not.toContain("eth_estimateGas");
  });

  test("refuses a registry that derives another index id", async () => {
    const error = await refusal(run(fakeChain({ wrongIndexId: true }), { SEED_CREATOR: CREATOR }));
    expect(error.code).toBe("index_id_mismatch");
  });

  test("refuses a plan whose simulation reverts", async () => {
    const error = await refusal(run(fakeChain({ revert: true }), { SEED_CREATOR: CREATOR }));
    expect(error.code).toBe("simulation_failed");
  });
});

describe("dry run", () => {
  test("is the default: it plans three creations, prints them and sends nothing", async () => {
    const chain = fakeChain();
    const result = await run(chain, { SEED_CREATOR: CREATOR });
    expect(result.sent).toEqual([]);
    expect(chain.methods).not.toContain("eth_sendRawTransaction");
    expect(chain.methods).not.toContain("eth_getTransactionCount");
    const { plan } = result;
    expect(plan.creator).toBe(CREATOR);
    expect(plan.indexes.map(({ status }) => status)).toEqual(["create", "create", "create"]);
    for (const { index, indexId, transaction } of plan.indexes) {
      expect(indexId).toBe(
        keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [CREATOR, index.salt])),
      );
      expect(transaction?.to).toBe(REGISTRY);
      expect(transaction?.value).toBe(0n);
      const call = decodeFunctionData({ abi: indexRegistryAbi, data: transaction?.data ?? "0x" });
      expect(call.functionName).toBe("createIndex");
      if (call.functionName !== "createIndex") continue;
      expect(keccak256(call.args[1])).toBe(index.version.specHash);
      expect(call.args[2].map((token) => token.toLowerCase())).toEqual([...index.version.tokens]);
      expect(call.args[3]).toEqual(index.version.weightsBps);
    }

    const report = formatReport(result, false);
    expect(report).toContain("DRY RUN: public seed on Base Sepolia (chain 84532)");
    expect(report).toContain(`plan digest: ${plan.digest}`);
    expect(report).toContain("Nothing was sent.");
    for (const { index, indexId, transaction } of plan.indexes) {
      expect(report).toContain(indexId);
      expect(report).toContain(index.version.specHash);
      expect(report).toContain(transaction?.data ?? "missing");
    }
  });

  test("the digest is stable for the same inputs and changes with the plan", async () => {
    const first = await run(fakeChain(), { SEED_CREATOR: CREATOR });
    const second = await run(fakeChain(), { SEED_CREATOR: CREATOR });
    expect(second.plan.digest).toBe(first.plan.digest);
    const other = await run(fakeChain(), { SEED_CREATOR: "0x00000000000000000000000000000000000beef0" });
    expect(other.plan.digest).not.toBe(first.plan.digest);
  });

  test("skips an index that exists with the same spec and reports one that exists with another", async () => {
    const chain = fakeChain();
    const { plan } = await run(chain, { SEED_CREATOR: CREATOR });
    const [equal, capped] = plan.indexes;
    if (equal === undefined || capped === undefined) throw new Error("plan is incomplete");
    chain.indexes.set(equal.indexId, { creator: CREATOR, specHash: equal.index.version.specHash });
    chain.indexes.set(capped.indexId, { creator: CREATOR, specHash: keccak256("0x01") });
    const again = await run(chain, { SEED_CREATOR: CREATOR });
    expect(again.plan.indexes.map(({ status }) => status)).toEqual(["exists", "exists_different", "create"]);
    expect(again.plan.indexes.filter(({ transaction }) => transaction !== null)).toHaveLength(1);
    const report = formatReport(again, false);
    expect(report).toContain("exists, skipped");
    expect(report).toContain("exists with another spec, left unchanged");
  });

  test("a key alone gives the creator, and the key never appears in the report", async () => {
    const key = generatePrivateKey();
    const result = await run(fakeChain(), { SEED_PRIVATE_KEY: key });
    expect(result.plan.creator).toBe(privateKeyToAccount(key).address.toLowerCase() as Address);
    expect(formatReport(result, false)).not.toContain(key.slice(2));
  });
});

describe("send", () => {
  test("refuses without the digest of this plan, or with another one", async () => {
    const key = generatePrivateKey();
    const chain = fakeChain();
    expect((await refusal(run(chain, { SEED_PRIVATE_KEY: key }, true))).code).toBe("plan_digest_mismatch");
    const wrong = { SEED_PRIVATE_KEY: key, SEED_PLAN_DIGEST: keccak256("0x00") };
    expect((await refusal(run(chain, wrong, true))).code).toBe("plan_digest_mismatch");
    expect(chain.methods).not.toContain("eth_sendRawTransaction");
  });

  test("refuses when the balance does not cover twice the estimated fee", async () => {
    const key = generatePrivateKey();
    const { plan } = await run(fakeChain(), { SEED_PRIVATE_KEY: key });
    const poor = fakeChain({ balance: plan.maxFeeWei });
    const error = await refusal(run(poor, { SEED_PRIVATE_KEY: key, SEED_PLAN_DIGEST: plan.digest }, true));
    expect(error.code).toBe("insufficient_balance");
    expect(poor.methods).not.toContain("eth_sendRawTransaction");
  });

  test("sends exactly the planned calldata, checks the events and the read-back, then has nothing left to do", async () => {
    const key = generatePrivateKey();
    const chain = fakeChain();
    const { plan } = await run(chain, { SEED_PRIVATE_KEY: key });
    const result = await run(chain, { SEED_PRIVATE_KEY: key, SEED_PLAN_DIGEST: plan.digest }, true);
    expect(result.sent).toHaveLength(3);
    expect(chain.methods.filter((method) => method === "eth_sendRawTransaction")).toHaveLength(3);
    for (const { indexId, index } of plan.indexes) {
      expect(chain.indexes.get(indexId)?.specHash).toBe(index.version.specHash);
    }
    const report = formatReport(result, true);
    expect(report).toContain("SEND: public seed on Base Sepolia");
    expect(report).not.toContain(key.slice(2));

    const again = await run(chain, { SEED_PRIVATE_KEY: key });
    expect(again.plan.indexes.map(({ status }) => status)).toEqual(["exists", "exists", "exists"]);
    const rerun = await run(chain, { SEED_PRIVATE_KEY: key, SEED_PLAN_DIGEST: again.plan.digest }, true);
    expect(rerun.sent).toEqual([]);
  });

  test("Base mainnet with SEED_MAINNET=true plans like Base Sepolia, with mainnet specs", async () => {
    const chain = fakeChain({ chainId: MAINNET });
    const { plan } = await run(chain, { SEED_CREATOR: CREATOR, SEED_MAINNET: "true" });
    expect(plan.chainId).toBe(MAINNET);
    expect(plan.indexes.every(({ index }) => index.version.spec.chainId === MAINNET)).toBe(true);
  });
});

describe("selectPublicSeed on the recorded block", () => {
  test("chooses the constituents by the stated rules", async () => {
    const selection = selectPublicSeed(await recordedSnapshot(), SEPOLIA);
    const tickers = (i: number) => (selection.indexes[i]?.version.tokens ?? []).map((token) => tickerOf(token)).sort();
    expect(tickers(0)).toEqual([...LARGE_TECHNOLOGY_TICKERS].sort());
    expect(tickers(1)).toEqual([...LARGE_TECHNOLOGY_TICKERS].sort());
    // By minted supply value at the recorded reference prices.
    expect(selection.ranking.slice(0, 5).map(({ ticker }) => ticker)).toEqual([
      "GOOGL",
      "NVDA",
      "META",
      "SPCX",
      "AMZN",
    ]);
    expect(tickers(2)).toEqual(["AMZN", "GOOGL", "META", "NVDA", "SPCX"]);
    for (let i = 1; i < selection.ranking.length; i++) {
      expect((selection.ranking[i - 1]?.valueUsdE8 ?? 0n) >= (selection.ranking[i]?.valueUsdE8 ?? 0n)).toBe(true);
    }
  });

  test("the capped weights are whole percent, at most 20%, and follow the supply values", async () => {
    const selection = selectPublicSeed(await recordedSnapshot(), SEPOLIA);
    const capped = selection.indexes[1]?.version;
    if (capped === undefined) throw new Error("no capped index");
    expect(capped.spec.weighting.type).toBe("fixed");
    expect(capped.spec.constraints).toEqual({ maxWeightBps: CAPPED_MAX_WEIGHT_BPS });
    const byTicker = Object.fromEntries(capped.tokens.map((token, i) => [tickerOf(token), capped.weightsBps[i]]));
    expect(byTicker).toEqual({ GOOGL: 2_000, NVDA: 2_000, META: 2_000, AMZN: 1_700, AAPL: 1_400, MSFT: 900 });
  });

  test("every version verifies, declares its chain and describes only its composition", async () => {
    const selection = selectPublicSeed(await recordedSnapshot(), SEPOLIA);
    expect(new Set(selection.indexes.map(({ salt }) => salt)).size).toBe(3);
    for (const { version } of selection.indexes) {
      const constituents = version.tokens.map((token, i) => ({ token, weightBps: version.weightsBps[i] ?? 0 }));
      const report = verifyVersion({
        specBytes: version.specBytes,
        specHash: version.specHash,
        constituents,
        chainId: SEPOLIA,
      });
      expect(report.checks.every(({ status }) => status === "pass")).toBe(true);
      expect(version.spec.chainId).toBe(SEPOLIA);
      expect(version.spec.description).not.toMatch(
        /return|profit|buy|sell|invest|recommend|outperform|best|guarantee|should|liquid/i,
      );
    }
  });
});

describe("cappedProportionalWeightsBps", () => {
  test("caps, redistributes and rounds to whole steps that sum to 10,000", () => {
    expect(cappedProportionalWeightsBps([100n, 80n, 51n, 25n, 21n, 13n], 2_000, 100)).toEqual([
      2_000, 2_000, 2_000, 1_700, 1_400, 900,
    ]);
    expect(cappedProportionalWeightsBps([1n, 1n, 1n], 5_000, 100)).toEqual([3_400, 3_300, 3_300]);
    expect(cappedProportionalWeightsBps([1n, 1n, 1n, 1n, 1n], 2_000, 100)).toEqual([2_000, 2_000, 2_000, 2_000, 2_000]);
    expect(cappedProportionalWeightsBps([5n], 10_000, 100)).toEqual([10_000]);
  });

  test("never passes the cap and always sums to 10,000 for many value sets", () => {
    let seed = 7n;
    const next = () => {
      seed = (seed * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) % 2n ** 64n;
      return (seed % 1_000n) + 1_000n;
    };
    for (let round = 0; round < 200; round++) {
      const values = Array.from({ length: 5 + (round % 6) }, next);
      const weights = cappedProportionalWeightsBps(values, 2_000, 100);
      expect(weights.reduce((sum, weight) => sum + weight, 0)).toBe(10_000);
      for (const weight of weights) {
        expect(weight).toBeGreaterThan(0);
        expect(weight).toBeLessThanOrEqual(2_000);
        expect(weight % 100).toBe(0);
      }
    }
  });

  test("rejects an infeasible cap, a value that is not positive and a weight that rounds to zero", () => {
    expect(() => cappedProportionalWeightsBps([1n, 1n, 1n, 1n], 2_000, 100)).toThrow("cannot sum");
    expect(() => cappedProportionalWeightsBps([], 2_000, 100)).toThrow("cannot sum");
    expect(() => cappedProportionalWeightsBps([1n, 0n, 1n, 1n, 1n], 2_000, 100)).toThrow("positive");
    expect(() => cappedProportionalWeightsBps([10n ** 9n, 10n ** 9n, 1n], 5_000, 100)).toThrow("rounds to zero");
    expect(() => cappedProportionalWeightsBps([1n, 1n], 5_050, 100)).toThrow("multiples");
  });
});

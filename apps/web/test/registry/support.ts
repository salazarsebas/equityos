import { indexRegistryAbi, rebalanceLogAbi } from "@equityos/contracts-abi";
import { type IndexSpec, specHash, validateSpec } from "@equityos/core";
import {
  type Address,
  bytesToHex,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  type Hex,
  numberToHex,
  parseAbi,
} from "viem";
import type { RegistryClient } from "../../src/server/registry/chain";
import { MULTICALL3_ADDRESS, type RegistryConfig } from "../../src/server/registry/config";

export const REGISTRY: Address = "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c";
export const REBALANCE_LOG: Address = "0x593449aef0efc05528d3bc7be9eb8d99e39aa41c";
export const CREATOR: Address = "0x00000000000000000000000000000000000c0ffe";
export const OTHER_CREATOR: Address = "0x0000000000000000000000000000000000000bad";
/** A chain id the tests treat as deployed. The real map marks every live chain as not deployed. */
export const CHAIN_ID = 84_532;
export const DEPLOY_BLOCK = 1_000n;

const TOKENS: readonly Address[] = [
  "0xb200000000000000000000000000000000000001",
  "0xb200000000000000000000000000000000000002",
  "0xb200000000000000000000000000000000000003",
  "0xb200000000000000000000000000000000000004",
];
const FEEDS: readonly Address[] = TOKENS.map((token): Address => `0xfeed${token.slice(6)}`);

const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) view returns (Result[] returnData)",
]);

export function testConfig(overrides: Partial<RegistryConfig> = {}): RegistryConfig {
  return {
    chainId: CHAIN_ID,
    deployment: { registry: REGISTRY, rebalanceLog: REBALANCE_LOG, deployBlock: DEPLOY_BLOCK },
    multicall: MULTICALL3_ADDRESS,
    logChunkBlocks: 100n,
    confirmations: 0n,
    ...overrides,
  };
}

export interface SpecOptions {
  readonly slug?: string;
  readonly chainId?: number;
  /** Fixed weights of the first tokens. Omitted for equal weighting over `tokenCount` tokens. */
  readonly weightsBps?: readonly number[];
  readonly tokenCount?: number;
  /** Tokens to use in place of the test addresses, strictly ascending. */
  readonly tokens?: readonly Address[];
}

/** A valid spec, its canonical bytes and the composition mirror it implies. */
export function buildSpec(options: SpecOptions = {}) {
  const count = options.weightsBps?.length ?? options.tokens?.length ?? options.tokenCount ?? 4;
  const validation = validateSpec({
    schema: "equityos.index/1",
    calc: "equityos.calc/1",
    chainId: options.chainId ?? CHAIN_ID,
    name: "Test Index",
    slug: options.slug ?? "test-index",
    description: "An index used by the tests.",
    universe: { type: "static", tokens: (options.tokens ?? TOKENS).slice(0, count) },
    weighting: options.weightsBps === undefined ? { type: "equal" } : { type: "fixed", weightsBps: options.weightsBps },
    pricing: { source: "chainlink-aggregator-v3", feeds: FEEDS.slice(0, count) },
    rebalance: { trigger: "drift", driftThresholdBps: 500, minIntervalSeconds: 86_400 },
  });
  if (!validation.ok) throw new Error(`the test spec is invalid: ${JSON.stringify(validation.errors)}`);
  const spec: IndexSpec = validation.spec;
  const weights = options.weightsBps ?? spec.universe.tokens.map(() => 10_000 / count);
  return {
    spec,
    specBytes: validation.specBytes,
    constituents: spec.universe.tokens.map((token, i) => ({ token, weightBps: weights[i] ?? 0 })),
  };
}

export interface PublishInput {
  readonly specBytes: Uint8Array;
  readonly constituents: readonly { readonly token: Address; readonly weightBps: number }[];
  /** `IIndexRegistry.Composition` as a number. Defaults to 2, `Static`. */
  readonly composition?: number;
}

interface StoredVersion extends Required<PublishInput> {
  readonly specHash: Hex;
  readonly publishedAt: bigint;
  readonly publishedBlock: bigint;
}

interface StoredIndex {
  readonly indexId: Hex;
  readonly creator: Address;
  readonly createdAt: bigint;
  deprecatedAt: bigint;
  readonly versions: StoredVersion[];
}

interface RpcLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: bigint;
  readonly logIndex: number;
}

/** A 32-byte id made of `digits` followed by zeros. */
export function indexIdOf(digits: string): Hex {
  return `0x${digits.padEnd(64, "0")}`;
}

/**
 * An in-memory chain with the state and logs of an IndexRegistry and a RebalanceLog, served over a viem
 * transport. It answers `eth_chainId`, `eth_getCode`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_call`
 * (direct or through Multicall3 `aggregate3`) and `eth_getLogs`. Anything else is an error: the tests make no
 * network access.
 */
export class FakeChain {
  readonly chainId: number;
  readonly registry: Address;
  blockNumber = DEPLOY_BLOCK;
  /** Whether the registry address holds code. */
  deployed = true;
  /** `eth_getLogs` rejects a request that spans more blocks than this, as public endpoints do. */
  maxLogRange = 100n;
  /** Whether logs carry `blockTimestamp`. Not every node returns it. */
  logsCarryTimestamp = true;
  /** Makes a request fail at the transport level. */
  fail: (method: string) => boolean = () => false;
  /** Every RPC method requested, in order. */
  readonly methods: string[] = [];
  /** Every registry function called, directly or through Multicall3, in order. */
  readonly calls: string[] = [];
  /** The inclusive block range of every `eth_getLogs` request, in order. */
  readonly logRanges: { from: bigint; to: bigint }[] = [];
  private readonly indexes: StoredIndex[] = [];
  private readonly logs: RpcLog[] = [];
  private nextSalt = 1;

  constructor(options: { chainId?: number; registry?: Address } = {}) {
    this.chainId = options.chainId ?? CHAIN_ID;
    this.registry = options.registry ?? REGISTRY;
  }

  /** Timestamp of a block: two seconds per block from a fixed origin. */
  timestampOf(blockNumber: bigint): bigint {
    return 1_700_000_000n + blockNumber * 2n;
  }

  /** Mines `count` empty blocks. */
  mine(count: bigint): void {
    this.blockNumber += count;
  }

  private emit(address: Address, encoded: ReturnType<typeof encodeEventTopics>, data: Hex = "0x"): void {
    // Every argument the tests index is given, so no topic is a wildcard.
    const topics = encoded.flatMap((topic) => (typeof topic === "string" ? [topic] : []));
    const logIndex = this.logs.filter((log) => log.blockNumber === this.blockNumber).length;
    this.logs.push({ address, topics, data, blockNumber: this.blockNumber, logIndex });
  }

  /** Appends a log exactly as given, in the current block. */
  emitRaw(address: Address, topics: ReturnType<typeof encodeEventTopics>, data: Hex = "0x"): void {
    this.emit(address, topics, data);
  }

  private store(index: StoredIndex, input: PublishInput): void {
    const version: StoredVersion = {
      specBytes: input.specBytes,
      constituents: input.constituents,
      composition: input.composition ?? 2,
      specHash: specHash(input.specBytes),
      publishedAt: this.timestampOf(this.blockNumber),
      publishedBlock: this.blockNumber,
    };
    index.versions.push(version);
    const topics = encodeEventTopics({
      abi: indexRegistryAbi,
      eventName: "VersionPublished",
      args: { indexId: index.indexId, version: index.versions.length, specHash: version.specHash },
    });
    const data = encodeAbiParameters(
      [{ type: "address" }, { type: "uint8" }, { type: "uint32" }, { type: "uint16" }],
      [index.creator, version.composition, version.specBytes.length, version.constituents.length],
    );
    this.emit(this.registry, topics, data);
  }

  /** Creates an index with its version 1 in a new block. The id is arbitrary unless given. */
  createIndex(input: PublishInput & { indexId?: Hex; creator?: Address }): Hex {
    this.blockNumber += 1n;
    const salt = numberToHex(this.nextSalt, { size: 32 });
    this.nextSalt += 1;
    const index: StoredIndex = {
      indexId: input.indexId ?? specHash(new TextEncoder().encode(`index ${salt}`)),
      creator: input.creator ?? CREATOR,
      createdAt: this.timestampOf(this.blockNumber),
      deprecatedAt: 0n,
      versions: [],
    };
    this.indexes.push(index);
    const topics = encodeEventTopics({
      abi: indexRegistryAbi,
      eventName: "IndexCreated",
      args: { indexId: index.indexId, creator: index.creator },
    });
    this.emit(this.registry, topics, salt);
    this.store(index, input);
    return index.indexId;
  }

  publishVersion(indexId: Hex, input: PublishInput): void {
    this.blockNumber += 1n;
    this.store(this.require(indexId), input);
  }

  deprecate(indexId: Hex): void {
    this.blockNumber += 1n;
    const index = this.require(indexId);
    index.deprecatedAt = this.timestampOf(this.blockNumber);
    this.emit(
      this.registry,
      encodeEventTopics({
        abi: indexRegistryAbi,
        eventName: "IndexDeprecated",
        args: { indexId, creator: index.creator },
      }),
    );
  }

  recordRebalance(account: Address, indexId: Hex, version: number): void {
    this.blockNumber += 1n;
    this.emit(REBALANCE_LOG, rebalanceTopics(account, indexId, version));
  }

  private require(indexId: Hex): StoredIndex {
    const index = this.indexes.find((candidate) => candidate.indexId === indexId);
    if (index === undefined) throw new Error("execution reverted: IndexNotFound");
    return index;
  }

  private version(indexId: Hex, version: number): StoredVersion {
    const stored = this.require(indexId).versions[version - 1];
    if (stored === undefined) throw new Error("execution reverted: VersionNotFound");
    return stored;
  }

  /** Executes one registry call against the state. Throws for a call the contract would revert. */
  private execute(to: Address, data: Hex): Hex {
    if (to.toLowerCase() !== this.registry.toLowerCase()) throw new Error(`call to an unknown contract ${to}`);
    const call = decodeFunctionData({ abi: indexRegistryAbi, data });
    this.calls.push(call.functionName);
    const abi = indexRegistryAbi;
    switch (call.functionName) {
      case "indexCount":
        return encodeFunctionResult({ abi, functionName: "indexCount", result: BigInt(this.indexes.length) });
      case "indexIdAt": {
        const index = this.indexes[Number(call.args[0])];
        if (index === undefined) throw new Error("execution reverted: PositionOutOfBounds");
        return encodeFunctionResult({ abi, functionName: "indexIdAt", result: index.indexId });
      }
      case "getIndex": {
        const { creator, versions, createdAt, deprecatedAt } = this.require(call.args[0]);
        const result = { creator, latestVersion: versions.length, createdAt, deprecatedAt };
        return encodeFunctionResult({ abi, functionName: "getIndex", result });
      }
      case "getVersion": {
        const stored = this.version(call.args[0], call.args[1]);
        const result = {
          specHash: stored.specHash,
          publishedAt: stored.publishedAt,
          publishedBlock: stored.publishedBlock,
          composition: stored.composition,
          specSize: stored.specBytes.length,
          constituentCount: stored.constituents.length,
        };
        return encodeFunctionResult({ abi, functionName: "getVersion", result });
      }
      case "specOf": {
        const result = bytesToHex(this.version(call.args[0], call.args[1]).specBytes);
        return encodeFunctionResult({ abi, functionName: "specOf", result });
      }
      case "constituentsOf": {
        const result = this.version(call.args[0], call.args[1]).constituents;
        return encodeFunctionResult({ abi, functionName: "constituentsOf", result });
      }
      default:
        throw new Error(`the reader must not call ${call.functionName}`);
    }
  }

  private ethCall(params: unknown): Hex {
    const [request, block] = params as [{ to: Address; data: Hex }, Hex];
    if (BigInt(block) !== this.blockNumber) throw new Error(`the call is not pinned to the head block: ${block}`);
    if (!this.deployed) return "0x";
    if (request.to.toLowerCase() !== MULTICALL3_ADDRESS.toLowerCase()) return this.execute(request.to, request.data);
    const { args } = decodeFunctionData({ abi: multicall3Abi, data: request.data });
    return encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      result: args[0].map(({ target, callData }) => ({ success: true, returnData: this.execute(target, callData) })),
    });
  }

  private getLogs(params: unknown): unknown[] {
    const [filter] = params as [{ address: Address[]; topics: [Hex[]]; fromBlock: Hex; toBlock: Hex }];
    const from = BigInt(filter.fromBlock);
    const to = BigInt(filter.toBlock);
    this.logRanges.push({ from, to });
    if (to - from + 1n > this.maxLogRange) throw new Error("query exceeds max block range");
    const addresses = filter.address.map((address) => address.toLowerCase());
    return this.logs
      .filter((log) => log.blockNumber >= from && log.blockNumber <= to)
      .filter((log) => addresses.includes(log.address.toLowerCase()))
      .filter((log) => log.topics[0] !== undefined && filter.topics[0].includes(log.topics[0]))
      .map((log) => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
        blockNumber: numberToHex(log.blockNumber),
        blockHash: numberToHex(log.blockNumber, { size: 32 }),
        transactionHash: numberToHex(log.blockNumber * 1_000n + BigInt(log.logIndex), { size: 32 }),
        transactionIndex: "0x0",
        logIndex: numberToHex(log.logIndex),
        removed: false,
        ...(this.logsCarryTimestamp ? { blockTimestamp: numberToHex(this.timestampOf(log.blockNumber)) } : {}),
      }));
  }

  /** A read-only client over this chain, without retries. */
  client(): RegistryClient {
    const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
      this.methods.push(method);
      if (this.fail(method)) throw new Error("simulated transport failure");
      switch (method) {
        case "eth_chainId":
          return numberToHex(this.chainId);
        case "eth_blockNumber":
          return numberToHex(this.blockNumber);
        case "eth_getCode":
          return this.deployed ? "0x6080" : "0x";
        case "eth_getBlockByNumber": {
          const [block] = params as [Hex];
          return { number: block, timestamp: numberToHex(this.timestampOf(BigInt(block))), transactions: [] };
        }
        case "eth_call":
          return this.ethCall(params);
        case "eth_getLogs":
          return this.getLogs(params);
        default:
          throw new Error(`unexpected RPC method ${method}`);
      }
    };
    return createPublicClient({ transport: custom({ request }, { retryCount: 0 }) });
  }
}

export function rebalanceTopics(account: Address, indexId: Hex, version: number) {
  return encodeEventTopics({
    abi: rebalanceLogAbi,
    eventName: "RebalanceRecorded",
    args: { account, indexId, version },
  });
}

/** A clock in Unix seconds that the test moves. */
export function testClock(start = 1_000): { now: () => number; advance: (seconds: number) => void } {
  let time = start;
  return {
    now: () => time,
    advance: (seconds) => {
      time += seconds;
    },
  };
}

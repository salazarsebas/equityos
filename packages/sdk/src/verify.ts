/**
 * Verification of a published index version from the registry contract alone. Nothing here calls the EquityOS
 * API: the stored bytes, hash and constituents are read with `eth_call` from an RPC endpoint the caller chooses,
 * and checked with `verifyVersion` of `@equityos/core`.
 */

import {
  type CheckResult,
  type IndexSpec,
  type PublishedConstituent,
  type SpecError,
  verifyVersion,
} from "@equityos/core";
import {
  AbiDecodingError,
  type Composition,
  decodeBool,
  decodeBytes,
  decodeConstituents,
  decodeIndexInfo,
  decodeVersionInfo,
  encodeExists,
  encodeGetIndex,
  encodeVersionCall,
  isVersionNumber,
  SELECTORS,
} from "./abi.ts";
import type { Hex } from "./decode.ts";
import { RegistryReadError } from "./errors.ts";
import { type Fetch, globalFetch } from "./fetch.ts";

/**
 * The four reads `verifyIndexVersion` needs from a chain client. A viem `PublicClient` satisfies it as is, so
 * viem is not a dependency of this package.
 */
export interface PublicClientLike {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getCode(args: { address: Hex; blockNumber: bigint }): Promise<Hex | undefined>;
  call(args: { to: Hex; data: Hex; blockNumber: bigint }): Promise<{ data?: Hex | undefined }>;
}

interface VerifyTarget {
  /** EIP-155 id of the chain to read. The RPC endpoint must report the same id. */
  readonly chainId: number;
  /** Address of `IndexRegistry` on that chain. `INDEX_REGISTRY_ADDRESS` is the deterministic one. */
  readonly registry: string;
  /** 32-byte index id, `0x` and 64 hexadecimal digits. */
  readonly indexId: string;
  /** Version number, from 1. */
  readonly version: number;
}

export type VerifyIndexVersionOptions = VerifyTarget &
  (
    | {
        /** JSON-RPC endpoint of the chain. Requests are sent with `fetch`. */
        readonly rpcUrl: string;
        /** A Fetch API implementation for the RPC requests. Defaults to the global `fetch`. */
        readonly fetch?: Fetch;
        readonly publicClient?: never;
      }
    | {
        /** A chain client, such as a viem `PublicClient`, connected to the chain. */
        readonly publicClient: PublicClientLike;
        readonly rpcUrl?: never;
        readonly fetch?: never;
      }
  );

/** What the registry stores for one version, read at one block, and checks C1 to C5 on it. */
export interface IndexVersionVerification {
  /** True only if C1 to C5 all pass. Compute from `spec` only when it is true. */
  readonly conformant: boolean;
  /** C1 to C5 in order, each with `status` (`pass`, `fail` or `skipped`), a stable `code` and a `reason`. */
  readonly checks: readonly CheckResult[];
  /** Every schema violation found by C4. */
  readonly specErrors: readonly SpecError[];
  /** The validated spec. `null` unless the version is conformant, so nothing is read from an unverified spec. */
  readonly spec: IndexSpec | null;
  readonly chainId: number;
  /** Lowercase address of the registry that was read. */
  readonly registry: Hex;
  readonly indexId: Hex;
  readonly version: number;
  /** Block every value was read at. */
  readonly blockNumber: bigint;
  /** Account that created the index. */
  readonly creator: Hex;
  /** Number of versions of the index at `blockNumber`. */
  readonly latestVersion: number;
  /** Unix seconds of the deprecation of the index, or `null` if it is not deprecated. */
  readonly deprecatedAt: bigint | null;
  /** keccak256 of the spec bytes, computed by the registry at publication. */
  readonly specHash: Hex;
  /** Unix seconds of the block the version was published in. */
  readonly publishedAt: bigint;
  readonly publishedBlock: bigint;
  /** How much of the version the registry mirrors in contract state. `static`: tokens and weights. */
  readonly composition: Composition;
  /** The stored spec, byte for byte. */
  readonly specBytes: Uint8Array;
  /** The stored constituents, in the order of the registry. Tokens are lowercase. */
  readonly constituents: readonly PublishedConstituent[];
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function readHex(value: unknown, what: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new RegistryReadError(
      "malformed_response",
      `the RPC endpoint answered ${what} with something other than hex`,
    );
  }
  return value as Hex;
}

/** A minimal JSON-RPC client over `fetch`, for the four reads of `PublicClientLike`. */
export function jsonRpcClient(rpcUrl: string, fetch: Fetch = globalFetch()): PublicClientLike {
  let id = 0;
  async function request(method: string, params: readonly unknown[]): Promise<unknown> {
    id += 1;
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const text = await response.text();
    if (response.status < 200 || response.status > 299) {
      throw new Error(`${method}: the RPC endpoint answered with status ${response.status}`);
    }
    const body: unknown = JSON.parse(text);
    if (typeof body !== "object" || body === null) throw new Error(`${method}: the answer is not a JSON object`);
    if ("error" in body && body.error !== undefined && body.error !== null) {
      const message =
        typeof body.error === "object" && "message" in body.error ? String(body.error.message) : "unknown error";
      throw new Error(`${method}: ${message}`);
    }
    if (!("result" in body)) throw new Error(`${method}: the answer has no result`);
    return body.result;
  }
  const quantity = (value: bigint) => `0x${value.toString(16)}`;
  return {
    getChainId: async () => Number(BigInt(readHex(await request("eth_chainId", []), "eth_chainId"))),
    getBlockNumber: async () => BigInt(readHex(await request("eth_blockNumber", []), "eth_blockNumber")),
    getCode: async ({ address, blockNumber }) =>
      readHex(await request("eth_getCode", [address, quantity(blockNumber)]), "eth_getCode"),
    call: async ({ to, data, blockNumber }) => ({
      data: readHex(await request("eth_call", [{ to, data }, quantity(blockNumber)]), "eth_call"),
    }),
  };
}

function validate(options: VerifyTarget): { readonly registry: Hex; readonly indexId: Hex } {
  const { chainId, registry, indexId, version } = options;
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new TypeError("chainId is not a positive integer");
  if (!HEX_ADDRESS.test(registry)) throw new TypeError("registry is not a 20-byte hex address");
  if (!HEX_BYTES32.test(indexId)) throw new TypeError("indexId is not 32 bytes of hex");
  if (!isVersionNumber(version)) throw new TypeError("version is not an integer from 1 to 4294967295");
  return { registry: registry.toLowerCase() as Hex, indexId: indexId.toLowerCase() as Hex };
}

function chainClient(options: VerifyIndexVersionOptions): PublicClientLike {
  if (options.publicClient !== undefined) return options.publicClient;
  if (typeof options.rpcUrl !== "string") throw new TypeError("pass rpcUrl or publicClient");
  return jsonRpcClient(options.rpcUrl, options.fetch);
}

/** Runs one read and turns any failure into a `RegistryReadError`, keeping its own codes as they are. */
async function read<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RegistryReadError) throw error;
    if (error instanceof AbiDecodingError) {
      throw new RegistryReadError("malformed_response", `${what}: ${error.message}`, { cause: error });
    }
    throw new RegistryReadError("rpc_failure", `${what} failed`, { cause: error });
  }
}

/**
 * Reads one published version from the `IndexRegistry` contract and runs checks C1 to C5 of the methodology spec
 * on it, without calling the EquityOS API. Every value is read at one block, and the RPC endpoint must report the
 * chain asked for, because check C4 compares it with the chain id the spec names.
 *
 * A version that fails a check is a result (`conformant: false`), not an error. The function throws
 * `RegistryReadError` only when the version cannot be read: another chain, no registry at the address, an
 * unknown index or version, a failing endpoint or an answer the registry cannot have produced.
 *
 * ```ts
 * const result = await verifyIndexVersion({
 *   chainId: 8453,
 *   registry: INDEX_REGISTRY_ADDRESS,
 *   indexId: "0x...",
 *   version: 1,
 *   rpcUrl: "https://base-rpc.example",
 * });
 * if (result.conformant) console.log(result.spec?.name, result.constituents);
 * ```
 */
export async function verifyIndexVersion(options: VerifyIndexVersionOptions): Promise<IndexVersionVerification> {
  const { registry, indexId } = validate(options);
  const { chainId, version } = options;
  const client = chainClient(options);

  const actualChainId = await read("eth_chainId", () => client.getChainId());
  if (actualChainId !== chainId) {
    throw new RegistryReadError("chain_mismatch", `the RPC endpoint is on chain ${actualChainId}, not ${chainId}`);
  }
  const blockNumber = await read("eth_blockNumber", () => client.getBlockNumber());
  const code = await read("eth_getCode", () => client.getCode({ address: registry, blockNumber }));
  if (code === undefined || code === "0x") {
    throw new RegistryReadError("registry_not_deployed", `no code at ${registry} on chain ${chainId}`);
  }

  const call = (name: string, data: Hex) =>
    read(name, async () => {
      const result = await client.call({ to: registry, data, blockNumber });
      if (result.data === undefined) throw new AbiDecodingError("the call returned no data");
      return readHex(result.data, name);
    });

  const exists = await read("exists", async () => decodeBool(await call("exists", encodeExists(indexId))));
  if (!exists) {
    throw new RegistryReadError("index_not_found", `the registry holds no index ${indexId}`);
  }
  const head = await read("getIndex", async () => decodeIndexInfo(await call("getIndex", encodeGetIndex(indexId))));
  if (version > head.latestVersion) {
    throw new RegistryReadError("version_not_found", `index ${indexId} has ${head.latestVersion} versions`);
  }
  const [info, specBytes, constituents] = await Promise.all([
    read("getVersion", async () =>
      decodeVersionInfo(await call("getVersion", encodeVersionCall(SELECTORS.getVersion, indexId, version))),
    ),
    read("specOf", async () =>
      decodeBytes(await call("specOf", encodeVersionCall(SELECTORS.specOf, indexId, version))),
    ),
    read("constituentsOf", async () =>
      decodeConstituents(await call("constituentsOf", encodeVersionCall(SELECTORS.constituentsOf, indexId, version))),
    ),
  ]);
  if (specBytes.length !== info.specSize || constituents.length !== info.constituentCount) {
    throw new RegistryReadError(
      "malformed_response",
      "the stored spec or constituents do not have the size the version records",
    );
  }

  const report = verifyVersion({ specBytes, specHash: info.specHash, constituents, chainId });
  return {
    conformant: report.conformant,
    checks: report.checks,
    specErrors: report.specErrors,
    spec: report.conformant && report.spec !== undefined ? report.spec : null,
    chainId,
    registry,
    indexId,
    version,
    blockNumber,
    creator: head.creator,
    latestVersion: head.latestVersion,
    deprecatedAt: head.deprecatedAt === 0n ? null : head.deprecatedAt,
    specHash: info.specHash,
    publishedAt: info.publishedAt,
    publishedBlock: info.publishedBlock,
    composition: info.composition,
    specBytes,
    constituents,
  };
}

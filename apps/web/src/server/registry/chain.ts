import "server-only";
import { indexRegistryAbi } from "@equityos/contracts-abi";
import { type Address, createPublicClient, type Hex, http, type PublicClient } from "viem";
import { MalformedRegistryResponseError, RegistryError, RegistryUpstreamError } from "./errors";
import type { Composition, IndexHead, PublishedVersion } from "./types";

const RPC_TIMEOUT_MS = 10_000;
const RPC_RETRY_COUNT = 2;

/**
 * Calldata bytes per Multicall3 request. A registry call is 36 or 68 bytes, so one request carries 240 to
 * 455 calls: the ids of a large registry are read 455 at a time, and a full page of versions fits in one
 * request.
 */
const MULTICALL_BATCH_BYTES = 16_384;

/** The read-only client surface the registry reader needs. */
export type RegistryClient = Pick<
  PublicClient,
  "getBlock" | "getBlockNumber" | "getChainId" | "getCode" | "getLogs" | "multicall" | "readContract"
>;

/** Creates a read-only client of the endpoint. */
export function createRegistryClient(rpcUrl: string): RegistryClient {
  return createPublicClient({ transport: http(rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: RPC_RETRY_COUNT }) });
}

/** What every batched read needs to know about the chain. */
export interface ChainTarget {
  readonly client: RegistryClient;
  readonly chainId: number;
  readonly registry: Address;
  readonly multicall: Address | "deployless";
}

/**
 * Runs a read and reports any failure of it as an upstream failure. The calls in this module are made only
 * for indexes and versions known to exist, so a revert is as unexpected as a transport error.
 */
export async function upstream<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (cause) {
    if (cause instanceof RegistryError) throw cause;
    throw new RegistryUpstreamError(`${what} failed`, { cause });
  }
}

function lowercase<T extends Hex>(value: T): T {
  return value.toLowerCase() as T;
}

function multicallOptions(target: ChainTarget, blockNumber: bigint) {
  const destination = target.multicall === "deployless" ? { deployless: true } : { multicallAddress: target.multicall };
  return { ...destination, allowFailure: false, batchSize: MULTICALL_BATCH_BYTES, blockNumber } as const;
}

const COMPOSITIONS: readonly Composition[] = ["rule_based", "dynamic_weights", "static"];

/** Whether the registry address holds code at the latest block. */
export function hasRegistryCode(target: ChainTarget): Promise<boolean> {
  return upstream("eth_getCode", async () => {
    const code = await target.client.getCode({ address: target.registry });
    return code !== undefined && code !== "0x";
  });
}

/** The chain id the endpoint reports. */
export function readChainId(client: RegistryClient): Promise<number> {
  return upstream("eth_chainId", () => client.getChainId());
}

/**
 * Reads `indexCount` and the ids at positions `known` and above, all at one block.
 *
 * @param known number of ids the caller already holds; positions are stable, so they are not read again
 * @returns the count, and the ids at positions `known` to `count - 1` in order
 */
export function readIndexIds(target: ChainTarget, known: number): Promise<{ count: number; ids: Hex[] }> {
  return upstream("reading the index ids", async () => {
    const blockNumber = await target.client.getBlockNumber({ cacheTime: 0 });
    const total = await target.client.readContract({
      address: target.registry,
      abi: indexRegistryAbi,
      functionName: "indexCount",
      blockNumber,
    });
    if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(known)) {
      throw new MalformedRegistryResponseError(`indexCount is ${total} after ${known} ids were read`);
    }
    const count = Number(total);
    if (count === known) return { count, ids: [] };
    const positions = Array.from({ length: count - known }, (_, offset) => BigInt(known + offset));
    const ids = await target.client.multicall({
      ...multicallOptions(target, blockNumber),
      contracts: positions.map((position) => ({
        address: target.registry,
        abi: indexRegistryAbi,
        functionName: "indexIdAt" as const,
        args: [position] as const,
      })),
    });
    return { count, ids: ids.map(lowercase) };
  });
}

/** Reads the index-level state of existing indexes at one block, in the order of `indexIds`. */
export function readHeads(target: ChainTarget, indexIds: readonly Hex[]): Promise<IndexHead[]> {
  return upstream("reading index state", async () => {
    const blockNumber = await target.client.getBlockNumber({ cacheTime: 0 });
    const infos = await target.client.multicall({
      ...multicallOptions(target, blockNumber),
      contracts: indexIds.map((indexId) => ({
        address: target.registry,
        abi: indexRegistryAbi,
        functionName: "getIndex" as const,
        args: [indexId] as const,
      })),
    });
    return infos.map((info, i): IndexHead => {
      const indexId = indexIds[i];
      if (indexId === undefined || info.latestVersion < 1) {
        throw new MalformedRegistryResponseError("getIndex returned an index without a version");
      }
      return {
        indexId,
        creator: lowercase(info.creator),
        latestVersion: info.latestVersion,
        createdAt: info.createdAt,
        deprecatedAt: info.deprecatedAt === 0n ? null : info.deprecatedAt,
      };
    });
  });
}

export interface VersionRef {
  readonly indexId: Hex;
  readonly version: number;
  /** Creator of the index, which never changes. */
  readonly creator: Address;
}

/** Reads what the registry stores for existing versions at one block, in the order of `refs`. */
export function readVersions(target: ChainTarget, refs: readonly VersionRef[]): Promise<PublishedVersion[]> {
  return upstream("reading index versions", async () => {
    const blockNumber = await target.client.getBlockNumber({ cacheTime: 0 });
    const options = multicallOptions(target, blockNumber);
    const call = <const Name extends "getVersion" | "specOf" | "constituentsOf">(functionName: Name) =>
      refs.map(({ indexId, version }) => ({
        address: target.registry,
        abi: indexRegistryAbi,
        functionName,
        args: [indexId, version] as const,
      }));
    const [infos, specs, mirrors] = await Promise.all([
      target.client.multicall({ ...options, contracts: call("getVersion") }),
      target.client.multicall({ ...options, contracts: call("specOf") }),
      target.client.multicall({ ...options, contracts: call("constituentsOf") }),
    ]);
    return refs.map((ref, i): PublishedVersion => {
      const info = infos[i];
      const specBytes = specs[i];
      const mirror = mirrors[i];
      const composition = info === undefined ? undefined : COMPOSITIONS[info.composition];
      if (info === undefined || specBytes === undefined || mirror === undefined || composition === undefined) {
        throw new MalformedRegistryResponseError(`version ${ref.version} of ${ref.indexId} was not fully returned`);
      }
      return {
        chainId: target.chainId,
        registry: lowercase(target.registry),
        indexId: ref.indexId,
        version: ref.version,
        creator: ref.creator,
        specHash: lowercase(info.specHash),
        publishedAt: info.publishedAt,
        publishedBlock: info.publishedBlock,
        composition,
        specBytes,
        constituents: mirror.map(({ token, weightBps }) => ({ token: lowercase(token), weightBps })),
      };
    });
  });
}

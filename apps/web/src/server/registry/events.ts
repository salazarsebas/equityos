import "server-only";
import { indexRegistryAbi, rebalanceLogAbi } from "@equityos/contracts-abi";
import { type Address, getAbiItem, type Hex } from "viem";
import { type RegistryClient, upstream } from "./chain";
import { MalformedRegistryResponseError } from "./errors";
import type { Composition } from "./types";

/** Where and when a log was emitted. */
export interface EventOrigin {
  readonly blockNumber: bigint;
  /** Timestamp of the block, Unix seconds. */
  readonly blockTimestamp: bigint;
  readonly transactionHash: Hex;
  /** Position of the log in its block. */
  readonly logIndex: number;
}

export type RegistryEvent = EventOrigin &
  (
    | { readonly type: "index_created"; readonly indexId: Hex; readonly creator: Address; readonly salt: Hex }
    | {
        readonly type: "version_published";
        readonly indexId: Hex;
        readonly version: number;
        readonly specHash: Hex;
        readonly creator: Address;
        readonly composition: Composition;
        /** Informational sizes carried by the event. Contract state is authoritative. */
        readonly specSize: number;
        readonly constituentCount: number;
      }
    | { readonly type: "index_deprecated"; readonly indexId: Hex; readonly creator: Address }
    /** A claim by `account` that it rebalanced towards a version. It carries no amounts and proves no trade. */
    | {
        readonly type: "rebalance_recorded";
        readonly account: Address;
        readonly indexId: Hex;
        readonly version: number;
      }
  );

export interface EventScan {
  /** Every event found so far, ordered by block and by position in the block. */
  readonly events: readonly RegistryEvent[];
  /** First block of the scan: the deploy block. */
  readonly fromBlock: bigint;
  /** Last block scanned, `null` before the first range completes. */
  readonly scannedToBlock: bigint | null;
  /** Last block the scan may cover now: the head minus the confirmations. */
  readonly targetBlock: bigint;
  /** False while blocks up to `targetBlock` remain: `events` is then a prefix of the history, not all of it. */
  readonly complete: boolean;
}

export interface EventScannerOptions {
  readonly client: RegistryClient;
  readonly registry: Address;
  readonly rebalanceLog: Address;
  readonly deployBlock: bigint;
  /** Maximum number of blocks of one `eth_getLogs` request. */
  readonly chunkBlocks: bigint;
  /** Blocks the scan stays behind the head. */
  readonly confirmations: bigint;
  /** Maximum `eth_getLogs` requests of one `scan` call, so that a long history is covered over several calls. */
  readonly maxChunksPerScan?: number;
}

export interface EventScanner {
  /**
   * Scans the blocks not covered yet, in ranges of at most `chunkBlocks`, and returns everything found so far.
   * A range that was scanned is never requested again.
   *
   * @throws {RegistryUpstreamError} if a request fails. The ranges completed before it are kept.
   */
  scan(): Promise<EventScan>;
}

/** `eth_getLogs` requests of one scan by default: 100,000 blocks at the default range. */
export const DEFAULT_MAX_CHUNKS_PER_SCAN = 50;

const EVENTS = [
  getAbiItem({ abi: indexRegistryAbi, name: "IndexCreated" }),
  getAbiItem({ abi: indexRegistryAbi, name: "VersionPublished" }),
  getAbiItem({ abi: indexRegistryAbi, name: "IndexDeprecated" }),
  getAbiItem({ abi: rebalanceLogAbi, name: "RebalanceRecorded" }),
] as const;

const COMPOSITIONS: readonly Composition[] = ["rule_based", "dynamic_weights", "static"];

function lowercase<T extends Hex>(value: T): T {
  return value.toLowerCase() as T;
}

/**
 * The inclusive block ranges that cover `from` to `to`, each at most `size` blocks, without gap or overlap.
 * Empty when `from` is past `to`.
 */
export function blockRanges(from: bigint, to: bigint, size: bigint): { from: bigint; to: bigint }[] {
  if (size < 1n) throw new RangeError("the range size must be at least one block");
  const ranges: { from: bigint; to: bigint }[] = [];
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n;
    ranges.push({ from: start, to: end < to ? end : to });
  }
  return ranges;
}

/** Creates a scanner that keeps the events it found and the last block it scanned, in process memory. */
export function createEventScanner(options: EventScannerOptions): EventScanner {
  const { client, deployBlock, chunkBlocks, confirmations } = options;
  const registry = lowercase(options.registry);
  const rebalanceLog = lowercase(options.rebalanceLog);
  const maxChunks = options.maxChunksPerScan ?? DEFAULT_MAX_CHUNKS_PER_SCAN;
  const events: RegistryEvent[] = [];
  let nextBlock = deployBlock;
  let pending: Promise<EventScan> | null = null;

  async function readRange(from: bigint, to: bigint): Promise<RegistryEvent[]> {
    const logs = await client.getLogs({
      address: [registry, rebalanceLog],
      events: EVENTS,
      fromBlock: from,
      toBlock: to,
      strict: true,
    });
    const timestamps = new Map<bigint, bigint>();
    const found: RegistryEvent[] = [];
    for (const log of logs) {
      if (log.blockNumber < from || log.blockNumber > to) {
        throw new MalformedRegistryResponseError(`a log of block ${log.blockNumber} is outside ${from} to ${to}`);
      }
      // Each event is accepted only from the contract that declares it.
      const emitter = log.eventName === "RebalanceRecorded" ? rebalanceLog : registry;
      if (lowercase(log.address) !== emitter) continue;
      let blockTimestamp = log.blockTimestamp ?? timestamps.get(log.blockNumber);
      if (blockTimestamp === undefined) {
        blockTimestamp = (await client.getBlock({ blockNumber: log.blockNumber })).timestamp;
      }
      timestamps.set(log.blockNumber, blockTimestamp);
      const origin: EventOrigin = {
        blockNumber: log.blockNumber,
        blockTimestamp,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      };
      switch (log.eventName) {
        case "IndexCreated":
          found.push({
            ...origin,
            type: "index_created",
            indexId: log.args.indexId,
            creator: lowercase(log.args.creator),
            salt: log.args.salt,
          });
          break;
        case "VersionPublished": {
          const composition = COMPOSITIONS[log.args.composition];
          if (composition === undefined) throw new MalformedRegistryResponseError("unknown composition in a log");
          found.push({
            ...origin,
            type: "version_published",
            indexId: log.args.indexId,
            version: log.args.version,
            specHash: log.args.specHash,
            creator: lowercase(log.args.creator),
            composition,
            specSize: log.args.specSize,
            constituentCount: log.args.constituentCount,
          });
          break;
        }
        case "IndexDeprecated":
          found.push({
            ...origin,
            type: "index_deprecated",
            indexId: log.args.indexId,
            creator: lowercase(log.args.creator),
          });
          break;
        case "RebalanceRecorded":
          found.push({
            ...origin,
            type: "rebalance_recorded",
            account: lowercase(log.args.account),
            indexId: log.args.indexId,
            version: log.args.version,
          });
          break;
      }
    }
    return found;
  }

  async function run(): Promise<EventScan> {
    const head = await upstream("eth_blockNumber", () => client.getBlockNumber({ cacheTime: 0 }));
    const targetBlock = head - confirmations;
    for (const { from, to } of blockRanges(nextBlock, targetBlock, chunkBlocks).slice(0, maxChunks)) {
      events.push(...(await upstream(`eth_getLogs for blocks ${from} to ${to}`, () => readRange(from, to))));
      // Advanced only after the range was read and decoded, so a failed range is requested again.
      nextBlock = to + 1n;
    }
    return {
      events: [...events],
      fromBlock: deployBlock,
      scannedToBlock: nextBlock > deployBlock ? nextBlock - 1n : null,
      targetBlock,
      complete: nextBlock > targetBlock,
    };
  }

  return {
    scan(): Promise<EventScan> {
      pending ??= run().finally(() => {
        pending = null;
      });
      return pending;
    },
  };
}

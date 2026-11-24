import "server-only";
import type { Address, Hex } from "viem";
import { createCache } from "../cache";
import { upstream } from "../registry/chain";
import {
  createRegistryClient,
  type EventScan,
  getRegistryReader,
  getRegistryReplay,
  HEADS_CACHE,
  MalformedRegistryResponseError,
  type RegistryConfig,
  type RegistryEvent,
  type RegistryNotDeployed,
  type RegistryReader,
  resolveRegistryConfig,
  resolveRegistryRpcUrl,
} from "../registry";
import { buildNetworkMetrics, type ClassifiedAttestation, type IndexLabel, type NetworkMetrics } from "./aggregate";
import { assessFlows, assessTracking, isBefore, isLinkable, type LinkCandidate, tierOf } from "./classify";
import { TIER_B_WINDOW_SECONDS } from "./definitions";
import { EXCLUDED_ACCOUNTS_VARIABLE, type ExcludedAccount, parseExcludedAccounts } from "./exclusions";
import { type NetworkClient, readAtBlock, readTransaction, readWindowTransactions } from "./evidence";

type Attestation = Extract<RegistryEvent, { type: "rebalance_recorded" }>;

/** Attestations classified per read at most: the rest are classified by the next reads. */
const MAX_CLASSIFIED_PER_READ = 100;

export type NetworkRead =
  | RegistryNotDeployed
  | {
      readonly status: "ok";
      readonly chainId: number;
      readonly registry: Address;
      readonly rebalanceLog: Address;
      readonly scan: Omit<EventScan, "events">;
      /** False while some scanned attestations are not classified yet. */
      readonly usageComplete: boolean;
      readonly metrics: NetworkMetrics;
      /** Every classified attestation, excluded accounts included, in event order. */
      readonly classified: readonly ClassifiedAttestation[];
      readonly exclusions: readonly ExcludedAccount[];
    };

export interface NetworkService {
  /**
   * The metrics over everything scanned so far. Reads are incremental: an attestation is classified once, and a
   * result is reused while no block was scanned and no attestation classified since.
   *
   * @throws {RegistryUpstreamError} if the RPC endpoint fails.
   * @throws {RegistryConfigurationError} if the endpoint or the exclusions are misconfigured.
   */
  read(): Promise<NetworkRead>;
}

export interface NetworkServiceOptions {
  readonly reader: RegistryReader;
  readonly config: RegistryConfig;
  /** Read-only client of the registry chain, created on first use. */
  readonly client: () => NetworkClient;
  readonly exclusions: readonly ExcludedAccount[];
  /** Clock in Unix seconds. */
  readonly now: () => number;
  readonly maxClassifiedPerRead?: number;
}

export function createNetworkService(options: NetworkServiceOptions): NetworkService {
  const { reader, config, exclusions, now } = options;
  const { deployment } = config;
  const maxPerRead = options.maxClassifiedPerRead ?? MAX_CLASSIFIED_PER_READ;
  const classified: ClassifiedAttestation[] = [];
  const linked = new Set<Hex>();
  let last: { key: string; read: NetworkRead } | null = null;

  async function classify(event: Attestation): Promise<ClassifiedAttestation> {
    const client = options.client();
    const version = await reader.getVersion(event.indexId, event.version);
    if (version.status !== "ok") {
      throw new MalformedRegistryResponseError(`attested version ${event.version} of ${event.indexId} is missing`);
    }
    const { constituents, composition } = version.version;
    const tokens = constituents.map(({ token }) => token);
    const tokenSet = new Set(tokens);
    const own = await readTransaction(client, event.transactionHash);
    const block = { number: event.blockNumber, timestamp: event.blockTimestamp };
    const atBlock = await readAtBlock(client, config.multicall, block, event.account, tokens);
    const assessment = assessFlows(own.transfers, event.account, tokenSet, atBlock.prices);
    const attestation = { ...own, account: event.account, blockTimestamp: event.blockTimestamp };

    let link: LinkCandidate | null = null;
    if (assessment.status !== "matched" && own.sender === event.account) {
      const hashes = await readWindowTransactions(client, {
        tokens,
        account: event.account,
        toBlock: event.blockNumber,
        floorBlock: deployment.deployBlock ?? 0n,
        chunkBlocks: config.logChunkBlocks,
        notBefore: event.blockTimestamp - TIER_B_WINDOW_SECONDS,
      });
      const earlier = (await Promise.all([...hashes].map((hash) => readTransaction(client, hash))))
        .filter((transaction) => transaction.sender === event.account && isBefore(transaction, attestation))
        .sort((a, b) => (isBefore(a, b) ? 1 : -1));
      // The latest qualifying transaction links: valued one at a time, newest first.
      for (const transaction of earlier) {
        const { timestamp } = await client.getBlock({ blockNumber: transaction.blockNumber });
        const prices = (
          await readAtBlock(
            client,
            config.multicall,
            { number: transaction.blockNumber, timestamp },
            event.account,
            tokens,
          )
        ).prices;
        const candidate: LinkCandidate = {
          ...transaction,
          blockTimestamp: timestamp,
          assessment: assessFlows(transaction.transfers, event.account, tokenSet, prices),
        };
        if (isLinkable(attestation, candidate, linked)) {
          link = candidate;
          break;
        }
      }
    }
    if (link !== null) linked.add(link.hash);
    const tier = tierOf(assessment, link);
    const tracking =
      tier.tier === "a"
        ? assessTracking({
            composition,
            constituents,
            driftThresholdBps: version.version.conformant ? version.version.spec.rebalance.driftThresholdBps : null,
            balances: atBlock.balances,
            prices: atBlock.prices,
          })
        : null;
    return { ...tier, event, tracking };
  }

  async function labelsOf(indexIds: Iterable<Hex>): Promise<Map<Hex, IndexLabel>> {
    const labels = new Map<Hex, IndexLabel>();
    for (const indexId of indexIds) {
      const found = await reader.getIndex(indexId);
      if (found.status !== "ok") continue;
      const { identifier, latest } = found.index;
      labels.set(indexId, { identifier, name: latest.conformant ? latest.spec.name : null });
    }
    return labels;
  }

  async function load(): Promise<NetworkRead> {
    const scan = await reader.getEvents();
    if (scan.status !== "ok") return scan;
    const attestations = scan.events.filter((event): event is Attestation => event.type === "rebalance_recorded");
    for (const event of attestations.slice(classified.length, classified.length + maxPerRead)) {
      classified.push(await upstream(`classifying the attestation in ${event.transactionHash}`, () => classify(event)));
    }
    const key = `${scan.scannedToBlock}:${classified.length}`;
    if (last?.key === key) return last.read;
    const pending = attestations[classified.length];
    const usageToBlock = pending === undefined ? scan.scannedToBlock : pending.blockNumber - 1n;
    const excluded = new Set(exclusions.map(({ address }) => address));
    const counted = classified.filter(({ event }) => !excluded.has(event.account));
    const read: NetworkRead = {
      status: "ok",
      chainId: reader.chainId,
      registry: reader.registry,
      rebalanceLog: `0x${deployment.rebalanceLog.slice(2).toLowerCase()}`,
      scan: {
        fromBlock: scan.fromBlock,
        scannedToBlock: scan.scannedToBlock,
        targetBlock: scan.targetBlock,
        complete: scan.complete,
      },
      usageComplete: pending === undefined,
      metrics: buildNetworkMetrics({
        chainId: reader.chainId,
        scan,
        classified,
        usageToBlock,
        exclusions,
        labels: await labelsOf(new Set(counted.map(({ event }) => event.indexId))),
        computedAt: now(),
      }),
      classified: [...classified],
      exclusions,
    };
    last = { key, read };
    return read;
  }

  const cache = createCache(HEADS_CACHE, load, now);
  return {
    async read() {
      return (await cache.get()).value;
    },
  };
}

let shared: NetworkService | undefined;

/**
 * The process-wide service, over the process-wide registry reader: the chain of `EQUITYOS_CHAIN_ID`, or the
 * recording of `REGISTRY_REPLAY_DIR`. Excluded accounts come from `EQUITYOS_EXCLUDED_ACCOUNTS`.
 *
 * @throws {RegistryConfigurationError} if the environment does not describe a usable chain, recording or list
 *   of excluded accounts.
 */
export function getNetworkService(): NetworkService {
  if (shared === undefined) {
    const exclusions = parseExcludedAccounts(process.env[EXCLUDED_ACCOUNTS_VARIABLE]);
    const replay = getRegistryReplay();
    const config = replay?.config ?? resolveRegistryConfig();
    let client: NetworkClient | undefined = replay?.client;
    shared = createNetworkService({
      reader: getRegistryReader(),
      config,
      client: () => {
        client ??= createRegistryClient(resolveRegistryRpcUrl(config.chainId));
        return client;
      },
      exclusions,
      now: () => Math.floor(Date.now() / 1000),
    });
  }
  return shared;
}

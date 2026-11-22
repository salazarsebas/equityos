import "server-only";
import type { Address, Hex } from "viem";
import { type CachePolicy, createCache, createKeyedCache, IMMUTABLE, type KeyedCache } from "../cache";
import {
  type ChainTarget,
  createRegistryClient,
  hasRegistryCode,
  type RegistryClient,
  readChainId,
  readHeads,
  readIndexIds,
  readVersions,
  type VersionRef,
} from "./chain";
import { type RegistryConfig, resolveRegistryConfig, resolveRegistryRpcUrl } from "./config";
import { RegistryConfigurationError, RegistryUpstreamError } from "./errors";
import { createEventScanner, type EventScan, type EventScanner } from "./events";
import { createIndexDirectory, formatIdentifier, parseIdentifier } from "./identifier";
import { loadRegistryReplay, REGISTRY_REPLAY_VARIABLE, type RegistryReplay } from "./replay";
import {
  DEFAULT_PAGE_SIZE,
  type IndexHead,
  type IndexPage,
  type IndexSummary,
  type IndexVersionView,
  MAX_PAGE_SIZE,
  type PageRequest,
  type RegistryLookup,
  type RegistryNotDeployed,
  type RegistryRead,
  type VersionPage,
} from "./types";
import { buildVersionView } from "./views";

/**
 * Everything that can change: whether the registry has code, the number of indexes, and the state of an index
 * (latest version, deprecation). Ten seconds is a few Base blocks, so a new index or version appears almost
 * at once, while a burst of requests makes one read. Nothing is served past the TTL: when the RPC endpoint is
 * down the read fails instead of presenting an old head as current.
 */
export const HEADS_CACHE: CachePolicy = { ttlSeconds: 10, staleIfErrorSeconds: 0 };

/** Verified versions kept in memory. A version is at most 8,192 bytes of spec and 64 constituents. */
const MAX_CACHED_VERSIONS = 5_000;

/**
 * The caches of the reader. Their keys start with the chain id and the registry address, so one set can serve
 * readers of several chains without ever answering one with the data of another.
 */
export interface RegistryCaches {
  readonly heads: KeyedCache<IndexHead>;
  /** A published version never changes, so a verified version is kept without expiry. */
  readonly versions: KeyedCache<IndexVersionView>;
}

export function createRegistryCaches(now: () => number): RegistryCaches {
  return {
    heads: createKeyedCache(HEADS_CACHE, now),
    versions: createKeyedCache(IMMUTABLE, now, { maxEntries: MAX_CACHED_VERSIONS }),
  };
}

export interface RegistryReaderOptions {
  /** Defaults to the configuration resolved from the environment. */
  readonly config?: RegistryConfig;
  /** Read-only client of the configured chain. Defaults to one built from the environment on first use. */
  readonly client?: RegistryClient;
  /** Clock in Unix seconds. */
  readonly now?: () => number;
  readonly caches?: RegistryCaches;
  /** See `EventScannerOptions.maxChunksPerScan`. */
  readonly maxLogChunksPerScan?: number;
}

/**
 * Read-only access to the index registry of one chain. Every method resolves to `registry_not_deployed` when
 * the registry has no code on that chain, and throws only when the read itself fails:
 *
 * @throws {RegistryUpstreamError} if the RPC endpoint fails.
 * @throws {MalformedRegistryResponseError} if the chain returns something the registry cannot have produced.
 * @throws {RegistryConfigurationError} if the RPC endpoint is not configured or is not the configured chain.
 */
export interface RegistryReader {
  /** The chain this reader reads, and the lowercase address the registry has on it. */
  readonly chainId: number;
  readonly registry: Address;
  /** A page of indexes in creation order, each with its latest version. */
  listIndexes(page?: PageRequest): Promise<RegistryRead<IndexPage>>;
  /** Resolves a URL identifier: an index id, or `<slug>-<prefix>` (see `identifier.ts`). */
  getIndex(
    identifier: string,
  ): Promise<RegistryLookup<{ index: IndexSummary }, "invalid_identifier" | "index_not_found">>;
  getVersion(
    indexId: Hex,
    version: number,
  ): Promise<RegistryLookup<{ version: IndexVersionView }, "index_not_found" | "version_not_found">>;
  /** A page of the versions of an index, in ascending version order. */
  listVersions(indexId: Hex, page?: PageRequest): Promise<RegistryLookup<VersionPage, "index_not_found">>;
  /** The registry and rebalance events found so far. See `EventScanner.scan`. */
  getEvents(): Promise<RegistryRead<EventScan>>;
}

function lowercaseAddress(address: Address): Address {
  return `0x${address.slice(2).toLowerCase()}`;
}

function systemClock(): number {
  return Math.floor(Date.now() / 1000);
}

/** The positions `offset` to `offset + limit - 1` that are below `total`. */
function pagePositions(page: PageRequest, total: number): { offset: number; positions: number[] } {
  const offset = page.offset ?? 0;
  const limit = page.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("offset must be a non-negative integer");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new RangeError(`limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  const length = Math.max(0, Math.min(limit, total - offset));
  return { offset, positions: Array.from({ length }, (_, i) => offset + i) };
}

/** Creates a reader with its own index directory and, unless given, its own caches. */
export function createRegistryReader(options: RegistryReaderOptions = {}): RegistryReader {
  const config = options.config ?? resolveRegistryConfig();
  const now = options.now ?? systemClock;
  const caches = options.caches ?? createRegistryCaches(now);
  const { chainId, deployment } = config;
  const registry: Address = deployment.registry;
  /** Prefix of every cache key: versions are immutable per `(chainId, registry, indexId, version)`. */
  const scope = `${chainId}:${lowercaseAddress(registry)}`;

  let target: ChainTarget | undefined;
  function chain(): ChainTarget {
    target ??= {
      client: options.client ?? createRegistryClient(resolveRegistryRpcUrl(chainId)),
      chainId,
      registry,
      multicall: config.multicall,
    };
    return target;
  }

  let chainVerified = false;
  let codeSeen = false;
  const presence = createCache(
    HEADS_CACHE,
    async () => {
      if (!chainVerified) {
        const reported = await readChainId(chain().client);
        if (reported !== chainId) {
          throw new RegistryConfigurationError(
            "EQUITYOS_CHAIN_ID",
            `is ${chainId} but the RPC endpoint reports chain ${reported}`,
          );
        }
        chainVerified = true;
      }
      // Code at an address does not go away, so a positive answer is final. A negative one is asked again.
      codeSeen ||= await hasRegistryCode(chain());
      return codeSeen;
    },
    now,
  );

  /** The deploy block when the registry is deployed on the chain, the typed absence otherwise. */
  async function deployBlockOrAbsent(): Promise<bigint | RegistryNotDeployed> {
    const absent = { status: "registry_not_deployed", chainId, registry } as const;
    // Without a deploy block there is nothing to read: no request is made at all.
    if (deployment.deployBlock === null) return { ...absent, reason: "not_configured" };
    if (codeSeen || (await presence.get()).value) return deployment.deployBlock;
    return { ...absent, reason: "no_code" };
  }

  const directory = createIndexDirectory();
  const count = createCache(
    HEADS_CACHE,
    async () => {
      const { count: total, ids } = await readIndexIds(chain(), directory.size);
      directory.append(ids);
      return total;
    },
    now,
  );

  /** Number of indexes, after bringing the directory up to date with it. */
  async function syncDirectory(): Promise<number> {
    return (await count.get()).value;
  }

  async function headsOf(indexIds: readonly Hex[]): Promise<IndexHead[]> {
    const keys = indexIds.map((indexId) => `${scope}:${indexId}`);
    const idByKey = new Map(keys.map((key, i) => [key, indexIds[i]]));
    const cached = await caches.heads.getMany(keys, async (missing) => {
      const ids = missing.flatMap((key) => idByKey.get(key) ?? []);
      const heads = await readHeads(chain(), ids);
      return new Map(heads.map((head) => [`${scope}:${head.indexId}`, head]));
    });
    return keys.map((key) => {
      const head = cached.get(key);
      if (head === undefined) throw new RegistryUpstreamError("the state of an index was not returned");
      return head.value;
    });
  }

  async function versionsOf(refs: readonly VersionRef[]): Promise<IndexVersionView[]> {
    const keyOf = (ref: Pick<VersionRef, "indexId" | "version">) => `${scope}:${ref.indexId}:${ref.version}`;
    const refByKey = new Map(refs.map((ref) => [keyOf(ref), ref]));
    const cached = await caches.versions.getMany([...refByKey.keys()], async (missing) => {
      const published = await readVersions(
        chain(),
        missing.flatMap((key) => refByKey.get(key) ?? []),
      );
      return new Map(published.map((version) => [keyOf(version), buildVersionView(version)]));
    });
    return refs.map((ref) => {
      const view = cached.get(keyOf(ref));
      if (view === undefined) throw new RegistryUpstreamError("a version of an index was not returned");
      return view.value;
    });
  }

  /** Summaries of the indexes at positions the directory holds. */
  async function summariesAt(positions: readonly number[]): Promise<IndexSummary[]> {
    const indexIds = positions.flatMap((position) => directory.idAt(position) ?? []);
    const heads = await headsOf(indexIds);
    const latest = await versionsOf(
      heads.map(({ indexId, latestVersion, creator }) => ({ indexId, version: latestVersion, creator })),
    );
    return heads.map((head, i): IndexSummary => {
      const position = positions[i];
      const view = latest[i];
      const prefix = position === undefined ? undefined : directory.prefixAt(position);
      if (position === undefined || view === undefined || prefix === undefined) {
        throw new RegistryUpstreamError("an index of the directory was not returned");
      }
      const identifier = view.conformant ? formatIdentifier(view.spec.slug, prefix) : head.indexId;
      return { position, identifier, head, latest: view };
    });
  }

  /** The head of an index, or `null` if the registry holds no index with this id. */
  async function headOf(indexId: Hex): Promise<IndexHead | null> {
    await syncDirectory();
    const normalized: Hex = `0x${indexId.slice(2).toLowerCase()}`;
    if (directory.positionOf(normalized) === undefined) return null;
    const [head] = await headsOf([normalized]);
    return head ?? null;
  }

  let scanner: EventScanner | undefined;

  return {
    chainId,
    registry: lowercaseAddress(registry),
    async listIndexes(page = {}) {
      const deployed = await deployBlockOrAbsent();
      if (typeof deployed !== "bigint") return deployed;
      const total = await syncDirectory();
      const { offset, positions } = pagePositions(page, total);
      return { status: "ok", total, offset, indexes: await summariesAt(positions) };
    },

    async getIndex(identifier) {
      const parsed = parseIdentifier(identifier);
      if (parsed === null) return { status: "invalid_identifier" };
      const deployed = await deployBlockOrAbsent();
      if (typeof deployed !== "bigint") return deployed;
      await syncDirectory();
      const position =
        parsed.kind === "index_id" ? directory.positionOf(parsed.indexId) : directory.positionOfPrefix(parsed.prefix);
      if (position === undefined) return { status: "index_not_found" };
      const [index] = await summariesAt([position]);
      if (index === undefined) return { status: "index_not_found" };
      // The prefix selected the index. The slug must be the one its latest verified spec carries.
      if (parsed.kind === "slug" && !(index.latest.conformant && index.latest.spec.slug === parsed.slug)) {
        return { status: "index_not_found" };
      }
      return { status: "ok", index };
    },

    async getVersion(indexId, version) {
      const deployed = await deployBlockOrAbsent();
      if (typeof deployed !== "bigint") return deployed;
      const head = await headOf(indexId);
      if (head === null) return { status: "index_not_found" };
      if (!Number.isSafeInteger(version) || version < 1 || version > head.latestVersion) {
        return { status: "version_not_found" };
      }
      const [view] = await versionsOf([{ indexId: head.indexId, version, creator: head.creator }]);
      return view === undefined ? { status: "version_not_found" } : { status: "ok", version: view };
    },

    async listVersions(indexId, page = {}) {
      const deployed = await deployBlockOrAbsent();
      if (typeof deployed !== "bigint") return deployed;
      const head = await headOf(indexId);
      if (head === null) return { status: "index_not_found" };
      const { offset, positions } = pagePositions(page, head.latestVersion);
      const versions = await versionsOf(
        positions.map((position) => ({ indexId: head.indexId, version: position + 1, creator: head.creator })),
      );
      return { status: "ok", total: head.latestVersion, offset, versions };
    },

    async getEvents() {
      const deployed = await deployBlockOrAbsent();
      if (typeof deployed !== "bigint") return deployed;
      scanner ??= createEventScanner({
        client: chain().client,
        registry,
        rebalanceLog: deployment.rebalanceLog,
        deployBlock: deployed,
        chunkBlocks: config.logChunkBlocks,
        confirmations: config.confirmations,
        ...(options.maxLogChunksPerScan === undefined ? {} : { maxChunksPerScan: options.maxLogChunksPerScan }),
      });
      return { status: "ok", ...(await scanner.scan()) };
    },
  };
}

/**
 * - `live`: the chain selected by `EQUITYOS_CHAIN_ID` is read as it is now.
 * - `replay`: a recording of the registry of a local chain at one past block is served. For browser tests.
 */
export type RegistryMode = "live" | "replay";

function replayDirectory(env: NodeJS.ProcessEnv): string | null {
  const directory = env[REGISTRY_REPLAY_VARIABLE]?.trim() ?? "";
  return directory === "" ? null : directory;
}

/**
 * Where the process-wide reader reads from. A caller that shows registry data to a person or returns it from
 * an API must state when the mode is `replay`: a replayed registry is a past state of a development chain.
 */
export function registryMode(env: NodeJS.ProcessEnv = process.env): RegistryMode {
  return replayDirectory(env) === null ? "live" : "replay";
}

let replay: RegistryReplay | undefined;

/** The recording the process-wide reader replays, or `null` in `live` mode. */
export function getRegistryReplay(): RegistryReplay | null {
  const directory = replayDirectory(process.env);
  if (directory === null) return null;
  replay ??= loadRegistryReplay(directory);
  return replay;
}

let shared: RegistryReader | undefined;

/**
 * The process-wide reader: of the chain selected by `EQUITYOS_CHAIN_ID`, unless `REGISTRY_REPLAY_DIR` names a
 * recording to replay.
 *
 * @throws {RegistryConfigurationError} if the environment does not describe a usable chain or recording.
 */
export function getRegistryReader(): RegistryReader {
  if (shared === undefined) {
    const recording = getRegistryReplay();
    shared = createRegistryReader(recording === null ? {} : { config: recording.config, client: recording.client });
  }
  return shared;
}

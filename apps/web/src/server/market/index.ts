import "server-only";
import type { Address } from "viem";
import { type AssetList, type AssetListOptions, fetchAssetList, type ListedAsset } from "./asset-list";
import { type Cache, type Cached, type CachePolicy, createCache } from "./cache";
import { assessEligibility, type Eligibility } from "./eligibility";
import {
  IneligibleTokenError,
  MarketDataError,
  type MarketDataErrorCode,
  MissingFeedError,
  StaleFeedError,
  TokenPausedError,
  UpstreamError,
} from "./errors";
import { REFERENCE_FEEDS } from "./feeds";
import { createMarketClient, type MarketClient, type OnchainSnapshot, readOnchain, type TokenRead } from "./onchain";
import { buildReferencePrice, type ReferencePrice, type UsableReferencePrice } from "./reference-price";

/**
 * The asset list changes when the issuer lists a token, which is rare. Ten minutes bounds how long a new
 * listing stays unseen. When the API is down the last list is served for up to a day: listings are slow-moving
 * and every decision that matters is re-read from the chain.
 */
export const ASSET_LIST_CACHE: CachePolicy = { ttlSeconds: 10 * 60, staleIfErrorSeconds: 24 * 60 * 60 };

/**
 * Token state and feed rounds. Feeds publish minutes apart, so fifteen seconds adds no meaningful delay while
 * capping RPC load at four reads a minute. When the RPC is down the last read is served for five more minutes,
 * flagged, with every price capped at `delayed`.
 */
export const ONCHAIN_CACHE: CachePolicy = { ttlSeconds: 15, staleIfErrorSeconds: 5 * 60 };

/** Everything this layer knows about one listed token. */
export interface AssetMarketData {
  readonly asset: ListedAsset;
  readonly token: TokenRead;
  readonly eligibility: Eligibility;
  /** Reference price of an eligible token. `null` for a token that is not eligible. */
  readonly referencePrice: ReferencePrice | null;
}

export interface SourceFreshness {
  /** Time the data was loaded from its source, Unix seconds. */
  readonly fetchedAt: number;
  /** True when the data is past its TTL and is served because the source could not be reached. */
  readonly servedStale: boolean;
  /** Code of the failure behind stale data, "unknown" for an unclassified one, `null` when the data is fresh. */
  readonly failure: MarketDataErrorCode | "unknown" | null;
}

function freshness({ fetchedAt, servedStale, error }: Cached<unknown>): SourceFreshness {
  const failure = error instanceof MarketDataError ? error.code : "unknown";
  return { fetchedAt, servedStale, failure: servedStale ? failure : null };
}

export interface MarketSnapshot {
  /** Clock time the staleness classes were computed for, Unix seconds. */
  readonly observedAt: number;
  readonly assetList: SourceFreshness;
  readonly onchain: SourceFreshness & { readonly blockNumber: bigint; readonly blockTimestamp: number };
  /** Every token of the asset list, keyed by lowercase token address. */
  readonly assets: ReadonlyMap<Address, AssetMarketData>;
}

/** Combines an asset list and an onchain read into the per-token view, for the given clock time. */
export function buildMarketSnapshot(
  assetList: Cached<AssetList>,
  onchain: Cached<OnchainSnapshot>,
  now: number,
): MarketSnapshot {
  const assets = new Map<Address, AssetMarketData>();
  for (const [address, asset] of assetList.value) {
    const token = onchain.value.tokens.get(address) ?? { status: "read_failed" };
    const feed = REFERENCE_FEEDS.get(address);
    const feedRead = onchain.value.feeds.get(address);
    const eligibility = assessEligibility({ asset, token, feed, feedRead });
    const referencePrice =
      eligibility.eligible && feed !== undefined
        ? buildReferencePrice({ feed, read: feedRead, now, servedStale: onchain.servedStale })
        : null;
    assets.set(address, { asset, token, eligibility, referencePrice });
  }
  return {
    observedAt: now,
    assetList: freshness(assetList),
    onchain: {
      ...freshness(onchain),
      blockNumber: onchain.value.blockNumber,
      blockTimestamp: onchain.value.blockTimestamp,
    },
    assets,
  };
}

export interface MarketDataOptions extends AssetListOptions {
  /** Read-only Base mainnet client. Defaults to one built from `BASE_RPC_URL` on first use. */
  readonly client?: MarketClient;
  /** Clock in Unix seconds. */
  readonly now?: () => number;
}

export interface MarketData {
  /**
   * The current view of every listed token.
   *
   * @throws {UpstreamError} if a source is unreachable and nothing young enough is cached.
   * @throws {MalformedResponseError} if the asset list does not have the expected shape.
   * @throws {MissingConfigurationError} if `BASE_RPC_URL` is missing in production or is not Base mainnet.
   */
  getSnapshot(): Promise<MarketSnapshot>;
}

function systemClock(): number {
  return Math.floor(Date.now() / 1000);
}

/** Creates a market data service with its own caches. */
export function createMarketData(options: MarketDataOptions = {}): MarketData {
  const now = options.now ?? systemClock;
  let client = options.client;
  const assetLists: Cache<AssetList> = createCache(ASSET_LIST_CACHE, () => fetchAssetList(options), now);
  // The onchain read is cached together with the asset list it was made for, so the two never disagree on
  // which tokens exist.
  const reads = createCache(
    ONCHAIN_CACHE,
    async () => {
      const assetList = await assetLists.get();
      client ??= createMarketClient();
      const onchain = await readOnchain(client, [...assetList.value.keys()]);
      return { assetList, onchain };
    },
    now,
  );
  return {
    async getSnapshot(): Promise<MarketSnapshot> {
      const read = await reads.get();
      return buildMarketSnapshot(read.value.assetList, { ...read, value: read.value.onchain }, now());
    },
  };
}

let shared: MarketData | undefined;

/** The process-wide market data service. */
export function getMarketData(): MarketData {
  shared ??= createMarketData();
  return shared;
}

/**
 * The usable reference price of a token, or a typed error saying why there is none.
 *
 * @throws {IneligibleTokenError} if the token is not listed or not index-eligible.
 * @throws {MissingFeedError} if the token has no usable reference feed.
 * @throws {StaleFeedError} if the feed has not published within its heartbeat of trading time.
 * @throws {UpstreamError} if the feed could not be read.
 */
export function requireReferencePrice(snapshot: MarketSnapshot, token: Address): UsableReferencePrice {
  const entry = snapshot.assets.get(token);
  if (entry === undefined) throw new IneligibleTokenError(token, ["not_listed"]);
  const { eligibility, referencePrice } = entry;
  if (!eligibility.eligible) {
    if (eligibility.reasons.includes("missing_feed")) throw new MissingFeedError(token, "none is mapped");
    if (eligibility.reasons.includes("feed_mismatch")) throw new MissingFeedError(token, "feed identity mismatch");
    throw new IneligibleTokenError(token, eligibility.reasons);
  }
  if (referencePrice === null) throw new MissingFeedError(token, "none is mapped");
  if (referencePrice.status !== "unavailable") return referencePrice;
  if (referencePrice.reason === "stale_feed" && referencePrice.lastObserved !== null) {
    throw new StaleFeedError(token, referencePrice.lastObserved.updatedAt);
  }
  if (referencePrice.reason === "feed_read_failed")
    throw new UpstreamError("base_rpc", `feed read failed for ${token}`);
  throw new MissingFeedError(token, referencePrice.reason);
}

/**
 * Asserts that transfers of a token are not paused by its issuer.
 *
 * @throws {IneligibleTokenError} if the token is not listed or its state could not be established.
 * @throws {TokenPausedError} if the TRANSFER feature is paused.
 */
export function requireTransferable(snapshot: MarketSnapshot, token: Address): void {
  const entry = snapshot.assets.get(token);
  if (entry === undefined) throw new IneligibleTokenError(token, ["not_listed"]);
  if (entry.token.status !== "ok") throw new IneligibleTokenError(token, [entry.token.status]);
  if (entry.token.state.transfersPaused) throw new TokenPausedError(token);
}

export type { AssetList, ListedAsset } from "./asset-list";
export type { Eligibility, IneligibilityCode } from "./eligibility";
export * from "./errors";
export type { OnchainSnapshot, PendingMultiplier, TokenRead, TokenState } from "./onchain";
export type {
  PricePoint,
  PriceUnavailableReason,
  ReferencePrice,
  UnavailableReferencePrice,
  UsableReferencePrice,
} from "./reference-price";

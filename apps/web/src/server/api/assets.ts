import "server-only";
import { type MarketPhase, marketPhaseAt } from "@equityos/core";
import type { Address } from "viem";
import {
  type AssetMarketData,
  type IneligibilityCode,
  listAssets,
  type MarketData,
  type MarketDataErrorCode,
  type MarketSnapshot,
  ONCHAIN_CACHE,
  type PricePoint,
  type PriceUnavailableReason,
  REFERENCE_FEEDS,
  type ReferencePrice,
  type SourceFreshness,
  type TokenRead,
  type UpstreamSource,
} from "@/server/market";
import { ApiError } from "./errors";
import { isoTimestamp, NO_STORE, ok, publicCache, route } from "./http";
import { booleanParameter, parseAddress, parseQuery } from "./params";

/** One cached dataset behind a response, and how current it is. */
export interface ApiDataset {
  readonly source: UpstreamSource;
  /** Time the dataset was loaded from its source. */
  readonly fetchedAt: string;
  /** Whole seconds between `fetchedAt` and the response. */
  readonly ageSeconds: number;
  /** True when the source could not be reached and the last copy is served past its TTL. */
  readonly servedStale: boolean;
  /** Why the source could not be reached, `null` when the dataset is fresh. */
  readonly failure: MarketDataErrorCode | "unknown" | null;
}

/** The onchain read. Every token state and feed round of a response belongs to this one block. */
export interface ApiOnchainDataset extends ApiDataset {
  readonly blockNumber: string;
  readonly blockTimestamp: string;
}

export interface ApiDatasets {
  readonly assetList: ApiDataset;
  readonly onchain: ApiOnchainDataset;
}

export interface ApiSnapshotMeta {
  /** Clock time the staleness classes were computed for. */
  readonly asOf: string;
  /** Phase of the US equity market at `asOf`. `unknown` outside the covered calendar. */
  readonly marketPhase: MarketPhase | "unknown";
  readonly referencePriceSource: "chainlink";
  readonly datasets: ApiDatasets;
}

interface ApiPricePoint {
  /** USD per whole token, scaled by 1e8, as a decimal string. */
  readonly priceE8: string;
  readonly updatedAt: string;
  readonly roundId: string;
}

/** Token state read from the chain. Every value is `null` unless `status` is `ok`: nothing is defaulted. */
interface ApiTokenState {
  readonly status: TokenRead["status"];
  readonly decimals: number | null;
  /** Minted supply in token base units, as a decimal string. */
  readonly totalSupply: string | null;
  /** Shares of the underlying per token, scaled by 1e18, as a decimal string. */
  readonly multiplierWad: string | null;
  readonly pendingMultiplier: { readonly multiplierWad: string; readonly effectiveAt: string } | null;
  readonly transfersPaused: boolean | null;
}

/**
 * Reference price of a token. It is an indication of value, not a price a trade executes at. `priceE8`,
 * `updatedAt` and `roundId` are `null` exactly when `status` is `unavailable`, and `unavailableReason` says why.
 */
export interface ApiReferencePrice {
  readonly status: "live" | "delayed" | "last_close" | "unavailable";
  readonly priceE8: string | null;
  readonly updatedAt: string | null;
  readonly roundId: string | null;
  readonly unavailableReason: PriceUnavailableReason | "not_eligible" | null;
  /** The round of a feed that missed its heartbeat, for display with its age only. */
  readonly lastObserved: ApiPricePoint | null;
  /** Feed proxy mapped to the token, lowercase. `null` when no feed is mapped. */
  readonly feedProxy: string | null;
}

export interface ApiAsset {
  /** Token address on Base mainnet, lowercase. The identifier of the asset. */
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  /** Decimals as listed by the issuer. `onchain.decimals` is the value the chain reports. */
  readonly decimals: number;
  readonly isin: string | null;
  readonly onchain: ApiTokenState;
  readonly eligibility: { readonly eligible: boolean; readonly reasons: readonly IneligibilityCode[] };
  readonly referencePrice: ApiReferencePrice;
}

function pricePoint({ priceE8, updatedAt, roundId }: PricePoint): ApiPricePoint {
  return { priceE8: priceE8.toString(), updatedAt: isoTimestamp(updatedAt), roundId: roundId.toString() };
}

function tokenState(token: TokenRead): ApiTokenState {
  if (token.status !== "ok") {
    return {
      status: token.status,
      decimals: null,
      totalSupply: null,
      multiplierWad: null,
      pendingMultiplier: null,
      transfersPaused: null,
    };
  }
  const { decimals, totalSupply, multiplierWad, pendingMultiplier, transfersPaused } = token.state;
  return {
    status: "ok",
    decimals,
    totalSupply: totalSupply.toString(),
    multiplierWad: multiplierWad.toString(),
    pendingMultiplier:
      pendingMultiplier === null
        ? null
        : {
            multiplierWad: pendingMultiplier.multiplierWad.toString(),
            effectiveAt: isoTimestamp(pendingMultiplier.effectiveAt),
          },
    transfersPaused,
  };
}

/** The reference price of a token, or the stated absence of one. `price` is `null` for a token that is not eligible. */
export function toApiReferencePrice(token: Address, price: ReferencePrice | null): ApiReferencePrice {
  const feedProxy = REFERENCE_FEEDS.get(token)?.proxy.toLowerCase() ?? null;
  if (price !== null && price.status !== "unavailable") {
    return { status: price.status, ...pricePoint(price), unavailableReason: null, lastObserved: null, feedProxy };
  }
  return {
    status: "unavailable",
    priceE8: null,
    updatedAt: null,
    roundId: null,
    unavailableReason: price === null ? "not_eligible" : price.reason,
    lastObserved: price === null || price.lastObserved === null ? null : pricePoint(price.lastObserved),
    feedProxy,
  };
}

export function toApiAsset(entry: AssetMarketData): ApiAsset {
  const { asset, token, eligibility } = entry;
  return {
    address: asset.address,
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    isin: asset.isin,
    onchain: tokenState(token),
    eligibility: { eligible: eligibility.eligible, reasons: eligibility.eligible ? [] : eligibility.reasons },
    referencePrice: toApiReferencePrice(asset.address, entry.referencePrice),
  };
}

function dataset(source: UpstreamSource, freshness: SourceFreshness, now: number): ApiDataset {
  const { fetchedAt, servedStale, failure } = freshness;
  return {
    source,
    fetchedAt: isoTimestamp(fetchedAt),
    ageSeconds: Math.max(0, now - fetchedAt),
    servedStale,
    failure,
  };
}

export function toApiDatasets({ assetList, onchain, observedAt }: MarketSnapshot): ApiDatasets {
  return {
    assetList: dataset("coinbase_api", assetList, observedAt),
    onchain: {
      ...dataset("base_rpc", onchain, observedAt),
      blockNumber: onchain.blockNumber.toString(),
      blockTimestamp: isoTimestamp(onchain.blockTimestamp),
    },
  };
}

export function snapshotMeta(snapshot: MarketSnapshot): ApiSnapshotMeta {
  return {
    asOf: isoTimestamp(snapshot.observedAt),
    marketPhase: marketPhaseAt(snapshot.observedAt),
    referencePriceSource: "chainlink",
    datasets: toApiDatasets(snapshot),
  };
}

/**
 * Cache lifetime of a response built from a snapshot: what is left of the TTL of the onchain read, the
 * shortest-lived data in it. A snapshot served past its TTL because a source is down is not cacheable.
 */
export function snapshotCache({ assetList, onchain, observedAt }: MarketSnapshot): string {
  if (assetList.servedStale || onchain.servedStale) return NO_STORE;
  return publicCache(ONCHAIN_CACHE.ttlSeconds - (observedAt - onchain.fetchedAt));
}

/** `GET /api/v1/assets`: every listed token, or only the eligible or the ineligible ones. */
export function assetsHandler(marketData: () => MarketData) {
  return route(async (request: Request) => {
    const eligible = booleanParameter(parseQuery(request, ["eligible"]), "eligible");
    const snapshot = await marketData().getSnapshot();
    const data = listAssets(snapshot, eligible).map(toApiAsset);
    const meta = { ...snapshotMeta(snapshot), count: data.length, total: snapshot.assets.size };
    return ok(data, meta, snapshotCache(snapshot));
  });
}

/** `GET /api/v1/assets/{address}`: one listed token. */
export function assetHandler(marketData: () => MarketData) {
  return route(async (request: Request, context: { params: Promise<{ address: string }> }) => {
    parseQuery(request, []);
    const address = parseAddress((await context.params).address);
    const snapshot = await marketData().getSnapshot();
    const entry = snapshot.assets.get(address);
    if (entry === undefined) {
      throw new ApiError(404, "asset_not_found", "No listed asset has this token address.", { address });
    }
    return ok(toApiAsset(entry), snapshotMeta(snapshot), snapshotCache(snapshot));
  });
}

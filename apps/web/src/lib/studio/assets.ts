import { type Address, isAddress } from "@equityos/core";

/** A listed asset as the Studio shows it, read from `GET /api/v1/assets`. */
export interface StudioAsset {
  /** Token address on Base mainnet, lowercase. */
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  /** Only an eligible asset can be a constituent. */
  readonly eligible: boolean;
  /** Why the asset is not eligible, as the codes of the API. Empty when it is. */
  readonly reasons: readonly string[];
  /** Reference feed proxy, lowercase. `null` when no feed is mapped. */
  readonly feed: Address | null;
  /** Reference price in USD per token, scaled by 1e8. `null` when there is no usable one. */
  readonly priceE8: bigint | null;
  readonly priceStatus: "live" | "delayed" | "last_close" | "unavailable";
  /** Publication time of the reference price, Unix seconds. */
  readonly priceUpdatedAt: number | null;
}

export interface StudioAssets {
  readonly assets: readonly StudioAsset[];
  /** Base mainnet block every value was read at. */
  readonly blockNumber: bigint;
  readonly blockTimestamp: number;
  /** True when the source could not be reached and an older read is shown. */
  readonly servedStale: boolean;
}

const INELIGIBILITY_LABELS: Readonly<Record<string, string>> = {
  not_listed: "not listed",
  onchain_read_failed: "token unreadable",
  not_initialized: "not initialized",
  decimals_mismatch: "decimals mismatch",
  not_minted: "not minted",
  missing_feed: "no reference feed",
  feed_mismatch: "reference feed changed",
};

/** Why an asset cannot be selected, in words. */
export function ineligibilityText(reasons: readonly string[]): string {
  const labels = reasons.map((reason) => INELIGIBILITY_LABELS[reason] ?? reason.replaceAll("_", " "));
  return labels.length === 0 ? "not eligible" : labels.join(", ");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : null;
}

function seconds(iso: unknown): number | null {
  const time = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(time) ? null : Math.floor(time / 1000);
}

const PRICE_STATUSES = ["live", "delayed", "last_close", "unavailable"] as const;

function parseAsset(value: unknown): StudioAsset | null {
  const asset = record(value);
  const eligibility = record(asset?.eligibility);
  const price = record(asset?.referencePrice);
  if (asset === null || eligibility === null || price === null) return null;
  const { address, symbol, name } = asset;
  if (typeof address !== "string" || !isAddress(address) || typeof symbol !== "string" || typeof name !== "string") {
    return null;
  }
  const feed = typeof price.feedProxy === "string" && isAddress(price.feedProxy) ? price.feedProxy : null;
  const priceStatus = PRICE_STATUSES.find((status) => status === price.status) ?? "unavailable";
  const priced = priceStatus !== "unavailable" && typeof price.priceE8 === "string" && /^\d+$/.test(price.priceE8);
  const reasons = Array.isArray(eligibility.reasons) ? eligibility.reasons.filter((r) => typeof r === "string") : [];
  return {
    address,
    symbol,
    name,
    // An asset without a feed cannot be priced by a spec, whatever the listing says.
    eligible: eligibility.eligible === true && feed !== null,
    reasons,
    feed,
    priceE8: priced ? BigInt(String(price.priceE8)) : null,
    priceStatus: priced ? priceStatus : "unavailable",
    priceUpdatedAt: seconds(price.updatedAt),
  };
}

/**
 * Reads the body of `GET /api/v1/assets`. Nothing about its shape is assumed: an entry that is not an asset is
 * left out, and a body that is not the expected envelope is `null`, which the Studio shows as a failed load.
 */
export function parseAssetsResponse(body: unknown): StudioAssets | null {
  const envelope = record(body);
  const onchain = record(record(record(envelope?.meta)?.datasets)?.onchain);
  if (envelope === null || !Array.isArray(envelope.data) || onchain === null) return null;
  const blockTimestamp = seconds(onchain.blockTimestamp);
  if (typeof onchain.blockNumber !== "string" || !/^\d+$/.test(onchain.blockNumber) || blockTimestamp === null) {
    return null;
  }
  return {
    assets: envelope.data.flatMap((entry) => parseAsset(entry) ?? []),
    blockNumber: BigInt(onchain.blockNumber),
    blockTimestamp,
    servedStale: onchain.servedStale === true,
  };
}

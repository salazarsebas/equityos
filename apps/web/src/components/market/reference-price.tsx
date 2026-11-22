import { MISSING } from "@/lib/format";
import type { AssetMarketData, IneligibilityCode, PricePoint, ReferencePrice } from "@/server/market";

/** Decimals of a reference price: USD per whole token, scaled by 1e8. */
export const PRICE_DECIMALS = 8;

export const INELIGIBILITY_LABELS: Record<IneligibilityCode, string> = {
  not_listed: "Not listed",
  onchain_read_failed: "Token unreadable",
  not_initialized: "Not initialized",
  decimals_mismatch: "Decimals mismatch",
  not_minted: "Not minted",
  missing_feed: "No feed",
  feed_mismatch: "Feed changed",
};

const STATUS_LABELS: Record<ReferencePrice["status"], string> = {
  live: "Live",
  delayed: "Delayed",
  last_close: "Last close",
  unavailable: "Unavailable",
};

const UNAVAILABLE_LABELS: Record<Extract<ReferencePrice, { status: "unavailable" }>["reason"], string> = {
  feed_read_failed: "feed not readable",
  feed_mismatch: "feed identity changed",
  invalid_round: "invalid round",
  stale_feed: "feed stale",
};

/** The dash rendered in place of a value that does not exist. Never a zero. */
export function Missing() {
  return <span className="text-tertiary">{MISSING}</span>;
}

/** URL of a Base mainnet token on the public block explorer. */
export function tokenExplorerUrl(address: string): string {
  return `https://basescan.org/address/${address}`;
}

/** The round whose publication time is shown: the usable one, or the stale one a feed last published. */
export function shownRound(price: ReferencePrice | null): PricePoint | null {
  if (price === null) return null;
  return price.status === "unavailable" ? price.lastObserved : price;
}

/** Publication time of the oldest round the rows show, Unix seconds, or `null` when no row shows one. */
export function oldestUpdate(rows: readonly Pick<AssetMarketData, "referencePrice">[]): number | null {
  const times = rows.flatMap(({ referencePrice }) => shownRound(referencePrice)?.updatedAt ?? []);
  return times.length === 0 ? null : Math.min(...times);
}

/** The staleness class of a reference price in words. Warning-toned when delayed or unavailable. */
export function PriceStatus({ price }: { price: ReferencePrice }) {
  const label = STATUS_LABELS[price.status];
  if (price.status === "unavailable") {
    return (
      <span className="text-warning">
        {label}: {UNAVAILABLE_LABELS[price.reason]}
      </span>
    );
  }
  return <span className={price.status === "delayed" ? "text-warning" : "text-secondary"}>{label}</span>;
}

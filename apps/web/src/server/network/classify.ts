import "server-only";
import { computeDrift, positionValueUsdE8, type StalenessStatus, valuePortfolio } from "@equityos/core";
import type { Address, Hex } from "viem";
import type { Composition, StoredConstituent } from "../registry";
import { MIN_NOTIONAL_USD_E8, TIER_B_WINDOW_SECONDS, TOLERANCE_MARGIN_BPS, type Tier } from "./definitions";

/** One ERC-20 `Transfer` log, addresses lowercase. */
export interface TokenTransfer {
  readonly token: Address;
  readonly from: Address;
  readonly to: Address;
  /** Token base units. */
  readonly amount: bigint;
}

/** Reference price of a token at one block, with the decimals the token reported at that block. */
export type BlockPrice =
  | {
      readonly status: "ok";
      /** USD per whole token, scaled by 1e8: the feed answer, unchanged. */
      readonly priceE8: bigint;
      readonly decimals: number;
      readonly staleness: Exclude<StalenessStatus, "unavailable">;
    }
  | { readonly status: "unavailable" };

/** The constituent flows of one transaction for one account, valued. */
export type FlowAssessment =
  | { readonly status: "matched" | "below_minimum_notional"; readonly valueUsdE8: bigint }
  | { readonly status: "no_constituent_flows" }
  | { readonly status: "price_unavailable"; readonly token: Address };

export type UnmatchedReason = Exclude<FlowAssessment["status"], "matched">;

/**
 * Values the transfers of the constituents in which `account` is the sender or the recipient, but not both:
 * a transfer to itself moves nothing. Each transfer is valued at its reference price, rounded down, and the
 * values are summed whatever their direction.
 *
 * @param account lowercase
 * @param constituents lowercase token addresses of the attested version
 * @param prices reference prices at the block of the transaction
 */
export function assessFlows(
  transfers: readonly TokenTransfer[],
  account: Address,
  constituents: ReadonlySet<Address>,
  prices: ReadonlyMap<Address, BlockPrice>,
): FlowAssessment {
  const flows = transfers.filter(
    ({ token, from, to }) => constituents.has(token) && (from === account) !== (to === account),
  );
  if (flows.length === 0) return { status: "no_constituent_flows" };
  let valueUsdE8 = 0n;
  for (const { token, amount } of flows) {
    const price = prices.get(token);
    if (price === undefined || price.status !== "ok") return { status: "price_unavailable", token };
    valueUsdE8 += positionValueUsdE8(amount, price.priceE8, price.decimals, "down");
  }
  return { status: valueUsdE8 >= MIN_NOTIONAL_USD_E8 ? "matched" : "below_minimum_notional", valueUsdE8 };
}

/** Where a transaction sits in the chain: block, then position in the block. */
export interface ChainPosition {
  readonly blockNumber: bigint;
  readonly transactionIndex: number;
}

export function isBefore(a: ChainPosition, b: ChainPosition): boolean {
  return a.blockNumber < b.blockNumber || (a.blockNumber === b.blockNumber && a.transactionIndex < b.transactionIndex);
}

/** An earlier transaction of the attesting account that may link to the attestation (tier B). */
export interface LinkCandidate extends ChainPosition {
  readonly hash: Hex;
  /** `from` of the transaction, lowercase. */
  readonly sender: Address;
  readonly blockTimestamp: bigint;
  readonly assessment: FlowAssessment;
}

export interface AttestationContext extends ChainPosition {
  readonly account: Address;
  readonly blockTimestamp: bigint;
}

/**
 * Whether an earlier transaction links to an attestation: it was sent by the attesting account, comes before
 * the attestation, at most `TIER_B_WINDOW_SECONDS` earlier (the edge included), its flows meet the tier A
 * rule, and it has not linked another attestation.
 */
export function isLinkable(
  attestation: AttestationContext,
  candidate: LinkCandidate,
  linked: ReadonlySet<Hex>,
): boolean {
  const elapsed = attestation.blockTimestamp - candidate.blockTimestamp;
  return (
    candidate.sender === attestation.account &&
    isBefore(candidate, attestation) &&
    elapsed >= 0n &&
    elapsed <= TIER_B_WINDOW_SECONDS &&
    candidate.assessment.status === "matched" &&
    !linked.has(candidate.hash)
  );
}

export interface TierResult {
  readonly tier: Tier;
  /** Why the attestation is not tier A, `null` for tier A. */
  readonly reason: UnmatchedReason | null;
  /** Reference value of the flows that qualified it: its own (A) or the linked transaction's (B). */
  readonly valueUsdE8: bigint | null;
  readonly linkedTransaction: Hex | null;
}

/** The tier of an attestation from the assessment of its own transaction and the link found, if any. */
export function tierOf(own: FlowAssessment, link: LinkCandidate | null): TierResult {
  if (own.status === "matched") {
    return { tier: "a", reason: null, valueUsdE8: own.valueUsdE8, linkedTransaction: null };
  }
  const value = link !== null && link.assessment.status === "matched" ? link.assessment.valueUsdE8 : null;
  return {
    tier: link === null ? "unmatched" : "b",
    reason: own.status,
    valueUsdE8: value,
    linkedTransaction: link?.hash ?? null,
  };
}

/** Drift of the holdings of an account from the targets of a version, after its tier A attestation. */
export type Tracking =
  | {
      readonly status: "within" | "outside";
      /** Largest absolute difference between a current and a target weight. */
      readonly maxDriftBps: number;
      /** Drift threshold of the version plus `TOLERANCE_MARGIN_BPS`. */
      readonly toleranceBps: number;
    }
  | { readonly status: "not_assessed"; readonly reason: "not_static" | "not_verified" | "not_valued" };

export interface TrackingInput {
  readonly composition: Composition;
  readonly constituents: readonly StoredConstituent[];
  /** `rebalance.driftThresholdBps` of the verified spec, `null` when the version is not verified. */
  readonly driftThresholdBps: number | null;
  /** Balances of the account at the end of the block, base units. `null` for a failed read. */
  readonly balances: ReadonlyMap<Address, bigint | null>;
  readonly prices: ReadonlyMap<Address, BlockPrice>;
}

/**
 * Compares holdings with the target weights the registry stores. Only a static composition has target weights
 * onchain, and only a verified spec gives a drift threshold. Holdings that cannot all be valued, or that are
 * worth nothing, are not assessed: no zero or default stands in for them.
 */
export function assessTracking(input: TrackingInput): Tracking {
  if (input.composition !== "static") return { status: "not_assessed", reason: "not_static" };
  if (input.driftThresholdBps === null) return { status: "not_assessed", reason: "not_verified" };
  const constituents = [];
  const holdings = [];
  const prices = [];
  for (const { token, weightBps } of input.constituents) {
    const price = input.prices.get(token);
    const balance = input.balances.get(token);
    if (price?.status !== "ok" || balance === undefined || balance === null) {
      return { status: "not_assessed", reason: "not_valued" };
    }
    constituents.push({ token, weightBps, decimals: price.decimals });
    holdings.push({ token, balance, decimals: price.decimals });
    prices.push({ token, priceE8: price.priceE8, status: price.staleness });
  }
  const { positions } = valuePortfolio({ constituents, holdings, prices, quoteBalance: 0n });
  const drift = computeDrift(positions, input.driftThresholdBps);
  if (drift === null) return { status: "not_assessed", reason: "not_valued" };
  const toleranceBps = input.driftThresholdBps + TOLERANCE_MARGIN_BPS;
  return {
    status: drift.maxAbsDriftBps <= toleranceBps ? "within" : "outside",
    maxDriftBps: drift.maxAbsDriftBps,
    toleranceBps,
  };
}

import "server-only";
import type { ListedAsset } from "./asset-list";
import { isExpectedFeed, type ReferenceFeed } from "./feeds";
import type { FeedRead, TokenRead } from "./onchain";

/**
 * Why a token is not index-eligible.
 * - `not_listed`: the address is not in the issuer's asset list.
 * - `onchain_read_failed`: the token state could not be read, so nothing about it is established.
 * - `not_initialized`: the B20 factory does not report an initialized token at the address.
 * - `decimals_mismatch`: the chain and the asset list disagree on the token decimals.
 * - `not_minted`: the total supply is zero.
 * - `missing_feed`: no verified reference feed is mapped to the token.
 * - `feed_mismatch`: the mapped feed proxy does not answer with the decimals and description recorded for it.
 */
export type IneligibilityCode =
  | "not_listed"
  | "onchain_read_failed"
  | "not_initialized"
  | "decimals_mismatch"
  | "not_minted"
  | "missing_feed"
  | "feed_mismatch";

export type Eligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reasons: readonly IneligibilityCode[] };

export interface EligibilityInput {
  /** The token's entry in the asset list, if any. */
  readonly asset: ListedAsset | undefined;
  /** The token's onchain read, if one was made. */
  readonly token: TokenRead | undefined;
  /** The reference feed mapped to the token, if any. */
  readonly feed: ReferenceFeed | undefined;
  /** The read of that feed, if one was made. */
  readonly feedRead: FeedRead | undefined;
}

/**
 * A token is index-eligible when it is in the asset list, is an initialized B20 whose decimals match the list,
 * has a total supply above zero and has a verified reference feed. Every failed condition is reported. The
 * decision fails closed: a token whose state could not be read is not eligible.
 *
 * A failed read of a mapped feed does not make the token ineligible. It makes its reference price unavailable.
 */
export function assessEligibility({ asset, token, feed, feedRead }: EligibilityInput): Eligibility {
  if (asset === undefined) return { eligible: false, reasons: ["not_listed"] };
  const reasons: IneligibilityCode[] = [];
  if (token === undefined || token.status === "read_failed") {
    reasons.push("onchain_read_failed");
  } else if (token.status === "not_initialized") {
    reasons.push("not_initialized");
  } else {
    if (token.state.decimals !== asset.decimals) reasons.push("decimals_mismatch");
    if (token.state.totalSupply <= 0n) reasons.push("not_minted");
  }
  if (feed === undefined) {
    reasons.push("missing_feed");
  } else if (feedRead?.status === "ok" && !isExpectedFeed(feed, feedRead)) {
    reasons.push("feed_mismatch");
  }
  return reasons.length === 0 ? { eligible: true } : { eligible: false, reasons };
}

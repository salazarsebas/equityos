import type { PriceStatus } from "@equityos/core";
import type { CheckId } from "@/server/execution/checks";
import type { Jurisdiction } from "@/server/jurisdiction";
import type { QuoteFailureReason } from "./calldata";
import type { CheckStatus, PlanCheck } from "./response";

/**
 * Every reason code the server reports, per check. Where the server types the reason (the jurisdiction, the
 * reference price status, a quote failure), the union is the server's own type; the others are the literals of
 * `src/server/execution`. `test/execution/check-text.test.ts` reads every reason the server can report and fails
 * when one has no text here.
 */
export interface CheckReasons {
  readonly jurisdiction: Jurisdiction["reason"];
  readonly reference_plan: "ready" | "plan_blocked" | "no_legs" | "too_many_legs";
  readonly reference_freshness: PriceStatus;
  readonly quote: "verified" | QuoteFailureReason;
  readonly price_deviation: "within_band" | "outside_band";
  readonly transfers_not_paused: "not_paused" | "paused" | "read_failed";
  readonly policy_authorized: "authorized" | "not_authorized" | "read_failed";
  readonly multiplier_window: "none_pending" | "pending_outside_window" | "pending_within_window" | "read_failed";
  readonly allowance: "within_plan" | "above_plan" | "read_failed";
  readonly balance: "sufficient" | "insufficient" | "read_failed" | "quote_unavailable";
  readonly simulation:
    | "sequence_simulated"
    | "call_reverted"
    | "sequence_not_supported"
    | "calls_simulated_alone"
    | "quote_unavailable";
  readonly plan_expiry: "current" | "expired" | "deadline_after_expiry";
}

/**
 * The outcome of one reason, in words, with the status the server reports it with. A warning also says what it
 * means for the user, because each one is acknowledged before signing.
 */
export type ReasonText =
  | { readonly status: Exclude<CheckStatus, "warn">; readonly result: string }
  | { readonly status: "warn"; readonly result: string; readonly meaning: string };

interface CheckText<Reason extends string> {
  /** A short name for the check. */
  readonly title: string;
  /** What was checked, as a sentence. */
  readonly checked: string;
  readonly reasons: { readonly [R in Reason]: ReasonText };
}

/**
 * Plain-language text for every check and every reason the server reports. Typed over the server's `CheckId`,
 * so a check added on the server does not compile until it is described here.
 */
export const CHECK_TEXT: { readonly [C in CheckId]: CheckText<CheckReasons[C]> } = {
  jurisdiction: {
    title: "Region",
    checked: "Whether execution is offered in the region this request comes from.",
    reasons: {
      permitted_country: { status: "pass", result: "Execution is offered in this region." },
      restricted_country: { status: "block", result: "Execution is not offered in this region." },
      country_unknown: {
        status: "block",
        result: "The region of this request could not be established, so execution is withheld.",
      },
      development_no_geolocation: {
        status: "warn",
        result: "This server runs in development and could not establish the region of this request.",
        meaning:
          "No regional restriction was applied to this plan. A deployed site withholds execution when it cannot establish the region.",
      },
    },
  },
  reference_plan: {
    title: "Reference plan",
    checked: "Whether the rebalance plan at reference prices has trades that can be quoted.",
    reasons: {
      ready: { status: "pass", result: "The reference plan has trades, within the limit for one plan." },
      plan_blocked: { status: "block", result: "The reference plan itself is blocked, so nothing was quoted." },
      no_legs: { status: "block", result: "The reference plan has no trade to make." },
      too_many_legs: {
        status: "block",
        result: "The reference plan has more trades than one executable plan can hold.",
      },
    },
  },
  reference_freshness: {
    title: "Reference price",
    checked: "How recent the reference price this trade is checked against is.",
    reasons: {
      live: { status: "pass", result: "The reference price is live." },
      delayed: {
        status: "warn",
        result: "The reference price is delayed: it is older than a live price, while the market is open.",
        meaning:
          "The feed publishes a new price when its price moves by 0.5%, so a delayed price is within that move of its source. The price checks of this trade are measured against it.",
      },
      last_close: {
        status: "block",
        result: "The market is closed and the reference price is the last close, so it cannot bound the trade.",
      },
      unavailable: {
        status: "block",
        result: "No reference price is available, so nothing can bound the trade.",
      },
      missing: {
        status: "block",
        result: "The reference price is missing, so nothing can bound the trade.",
      },
    },
  },
  quote: {
    title: "Quote",
    checked: "Whether the aggregator returned a route for this trade and its calldata verifies.",
    reasons: {
      verified: { status: "pass", result: "The aggregator returned a route, and its calldata passed every check." },
      no_route: { status: "block", result: "The aggregator found no route for this trade." },
      provider_rejected: { status: "block", result: "The aggregator refused the request." },
      provider_rate_limited: { status: "block", result: "The aggregator's request limit was reached." },
      provider_unavailable: {
        status: "block",
        result: "The aggregator did not answer, or answered with an error, after one retry.",
      },
      provider_malformed: { status: "block", result: "The aggregator's answer did not have the expected shape." },
      router_not_allowed: {
        status: "block",
        result: "The calldata is addressed to a contract other than the allowed router.",
      },
      unknown_selector: { status: "block", result: "The calldata calls a router function other than swap." },
      executor_not_allowed: {
        status: "block",
        result: "The calldata would hand the tokens to, or call, a contract other than the allowed executor.",
      },
      flags_not_allowed: { status: "block", result: "The calldata sets swap options that are not allowed." },
      executor_data_unrecognized: {
        status: "block",
        result: "The route data does not have the recorded layout, so its recipient and deadline cannot be read.",
      },
      calldata_mismatch: {
        status: "block",
        result:
          "The calldata does not swap exactly what was requested, for this address, with at least the required minimum.",
      },
    },
  },
  price_deviation: {
    title: "Price against the reference",
    checked:
      "Whether the quoted price and the worst price the swap accepts are within the allowed band of the reference.",
    reasons: {
      within_band: { status: "pass", result: "Both prices are within the band." },
      outside_band: { status: "block", result: "A price is outside the band, above or below the reference." },
    },
  },
  transfers_not_paused: {
    title: "Transfers",
    checked: "Whether transfers of the token are paused.",
    reasons: {
      not_paused: { status: "pass", result: "Transfers are not paused." },
      paused: { status: "block", result: "Transfers are paused, so the swap would fail." },
      read_failed: { status: "block", result: "Whether transfers are paused could not be read." },
    },
  },
  policy_authorized: {
    title: "Transfer policy",
    checked: "Whether your address may send and receive the token, and the router may move it for you.",
    reasons: {
      authorized: { status: "pass", result: "Your address and the router are authorized." },
      not_authorized: {
        status: "block",
        result: "The token's policy does not authorize your address or the router for these transfers.",
      },
      read_failed: { status: "block", result: "The token's transfer policy could not be read." },
    },
  },
  multiplier_window: {
    title: "Corporate action",
    checked: "Whether a change to the token's multiplier, as after a split, takes effect within 24 hours.",
    reasons: {
      none_pending: { status: "pass", result: "No multiplier change is pending." },
      pending_outside_window: { status: "pass", result: "A multiplier change is scheduled more than 24 hours out." },
      pending_within_window: { status: "block", result: "A multiplier change takes effect within 24 hours." },
      read_failed: { status: "block", result: "The multiplier schedule could not be read." },
    },
  },
  allowance: {
    title: "Allowance",
    checked: "How much of the token the router may already spend from your address.",
    reasons: {
      within_plan: { status: "pass", result: "The existing allowance is not above what this plan swaps." },
      above_plan: {
        status: "warn",
        result: "Your address already allows the router to spend more of this token than this plan swaps.",
        meaning:
          "This plan does not approve the token again. The router could pull up to the allowed amount if it were ever called with other calldata.",
      },
      read_failed: { status: "block", result: "The allowance could not be read." },
    },
  },
  balance: {
    title: "Balance",
    checked: "Whether your balance covers what the plan spends, counting only the minimum USDC the sells return.",
    reasons: {
      sufficient: { status: "pass", result: "Your balance covers it." },
      insufficient: { status: "block", result: "Your balance does not cover it." },
      read_failed: { status: "block", result: "The balance could not be read." },
      quote_unavailable: { status: "skipped", result: "Not checked, because a trade has no verified quote." },
    },
  },
  simulation: {
    title: "Simulation",
    checked: "Whether the calls succeed in order when simulated at the block that was read.",
    reasons: {
      sequence_simulated: {
        status: "pass",
        result: "Every call succeeded in order, and each swap returned at least its minimum.",
      },
      call_reverted: { status: "block", result: "A call failed, or a swap returned less than its minimum." },
      sequence_not_supported: {
        status: "not_simulated",
        result: "The calls could not be simulated in order, and some could not be simulated at all.",
      },
      calls_simulated_alone: {
        status: "not_simulated",
        result: "The calls could only be simulated one at a time, which says nothing about them in order.",
      },
      quote_unavailable: { status: "skipped", result: "Not simulated, because a trade has no verified quote." },
    },
  },
  plan_expiry: {
    title: "Expiry",
    checked: "Whether the plan is within its lifetime and every route deadline fits it.",
    reasons: {
      current: { status: "pass", result: "The plan has not expired, and every route deadline fits it." },
      expired: { status: "block", result: "The plan had already expired when the server answered." },
      deadline_after_expiry: {
        status: "block",
        result: "A route deadline is later than the plan's expiry allows.",
      },
    },
  },
};

/** The result of a check in a word or two, from the status the server reported. */
export const CHECK_STATUS_TEXT: Readonly<Record<CheckStatus, string>> = {
  pass: "Passed",
  warn: "Warning",
  block: "Blocks the plan",
  not_simulated: "Not simulated",
  skipped: "Not checked",
};

/** A check as the review shows it. `known` is false for a check or reason this page has no text for. */
export interface CheckDescription {
  readonly title: string;
  readonly checked: string;
  readonly result: string;
  /** For a warning: what it means for the user. `null` otherwise. */
  readonly meaning: string | null;
  readonly known: boolean;
}

function isCheckId(check: string): check is CheckId {
  return Object.hasOwn(CHECK_TEXT, check);
}

function reasonText(check: CheckId, reason: string): ReasonText | null {
  const reasons: Readonly<Record<string, ReasonText>> = CHECK_TEXT[check].reasons;
  return Object.hasOwn(reasons, reason) ? (reasons[reason] ?? null) : null;
}

/**
 * The words for a check of the plan. The answer is not trusted, so a check or reason without text is described
 * as unknown rather than guessed at; its code is still shown next to it.
 */
export function describeCheck(check: Pick<PlanCheck, "check" | "status" | "reason">): CheckDescription {
  if (!isCheckId(check.check)) {
    return {
      title: "Unknown check",
      checked: "The server reported a check this page has no description for.",
      result: "Its code and status are shown as the server sent them.",
      meaning: null,
      known: false,
    };
  }
  const { title, checked } = CHECK_TEXT[check.check];
  const text = reasonText(check.check, check.reason);
  if (text === null) {
    return {
      title,
      checked,
      result: "The server reported an outcome this page has no description for. Its code is shown as sent.",
      meaning: null,
      known: false,
    };
  }
  return { title, checked, result: text.result, meaning: text.status === "warn" ? text.meaning : null, known: true };
}

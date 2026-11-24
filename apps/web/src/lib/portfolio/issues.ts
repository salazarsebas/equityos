import type { CalculationIssueCode } from "@equityos/core";
import { formatPercentagePoints, formatUsd } from "@/lib/format";
import type { ApiIssue } from "./api";

const USD_E8_DECIMALS = 8;
const USDC_DECIMALS = 6;

function amount(value: string | null, decimals: number): string {
  return value === null ? "an amount" : `${formatUsd(BigInt(value), decimals)} USD`;
}

function points(bps: number | null): string {
  return bps === null ? "0.00 pp" : formatPercentagePoints(BigInt(bps)).replace("+", "");
}

/**
 * One sentence per finding of `equityos.calc/1`, in plain language. `token` is the display name of the token
 * the finding concerns. Typed as a record of every code, so a code added to `@equityos/core` does not compile
 * until it has a sentence here. The sentences describe arithmetic and data, never a course of action.
 */
export const ISSUE_TEXT: Record<CalculationIssueCode, (issue: ApiIssue, token: string) => string> = {
  missing_price: (_, token) => `No reference price for ${token}: nothing can be valued.`,
  price_unavailable: (_, token) =>
    `Reference price unavailable for ${token}: the totals, weights and drift cannot be computed.`,
  zero_price: (_, token) => `Reference price of zero for ${token}, which no listed token has.`,
  decimals_mismatch: (_, token) => `Decimals differ between the chain and the asset list for ${token}.`,
  zero_deployable_value: () => "There is nothing to compute a plan with: no constituent value and no USDC.",
  below_minimum_portfolio_value: (issue) =>
    `Too little to buy every constituent: from ${amount(issue.minimumDeployableValueUsdE8, USD_E8_DECIMALS)}, each constituent gets a buy of at least the minimum leg value.`,
  market_closed: (_, token) =>
    `Market closed for ${token}: the reference prices are last closes, and executable prices will differ.`,
  price_delayed: (_, token) => `Reference price delayed for ${token}.`,
  projected_drift_increase: (issue) =>
    `After the plan the largest drift would be ${points(issue.projectedMaxAbsDriftBps)}, above the current ${points(issue.currentMaxAbsDriftBps)}.`,
  uninvested_quote: (issue) =>
    `${amount(issue.uninvestedQuote, USDC_DECIMALS)} in USDC stays uninvested, on top of the reserve.`,
  nothing_to_do: () => "Every difference to the target weights is below the minimum leg value: there is no leg.",
};

/** Joins names as prose: `A`, `A and B`, `A, B and C`. */
function joinNames(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The findings as sentences, one per code: the findings of one code about several tokens become one sentence
 * that names them all. Blockers come before warnings, each in the order received.
 */
export function describeIssues(
  issues: readonly ApiIssue[],
  symbolOf: (token: string) => string,
): { readonly code: CalculationIssueCode; readonly severity: ApiIssue["severity"]; readonly text: string }[] {
  const groups = new Map<string, ApiIssue[]>();
  for (const issue of [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "blocker" ? -1 : 1))) {
    const key = `${issue.severity}:${issue.code}`;
    groups.set(key, [...(groups.get(key) ?? []), issue]);
  }
  return [...groups.values()].flatMap((group) => {
    const [first] = group;
    if (first === undefined) return [];
    const tokens = group.flatMap(({ token }) => (token === null ? [] : [symbolOf(token)]));
    const subject = tokens.length === 0 ? "the portfolio" : joinNames(tokens);
    return [{ code: first.code, severity: first.severity, text: ISSUE_TEXT[first.code](first, subject) }];
  });
}

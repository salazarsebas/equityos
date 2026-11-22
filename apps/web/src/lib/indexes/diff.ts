import { computeConstituents, type IndexSpec } from "@equityos/core";
import { formatPercent } from "@/lib/format";
import { formatDuration, formatPoints } from "./methodology";

/** What changed between two verified versions of an index, computed from their specs alone. */
export interface VersionDiff {
  /** Tokens of the later version that the earlier one did not have, in ascending order. */
  readonly added: readonly string[];
  /** Tokens of the earlier version that the later one does not have, in ascending order. */
  readonly removed: readonly string[];
  /** Tokens of both versions whose target weight differs, with both weights in basis points. */
  readonly reweighted: readonly { readonly token: string; readonly fromBps: number; readonly toBps: number }[];
  /** Changes to a rule or to the description of the index, each as one fixed sentence. */
  readonly rules: readonly string[];
}

function percent(bps: number | undefined): string {
  return bps === undefined ? "none" : formatPercent(BigInt(bps));
}

function interval(seconds: number): string {
  return seconds === 0 ? "none" : formatDuration(seconds);
}

function change(what: string, from: string, to: string): string[] {
  return from === to ? [] : [`${what} changed from ${from} to ${to}`];
}

/** Compares the spec of a version with the spec of the version before it. */
export function diffSpecs(previous: IndexSpec, next: IndexSpec): VersionDiff {
  const before = new Map(computeConstituents(previous).map(({ token, weightBps }) => [token, weightBps]));
  const after = new Map(computeConstituents(next).map(({ token, weightBps }) => [token, weightBps]));
  const feedsBefore = new Map(previous.universe.tokens.map((token, i) => [token, previous.pricing.feeds[i]]));
  const feedsChanged = next.universe.tokens.filter(
    (token, i) => feedsBefore.has(token) && feedsBefore.get(token) !== next.pricing.feeds[i],
  ).length;
  return {
    added: [...after.keys()].filter((token) => !before.has(token)),
    removed: [...before.keys()].filter((token) => !after.has(token)),
    reweighted: [...after].flatMap(([token, toBps]) => {
      const fromBps = before.get(token);
      return fromBps === undefined || fromBps === toBps ? [] : [{ token, fromBps, toBps }];
    }),
    rules: [
      ...change("Weighting", previous.weighting.type, next.weighting.type),
      ...change("Maximum weight", percent(previous.constraints?.maxWeightBps), percent(next.constraints?.maxWeightBps)),
      ...change("Minimum weight", percent(previous.constraints?.minWeightBps), percent(next.constraints?.minWeightBps)),
      ...change(
        "Drift threshold",
        formatPoints(previous.rebalance.driftThresholdBps),
        formatPoints(next.rebalance.driftThresholdBps),
      ),
      ...change(
        "Minimum rebalance interval",
        interval(previous.rebalance.minIntervalSeconds),
        interval(next.rebalance.minIntervalSeconds),
      ),
      ...(feedsChanged === 0 ? [] : [`Price feed changed for ${count(feedsChanged, "constituent")}`]),
      ...change("Name", `"${previous.name}"`, `"${next.name}"`),
      ...change("Slug", previous.slug, next.slug),
      ...(previous.description === next.description ? [] : ["Description changed"]),
    ],
  };
}

function count(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? "" : "s"}`;
}

/**
 * A diff as short fixed phrases, composition first: `1 constituent added`, `4 weights changed`, then the rule
 * changes. An empty list means the two specs describe the same methodology.
 */
export function summarizeDiff({ added, removed, reweighted, rules }: VersionDiff): string[] {
  return [
    ...(added.length === 0 ? [] : [`${count(added.length, "constituent")} added`]),
    ...(removed.length === 0 ? [] : [`${count(removed.length, "constituent")} removed`]),
    ...(reweighted.length === 0 ? [] : [`${count(reweighted.length, "weight")} changed`]),
    ...rules,
  ];
}

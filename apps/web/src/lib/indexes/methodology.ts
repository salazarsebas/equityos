import { computeConstituents, type Constituent, type IndexSpec } from "@equityos/core";
import { formatCount, formatFixed, formatPercent } from "@/lib/format";

/**
 * Plain-language reading of a methodology spec. Every sentence is a fixed template filled with fields of the
 * spec: the same spec always produces the same text, and nothing is written by a language model.
 */
export interface MethodologyRule {
  readonly rule: string;
  /** The value as published, formatted. */
  readonly value: string;
  /** What the rule means for a reader. */
  readonly reading: string;
}

const DURATION_UNITS = [
  { singular: "day", plural: "days", seconds: 86_400 },
  { singular: "hour", plural: "hours", seconds: 3_600 },
  { singular: "minute", plural: "minutes", seconds: 60 },
  { singular: "second", plural: "seconds", seconds: 1 },
] as const;

/** A duration in whole units, largest first, at most two of them: `7 days`, `1 day 12 hours`, `90 seconds`. */
export function formatDuration(seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new RangeError(`invalid duration: ${seconds}`);
  const parts: string[] = [];
  let rest = seconds;
  for (const { singular, plural, seconds: size } of DURATION_UNITS) {
    const amount = Math.floor(rest / size);
    rest -= amount * size;
    if (amount > 0 && parts.length < 2)
      parts.push(`${formatCount(BigInt(amount))} ${amount === 1 ? singular : plural}`);
  }
  return parts.length === 0 ? "0 seconds" : parts.join(" ");
}

/** A difference between two weights in percentage points, unsigned: `500` is `5.00 pp`. */
export function formatPoints(bps: number): string {
  return `${formatFixed(BigInt(bps), 2, 2)} pp`;
}

function percent(bps: number): string {
  return formatPercent(BigInt(bps));
}

function plural(count: number, singular: string): string {
  return `${formatCount(BigInt(count))} ${singular}${count === 1 ? "" : "s"}`;
}

/** `Equal weight` or `Fixed weights`. */
export function weightingLabel(spec: IndexSpec): string {
  return spec.weighting.type === "equal" ? "Equal weight" : "Fixed weights";
}

/** The largest target weight among the constituents of a version, in basis points. */
export function largestWeightBps(constituents: readonly Pick<Constituent, "weightBps">[]): number {
  return constituents.reduce((largest, { weightBps }) => Math.max(largest, weightBps), 0);
}

/** The rebalance rule in a few words, for a stat: `5.00 pp drift, 7 days apart`. */
export function rebalanceSummary({ rebalance }: IndexSpec): string {
  const drift = `${formatPoints(rebalance.driftThresholdBps)} drift`;
  return rebalance.minIntervalSeconds === 0 ? drift : `${drift}, ${formatDuration(rebalance.minIntervalSeconds)} apart`;
}

function constraintRules({ constraints, weighting }: IndexSpec): MethodologyRule[] {
  const consequence =
    weighting.type === "equal"
      ? "The equal weights of this version respect it."
      : "The published weights of this version respect it.";
  if (constraints === undefined) {
    return [
      {
        rule: "Weight bounds",
        value: "None",
        reading: "The methodology declares no minimum and no maximum weight for a constituent.",
      },
    ];
  }
  const rules: MethodologyRule[] = [];
  if (constraints.maxWeightBps !== undefined) {
    rules.push({
      rule: "Maximum weight",
      value: percent(constraints.maxWeightBps),
      reading: `No constituent may have a target weight above ${percent(constraints.maxWeightBps)}. ${consequence}`,
    });
  }
  if (constraints.minWeightBps !== undefined) {
    rules.push({
      rule: "Minimum weight",
      value: percent(constraints.minWeightBps),
      reading: `No constituent may have a target weight below ${percent(constraints.minWeightBps)}. ${consequence}`,
    });
  }
  return rules;
}

/**
 * The two rebalance rules, from their values alone: the trigger and the minimum interval. The Studio shows them
 * while the rest of a spec is still being written.
 */
export function rebalanceRules({
  driftThresholdBps,
  minIntervalSeconds,
}: Pick<IndexSpec["rebalance"], "driftThresholdBps" | "minIntervalSeconds">): MethodologyRule[] {
  return [
    {
      rule: "Rebalance trigger",
      value: `Drift of ${formatPoints(driftThresholdBps)}`,
      reading: `A rebalance is due when the weight of a constituent in a replicating wallet is ${formatPoints(driftThresholdBps)} or more away from its target weight.`,
    },
    {
      rule: "Minimum interval",
      value: minIntervalSeconds === 0 ? "None" : formatDuration(minIntervalSeconds),
      reading:
        minIntervalSeconds === 0
          ? "The methodology sets no minimum time between two rebalances."
          : `A rebalance is not due sooner than ${formatDuration(minIntervalSeconds)} after the previous one, whatever the drift.`,
    },
  ];
}

/** The rules of a spec, in a fixed order: universe, weighting, constraints, rebalance, pricing. */
export function describeMethodology(spec: IndexSpec): MethodologyRule[] {
  const count = spec.universe.tokens.length;
  const weights = computeConstituents(spec).map(({ weightBps }) => weightBps);
  const largest = Math.max(...weights);
  const smallest = Math.min(...weights);
  return [
    {
      rule: "Universe",
      value: `Static, ${plural(count, "token")}`,
      reading: `The index holds a fixed list of ${plural(count, "token")}, named by contract address on chain ${spec.chainId}. The list changes only when the creator publishes a new version.`,
    },
    spec.weighting.type === "equal"
      ? {
          rule: "Weighting",
          value: "Equal",
          reading:
            largest === smallest
              ? `Every constituent has the same target weight, ${percent(largest)}.`
              : `Every constituent has the same target weight, rounded to a whole basis point: ${percent(largest)} for the lowest token addresses and ${percent(smallest)} for the others, so that the weights sum to exactly 100.00%.`,
        }
      : {
          rule: "Weighting",
          value: "Fixed",
          reading: `Each constituent has the target weight its creator wrote in the methodology, from ${percent(smallest)} to ${percent(largest)}. Weights are not derived from prices, market value or any other data.`,
        },
    ...constraintRules(spec),
    ...rebalanceRules(spec.rebalance),
    {
      rule: "Pricing source",
      value: "One oracle feed per token",
      reading: `Weights in a wallet are measured with reference prices read from one price feed contract per constituent (source "${spec.pricing.source}"), named by address in the methodology. A reference price is an indication of value, not a price a trade executes at.`,
    },
  ];
}

/** What an index does not do, in fixed sentences. The same for every index of this schema. */
export const METHODOLOGY_LIMITS: readonly string[] = [
  "It does not hold assets. It is a published set of rules, not a fund: anyone replicating it keeps the tokens in their own wallet.",
  "It does not trade or rebalance for anyone. A rebalance being due is a calculation, and acting on it is each holder's decision.",
  "It does not change by itself. Constituents and weights stay as published until the creator publishes a new version, and earlier versions stay readable.",
  "It does not promise a price. Reference prices are not executable, and a wallet that replicates the index will differ from its target weights.",
];

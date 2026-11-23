import type { Constituent, IndexSpec } from "@equityos/core";
import { bpsToPercentText } from "./weights";

/**
 * The methodology of a valid spec in plain sentences, built from fixed templates: the same spec always gives
 * the same text. A local, minimal version for the Studio preview.
 */
const pct = (bps: number) => `${bpsToPercentText(bps)}%`;

/** A duration in the largest unit that divides it: days, hours, else seconds. */
export function durationText(seconds: number): string {
  const unit = (count: number, name: string) => `${count.toLocaleString("en-US")} ${name}${count === 1 ? "" : "s"}`;
  if (seconds % 86_400 === 0) return unit(seconds / 86_400, "day");
  if (seconds % 3_600 === 0) return unit(seconds / 3_600, "hour");
  return unit(seconds, "second");
}

/** The rebalance rule in one sentence. */
export function rebalanceSentence(driftThresholdBps: number, minIntervalSeconds: number): string {
  const interval =
    minIntervalSeconds === 0
      ? "with no minimum time between two rebalances"
      : `and at least ${durationText(minIntervalSeconds)} have passed since the last rebalance`;
  return `A rebalance is due when a constituent is more than ${bpsToPercentText(driftThresholdBps)} percentage points away from its target weight, ${interval}.`;
}

export function methodologyText(spec: IndexSpec, constituents: readonly Constituent[]): string[] {
  const count = constituents.length;
  const weights = constituents.map(({ weightBps }) => weightBps);
  const low = Math.min(...weights);
  const high = Math.max(...weights);
  const range = low === high ? `${pct(low)} each` : `from ${pct(low)} to ${pct(high)}`;
  const stocks = count === 1 ? "1 tokenized stock" : `${count} tokenized stocks`;
  const sentences = [
    spec.weighting.type === "equal"
      ? `Equal weight across ${stocks}: ${range}.`
      : `Fixed weights across ${stocks}: ${range}.`,
  ];
  const { maxWeightBps, minWeightBps } = spec.constraints ?? {};
  if (maxWeightBps !== undefined && minWeightBps !== undefined) {
    sentences.push(`Every weight must stay between ${pct(minWeightBps)} and ${pct(maxWeightBps)}.`);
  } else if (maxWeightBps !== undefined) {
    sentences.push(`No weight may be above ${pct(maxWeightBps)}.`);
  } else if (minWeightBps !== undefined) {
    sentences.push(`No weight may be below ${pct(minWeightBps)}.`);
  }
  sentences.push(rebalanceSentence(spec.rebalance.driftThresholdBps, spec.rebalance.minIntervalSeconds));
  sentences.push("Weights are targets. They are measured with reference prices from one oracle feed per constituent.");
  return sentences;
}

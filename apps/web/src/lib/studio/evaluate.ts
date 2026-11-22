import {
  type Address,
  CALC_ID,
  type Constituent,
  computeConstituents,
  computeEqualWeights,
  type Hex,
  INDEX_SCHEMA_ID,
  type IndexSpec,
  MAX_CONSTITUENTS,
  MAX_SPEC_BYTES,
  PRICE_SOURCE,
  type SpecError,
  specHash,
  TOTAL_WEIGHT_BPS,
  validateSpec,
} from "@equityos/core";
import type { StudioAsset } from "./assets";
import type { Draft } from "./draft";
import { bpsToPercentText, percentTextToBps, sortTokens, sumBps } from "./weights";

/** The part of the editor an issue belongs to. `weight` issues also name the token. */
export type FieldId =
  | "network"
  | "name"
  | "slug"
  | "description"
  | "universe"
  | "weights"
  | "weight"
  | "maxWeight"
  | "minWeight"
  | "driftThreshold"
  | "minInterval"
  | "spec";

/** One violation reported by `validateSpec`, attached to the field that fixes it. */
export interface FieldIssue {
  readonly field: FieldId;
  /** Set for `weight`: the constituent whose weight is wrong. */
  readonly token?: Address;
  readonly code: SpecError["code"];
  /** JSON Pointer of the violation in the spec, as core reported it. */
  readonly path: string;
  readonly message: string;
  /** True when the field is simply not filled in yet, which is shown as a step to do and not as a mistake. */
  readonly incomplete: boolean;
}

/** A draft that is a valid spec: everything that is published or shown as published comes from here. */
export interface ValidDraft {
  readonly spec: IndexSpec;
  /** The canonical bytes. These exact bytes are hashed, shown, exported and sent. */
  readonly specBytes: Uint8Array;
  readonly specHash: Hex;
  readonly constituents: readonly Constituent[];
}

export interface Evaluation {
  /** The JSON value handed to `validateSpec`. */
  readonly candidate: unknown;
  readonly issues: readonly FieldIssue[];
  readonly valid: ValidDraft | null;
  /** Weights to preview while the draft is not valid yet. `null` when they cannot be worked out. */
  readonly previewWeights: readonly Constituent[] | null;
}

const SECONDS: Readonly<Record<Draft["minIntervalUnit"], number>> = { hours: 3_600, days: 86_400 };

/** A percent field as basis points, or the text itself when it is not a percentage, for core to reject. */
function bpsOrText(text: string): number | string {
  return text.trim() === "" ? "" : (percentTextToBps(text) ?? text);
}

function intervalSeconds(draft: Draft): number | string {
  const text = draft.minInterval.trim();
  return /^\d{1,6}$/.test(text) ? Number(text) * SECONDS[draft.minIntervalUnit] : text;
}

/**
 * Builds the document a draft describes. Tokens go in ascending order with their feeds and weights at the same
 * positions. Text that is not a number is passed through as text, so that every rejection comes from core.
 */
export function buildCandidate(draft: Draft, feeds: ReadonlyMap<Address, StudioAsset>): unknown {
  const tokens = sortTokens(draft.tokens);
  const constraints = {
    ...(draft.maxWeight.trim() === "" ? {} : { maxWeightBps: bpsOrText(draft.maxWeight) }),
    ...(draft.minWeight.trim() === "" ? {} : { minWeightBps: bpsOrText(draft.minWeight) }),
  };
  return {
    schema: INDEX_SCHEMA_ID,
    calc: CALC_ID,
    chainId: draft.chainId,
    name: draft.name,
    slug: draft.slug,
    description: draft.description,
    universe: { type: "static", tokens },
    weighting:
      draft.weighting === "equal"
        ? { type: "equal" }
        : { type: "fixed", weightsBps: tokens.map((token) => percentTextToBps(draft.weights[token] ?? "") ?? "") },
    ...(Object.keys(constraints).length === 0 ? {} : { constraints }),
    pricing: { source: PRICE_SOURCE, feeds: tokens.map((token) => feeds.get(token)?.feed ?? "") },
    rebalance: {
      trigger: "drift",
      driftThresholdBps: bpsOrText(draft.driftThreshold),
      minIntervalSeconds: intervalSeconds(draft),
    },
  };
}

function ceilDiv(a: number, b: number): number {
  return Number((BigInt(a) + BigInt(b) - 1n) / BigInt(b));
}

const pct = (bps: number) => `${bpsToPercentText(bps)}%`;
const PERCENT_FORMAT = "Write a percentage with at most two decimals, for example 12.50.";

interface Context {
  readonly draft: Draft;
  readonly tokens: readonly Address[];
  readonly label: (token: Address | undefined) => string;
}

/** Maps one error of core to its field and to a sentence that says what is wrong and how to fix it. */
function describeIssue(error: SpecError, { draft, tokens, label }: Context): FieldIssue {
  const { path, code } = error;
  const count = tokens.length;
  const issue = (field: FieldId, message: string, incomplete = false, token?: Address): FieldIssue => ({
    field,
    code,
    path,
    message,
    incomplete,
    ...(token === undefined ? {} : { token }),
  });
  const position = (prefix: string) =>
    path.startsWith(prefix) ? tokens[Number(path.slice(prefix.length))] : undefined;

  if (path === "/name") {
    return draft.name === ""
      ? issue("name", "Give the index a name.", true)
      : issue("name", "Use 1 to 64 characters: unaccented letters, digits, spaces and common punctuation.");
  }
  if (path === "/slug") {
    return draft.slug === ""
      ? issue("slug", "Give the index a slug.", true)
      : issue("slug", "Use 1 to 32 lowercase letters, digits and hyphens, starting and ending with a letter or digit.");
  }
  if (path === "/description") {
    return issue("description", "The description contains a character that is not valid Unicode text. Retype it.");
  }
  if (path === "/chainId") return issue("network", "Choose the network this index is published on.");
  if (path === "/universe/tokens" && code === "too_few_items") {
    return issue("universe", "Select at least one constituent.", true);
  }
  if (path === "/universe/tokens" && code === "too_many_items") {
    return issue("universe", `${count} constituents are selected. An index holds at most ${MAX_CONSTITUENTS}.`);
  }
  if (path.startsWith("/pricing/feeds/")) {
    const token = position("/pricing/feeds/");
    return issue("universe", `${label(token)} has no reference feed in the current asset list. Remove it.`);
  }
  if (path.startsWith("/weighting/weightsBps/")) {
    const token = position("/weighting/weightsBps/");
    const text = token === undefined ? "" : (draft.weights[token] ?? "").trim();
    const bps = percentTextToBps(text);
    if (code === "weight_above_max" && bps !== null) {
      const message = `${label(token)} is at ${pct(bps)}, above the maximum weight of ${draft.maxWeight.trim()}%.`;
      return issue("weight", message, false, token);
    }
    if (code === "weight_below_min" && bps !== null) {
      const message = `${label(token)} is at ${pct(bps)}, below the minimum weight of ${draft.minWeight.trim()}%.`;
      return issue("weight", message, false, token);
    }
    if (text === "")
      return issue("weight", `${label(token)} has no weight. The smallest weight is 0.01%.`, true, token);
    if (bps === null) return issue("weight", `${label(token)}: ${PERCENT_FORMAT}`, false, token);
    return issue("weight", `${label(token)} must be between 0.01% and 100.00%.`, false, token);
  }
  if (path === "/weighting/weightsBps" && code === "invalid_weight_sum") {
    const sum = sumBps(tokens.map((token) => percentTextToBps(draft.weights[token] ?? "") ?? 0));
    const message =
      sum < TOTAL_WEIGHT_BPS
        ? `Weights add up to ${pct(sum)}. ${pct(TOTAL_WEIGHT_BPS - sum)} is not assigned.`
        : `Weights add up to ${pct(sum)}, ${pct(sum - TOTAL_WEIGHT_BPS)} over 100.00%.`;
    return issue("weights", message);
  }
  if (path === "/constraints/maxWeightBps" || path === "/constraints/minWeightBps") {
    const field = path.endsWith("maxWeightBps") ? "maxWeight" : "minWeight";
    const bps = percentTextToBps(draft[field]);
    if (code === "cap_infeasible" && bps !== null && bps > 0) {
      const fix = `Raise it to at least ${pct(ceilDiv(TOTAL_WEIGHT_BPS, count))} or select at least ${ceilDiv(TOTAL_WEIGHT_BPS, bps)} constituents.`;
      return issue(field, `${count} equal weights cannot all stay at or under ${pct(bps)}. ${fix}`);
    }
    if (code === "floor_infeasible" && bps !== null) {
      const most = Math.floor(TOTAL_WEIGHT_BPS / bps);
      const fix = `Lower it to at most ${pct(Math.floor(TOTAL_WEIGHT_BPS / count))}${most >= 1 ? ` or select at most ${most} constituents` : ""}.`;
      return issue(field, `${count} equal weights cannot all reach ${pct(bps)}. ${fix}`);
    }
    return issue(field, bps === null ? PERCENT_FORMAT : "A weight bound must be between 0.01% and 100.00%.");
  }
  if (path === "/rebalance/driftThresholdBps") {
    if (draft.driftThreshold.trim() === "") return issue("driftThreshold", "Set a drift threshold.", true);
    const known = percentTextToBps(draft.driftThreshold) !== null;
    return issue("driftThreshold", known ? "The drift threshold must be between 0.01 and 100.00." : PERCENT_FORMAT);
  }
  if (path === "/rebalance/minIntervalSeconds") {
    return draft.minInterval.trim() === ""
      ? issue("minInterval", "Set a minimum interval. Use 0 for none.", true)
      : issue("minInterval", "Write the minimum interval as a whole number, 0 or more.");
  }
  if (code === "spec_too_large") {
    return issue(
      "spec",
      `The spec is larger than ${MAX_SPEC_BYTES.toLocaleString("en-US")} bytes. Shorten the description.`,
    );
  }
  return issue("spec", `The spec is not valid at ${path || "the document"}: ${error.message}.`);
}

function previewWeights(draft: Draft, tokens: readonly Address[]): readonly Constituent[] | null {
  if (tokens.length === 0) return [];
  if (draft.weighting === "equal") return tokens.length > MAX_CONSTITUENTS ? null : computeEqualWeights(tokens);
  const weights = tokens.map((token) => ({ token, weightBps: percentTextToBps(draft.weights[token] ?? "") }));
  return weights.every((entry): entry is Constituent => entry.weightBps !== null) ? weights : null;
}

/**
 * Validates a draft with `@equityos/core` and attaches every error to a field. No rule is checked here: the
 * only decisions made in this module are where an error is shown and how it is worded.
 */
export function evaluateDraft(draft: Draft, assets: readonly StudioAsset[]): Evaluation {
  const feeds = new Map(assets.map((asset) => [asset.address, asset]));
  const tokens = sortTokens(draft.tokens);
  const candidate = buildCandidate(draft, feeds);
  const result = validateSpec(candidate);
  if (result.ok) {
    const { spec, specBytes } = result;
    const constituents = computeConstituents(spec);
    const valid = { spec, specBytes, specHash: specHash(specBytes), constituents };
    return { candidate, issues: [], valid, previewWeights: constituents };
  }
  const label = (token: Address | undefined) =>
    token === undefined ? "A constituent" : (feeds.get(token)?.symbol ?? token);
  const context = { draft, tokens, label };
  return {
    candidate,
    issues: result.errors.map((error) => describeIssue(error, context)),
    valid: null,
    previewWeights: previewWeights(draft, tokens),
  };
}

/** The issues of one field, or of one constituent's weight. */
export function issuesFor(issues: readonly FieldIssue[], field: FieldId, token?: Address): readonly FieldIssue[] {
  return issues.filter((issue) => issue.field === field && (token === undefined || issue.token === token));
}

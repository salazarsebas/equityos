import { type Address, computeEqualWeights, type Hex } from "@equityos/core";
import { bpsToPercentText, percentTextToBps, sortTokens } from "./weights";

export type IntervalUnit = "hours" | "days";

/**
 * An index being edited. Numbers are kept as the text the user typed, so that a half-typed value is not lost;
 * `evaluateDraft` turns them into the integers of a spec and `@equityos/core` decides whether they are valid.
 */
export interface Draft {
  /** Chain the spec is written for and published on. Part of the spec, and therefore of its hash. */
  readonly chainId: number;
  readonly name: string;
  readonly slug: string;
  /** False while the slug follows the name. True once the user typed one. */
  readonly slugEdited: boolean;
  /** Always in Unicode Normalization Form C. */
  readonly description: string;
  /** Selected token addresses, lowercase, in the order they were picked. */
  readonly tokens: readonly Address[];
  readonly weighting: "equal" | "fixed";
  /** Fixed weight of each selected token as percent text. Kept when the weighting is equal. */
  readonly weights: Readonly<Record<Address, string>>;
  /** Optional bounds as percent text. Blank means no bound. */
  readonly maxWeight: string;
  readonly minWeight: string;
  /** Drift threshold as percent text, in percentage points. */
  readonly driftThreshold: string;
  readonly minInterval: string;
  readonly minIntervalUnit: IntervalUnit;
  /**
   * Salt of `createIndex`. With the creator address it determines the index id, so it is stored with the
   * draft: publishing the same draft again targets the same id instead of creating a second index.
   */
  readonly salt: Hex;
}

/** A random 32-byte salt from the browser's cryptographic generator. */
export function randomSalt(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** An empty draft with the rebalance rule most indexes start from: 5 percentage points, at most weekly. */
export function newDraft(chainId: number, salt: Hex): Draft {
  return {
    chainId,
    name: "",
    slug: "",
    slugEdited: false,
    description: "",
    tokens: [],
    weighting: "equal",
    weights: {},
    maxWeight: "",
    minWeight: "",
    driftThreshold: "5.00",
    minInterval: "7",
    minIntervalUnit: "days",
    salt,
  };
}

/** The slug a name suggests: lowercase letters and digits joined by single hyphens, at most 32 characters. */
export function suggestSlug(name: string): string {
  const words = name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.join("-").slice(0, 32).replace(/-+$/, "");
}

export function setName(draft: Draft, name: string): Draft {
  return { ...draft, name, slug: draft.slugEdited ? draft.slug : suggestSlug(name) };
}

/** A typed slug stops following the name. Clearing it hands it back to the name. */
export function setSlug(draft: Draft, slug: string): Draft {
  return slug === ""
    ? { ...draft, slug: suggestSlug(draft.name), slugEdited: false }
    : { ...draft, slug, slugEdited: true };
}

/** Descriptions are stored in NFC, the only form a spec accepts, whatever the keyboard produced. */
export function setDescription(draft: Draft, description: string): Draft {
  return { ...draft, description: description.normalize("NFC") };
}

/** Adds or removes a constituent. A removed token loses its fixed weight. */
export function toggleToken(draft: Draft, token: Address): Draft {
  if (!draft.tokens.includes(token)) return { ...draft, tokens: [...draft.tokens, token] };
  const { [token]: _removed, ...weights } = draft.weights;
  return { ...draft, tokens: draft.tokens.filter((other) => other !== token), weights };
}

/** Writes the equal split of `equityos.calc/1` into the fixed weights. */
export function withEqualWeights(draft: Draft): Draft {
  if (draft.tokens.length === 0) return { ...draft, weights: {} };
  const weights: Record<Address, string> = {};
  for (const { token, weightBps } of computeEqualWeights(draft.tokens)) weights[token] = bpsToPercentText(weightBps);
  return { ...draft, weights };
}

/** Switching to fixed weights starts from the equal split when no weight was typed, so the total is 100.00%. */
export function setWeighting(draft: Draft, weighting: Draft["weighting"]): Draft {
  const untouched = draft.tokens.every((token) => (draft.weights[token] ?? "") === "");
  return weighting === "fixed" && untouched ? { ...withEqualWeights(draft), weighting } : { ...draft, weighting };
}

export function setWeight(draft: Draft, token: Address, text: string): Draft {
  return { ...draft, weights: { ...draft.weights, [token]: text } };
}

/** Rewrites a percent field the way it will be read, `12.5` as `12.50`. Text that is not a percentage is kept. */
export function normalizePercentText(text: string): string {
  const bps = percentTextToBps(text);
  return text.trim() === "" || bps === null ? text.trim() : bpsToPercentText(bps);
}

/**
 * Fixed weights of the selected tokens in basis points, in spec order. `null` for a weight that is not a
 * percentage with at most two decimals. A blank weight is 0 bps.
 */
export function draftWeightsBps(draft: Draft): { readonly token: Address; readonly weightBps: number | null }[] {
  return sortTokens(draft.tokens).map((token) => ({ token, weightBps: percentTextToBps(draft.weights[token] ?? "") }));
}

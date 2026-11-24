import { INDEX_SPEC_JSON_SCHEMA } from "@equityos/core";

/** The subset of JSON Schema 2020-12 the published schema of `equityos.index/1` uses. */
interface JsonSchemaNode {
  readonly $ref?: string;
  readonly type?: string;
  readonly const?: string;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly minProperties?: number;
  readonly not?: JsonSchemaNode;
  readonly items?: JsonSchemaNode;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
  readonly oneOf?: readonly JsonSchemaNode[];
}

interface RootSchema extends JsonSchemaNode {
  readonly $comment: string;
  readonly $defs: Readonly<Record<string, JsonSchemaNode>>;
}

// The JSON module is typed by its literal content, which has the shape of `RootSchema`.
const ROOT: RootSchema = INDEX_SPEC_JSON_SCHEMA;

/** One property of the spec, as the reference shows it. */
export interface SpecField {
  /** Dotted path: `universe.tokens`. */
  readonly path: string;
  readonly depth: number;
  /** `string`, `integer`, `address`, `array of address`, or the constant value in quotes. */
  readonly type: string;
  /** Every constraint the schema states, in words or as a pattern. */
  readonly constraints: readonly string[];
  /** `required`, `optional`, or a condition such as `required with fixed, absent with equal`. */
  readonly presence: string;
  readonly meaning: string;
}

/**
 * What each property means, from the methodology spec (`docs/architecture/methodology-spec.md`). The schema states
 * the structure; this states the purpose. `test/developers.test.ts` requires one entry per property of the schema.
 */
export const SPEC_FIELD_MEANINGS: Readonly<Record<string, string>> = {
  schema: "Identifies the document format. A reader rejects any other value as unsupported.",
  calc: "Identifies the weight calculation. A reader computes no weight for any other value.",
  chainId: "EIP-155 chain id of the tokens and feeds. Verification fails for a spec read from another chain.",
  name: "Display name, printable ASCII.",
  slug: "Name in links: lowercase letters, digits and inner hyphens, at most 32 characters.",
  description: "Any Unicode text in Normalization Form C. It may be empty.",
  universe: "The constituents.",
  "universe.type": "A fixed list of tokens: the only universe of this version of the format.",
  "universe.tokens": "Token addresses in strictly ascending order, so a set of tokens has one spelling.",
  weighting: "How the weights are set.",
  "weighting.type":
    "equal: every token gets floor(10000 / n) bps and the lowest addresses one more until the sum is 10000. fixed: the weights listed.",
  "weighting.weightsBps": "One weight per token, in the order of the tokens, summing to exactly 10000.",
  constraints: "Bounds every weight must satisfy. They make a spec invalid when broken and never change a weight.",
  "constraints.maxWeightBps": "No weight may be above it.",
  "constraints.minWeightBps": "No weight may be below it.",
  pricing: "Where the reference prices of the constituents are read.",
  "pricing.source": "Price feeds with the AggregatorV3 interface.",
  "pricing.feeds": "One feed per token: feeds[i] prices tokens[i].",
  rebalance: "When a portfolio that replicates the index is due for a rebalance.",
  "rebalance.trigger": "Drift from the target weights: the only trigger of this version of the format.",
  "rebalance.driftThresholdBps": "Largest drift of any weight, in basis points, at which a rebalance is due.",
  "rebalance.minIntervalSeconds": "Shortest time between two rebalances, in seconds.",
  parent: "The published version this spec was derived from.",
  "parent.chainId": "Chain of the parent version.",
  "parent.registry": "Registry that stores the parent version.",
  "parent.indexId": "Index id of the parent.",
  "parent.version": "Version number of the parent.",
  "parent.specHash": "Spec hash of the parent version.",
};

const DEF_NAMES: Readonly<Record<string, string>> = {
  address: "address",
  bytes32: "bytes32",
  bps: "integer",
  positiveInteger: "integer",
};

function resolve(node: JsonSchemaNode): { readonly node: JsonSchemaNode; readonly name: string | null } {
  if (node.$ref === undefined) return { node, name: null };
  const def = node.$ref.replace("#/$defs/", "");
  const target = ROOT.$defs[def];
  if (target === undefined) throw new Error(`unresolved ${node.$ref}`);
  return { node: target, name: DEF_NAMES[def] ?? def };
}

function typeAndConstraints(input: JsonSchemaNode): { readonly type: string; readonly constraints: string[] } {
  const { node, name } = resolve(input);
  const constraints: string[] = [];
  if (node.pattern !== undefined) constraints.push(node.pattern);
  if (node.minimum !== undefined && node.maximum !== undefined) {
    constraints.push(`${node.minimum} to ${node.maximum === Number.MAX_SAFE_INTEGER ? "2^53 - 1" : node.maximum}`);
  }
  if (node.const !== undefined) return { type: JSON.stringify(node.const), constraints };
  if (node.type === "array" && node.items !== undefined) {
    const items = typeAndConstraints(node.items);
    if (node.minItems !== undefined && node.maxItems !== undefined) {
      constraints.push(`${node.minItems} to ${node.maxItems} items`);
    }
    if (node.uniqueItems === true) constraints.push("no duplicates");
    if (node.items.not?.const !== undefined) constraints.push(`never ${node.items.not.const}`);
    return { type: `array of ${items.type}`, constraints: [...constraints, ...items.constraints] };
  }
  if (node.minProperties !== undefined) constraints.push(`at least ${node.minProperties} property`);
  return { type: name ?? node.type ?? "object", constraints };
}

interface Property {
  readonly name: string;
  readonly node: JsonSchemaNode;
  readonly presence: string;
  /** The constants of a property whose value selects a variant, such as `weighting.type`. */
  readonly variants: readonly string[] | null;
}

/** The properties of an object node, merging the variants of a `oneOf` (the two kinds of weighting). */
function properties(node: JsonSchemaNode): readonly Property[] {
  if (node.oneOf === undefined) {
    const required = new Set(node.required ?? []);
    return Object.entries(node.properties ?? {}).map(([name, child]) => ({
      name,
      node: child,
      presence: required.has(name) ? "required" : "optional",
      variants: null,
    }));
  }
  const variants = node.oneOf.map((variant) => variant.properties?.type?.const ?? "");
  const merged = new Map<string, { node: JsonSchemaNode; consts: string[]; requiredIn: string[] }>();
  for (const [i, variant] of node.oneOf.entries()) {
    for (const [name, child] of Object.entries(variant.properties ?? {})) {
      const entry = merged.get(name) ?? { node: child, consts: [], requiredIn: [] };
      if (child.const !== undefined) entry.consts.push(child.const);
      if (variant.required?.includes(name)) entry.requiredIn.push(variants[i] ?? "");
      merged.set(name, entry);
    }
  }
  return [...merged].map(([name, { node: child, consts, requiredIn }]) => {
    const absentIn = variants.filter((variant) => !requiredIn.includes(variant));
    return {
      name,
      node: child,
      presence:
        absentIn.length === 0
          ? "required"
          : `required with ${requiredIn.join(", ")}, absent with ${absentIn.join(", ")}`,
      variants: consts.length > 1 ? consts : null,
    };
  });
}

function walk(node: JsonSchemaNode, prefix: string, depth: number): SpecField[] {
  const fields: SpecField[] = [];
  for (const { name, node: child, presence, variants } of properties(node)) {
    const path = `${prefix}${name}`;
    const described =
      variants === null
        ? typeAndConstraints(child)
        : { type: variants.map((value) => JSON.stringify(value)).join(" or "), constraints: [] };
    fields.push({ path, depth, ...described, presence, meaning: SPEC_FIELD_MEANINGS[path] ?? "" });
    const resolved = resolve(child).node;
    if (resolved.properties !== undefined || resolved.oneOf !== undefined) {
      fields.push(...walk(resolved, `${path}.`, depth + 1));
    }
  }
  return fields;
}

/** Every property of the spec in the order of the schema, with its type, constraints, presence and meaning. */
export function specFields(): readonly SpecField[] {
  return walk(ROOT, "", 0);
}

/** The rules a JSON Schema cannot express, as the schema lists them in its `$comment`. */
export function rulesBeyondSchema(): readonly string[] {
  return [...ROOT.$comment.matchAll(/\((\d+)\) ([^;]+?)(?:;|\.$)/g)].map(([, , rule]) => `${rule ?? ""}.`);
}

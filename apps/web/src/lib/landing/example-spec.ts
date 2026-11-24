import { computeConstituents, type Hex, specHash, validateSpec } from "@equityos/core";
import vectors from "@equityos/core/vectors/specs-valid.json";

/** The test vector shown on the landing page. Three tokens, so the equal split leaves one basis point over. */
export const EXAMPLE_VECTOR_NAME = "equal-3";

export interface ExampleSpec {
  readonly vectorName: string;
  /** The canonical spec text: the exact bytes a registry would store, decoded as UTF-8. */
  readonly canonicalText: string;
  readonly byteLength: number;
  readonly specHash: Hex;
  /** Weights computed by `equityos.calc/1`, in the order of the tokens of the spec. */
  readonly weightsBps: readonly bigint[];
}

/**
 * Builds the example document from a test vector of `@equityos/core`, with the functions of core rather than
 * the values written in the vector: the spec is validated and canonicalized, the bytes are hashed and the
 * weights are calculated. The result must equal what the vector records, or this throws.
 */
export function buildExampleSpec(name: string = EXAMPLE_VECTOR_NAME): ExampleSpec {
  const vector = vectors.vectors.find((candidate) => candidate.name === name);
  if (vector === undefined) throw new Error(`no valid spec vector named ${name}`);
  const result = validateSpec(vector.spec);
  if (!result.ok) throw new Error(`vector ${name} does not validate`);
  const hash = specHash(result.specBytes);
  if (hash !== vector.specHash) {
    throw new Error(`vector ${name}: computed hash ${hash} differs from ${vector.specHash}`);
  }
  const constituents = computeConstituents(result.spec);
  const recorded = vector.constituents.map(({ weightBps }) => weightBps).join(",");
  if (constituents.map(({ weightBps }) => weightBps).join(",") !== recorded) {
    throw new Error(`vector ${name}: computed weights differ from the recorded ones`);
  }
  return {
    vectorName: name,
    canonicalText: new TextDecoder("utf-8", { fatal: true }).decode(result.specBytes),
    byteLength: result.specBytes.length,
    specHash: hash,
    weightsBps: constituents.map(({ weightBps }) => BigInt(weightBps)),
  };
}

import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import referenceCanonicalize from "canonicalize";
import {
  canonicalize,
  computeConstituents,
  INDEX_SPEC_JSON_SCHEMA,
  parseCanonical,
  specHash,
  validateSpec,
  verifyVersion,
} from "../src/index.ts";
import canonicalBytes from "../vectors/canonical-bytes.json" with { type: "json" };
import invalidSpecs from "../vectors/specs-invalid.json" with { type: "json" };
import validSpecs from "../vectors/specs-valid.json" with { type: "json" };
import { hexToBytes, utf8 } from "./helpers.ts";

const matchesJsonSchema = new Ajv2020({ allErrors: true, strict: true }).compile(INDEX_SPEC_JSON_SCHEMA);

function isAscii(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text);
}

describe("published vectors: valid specs", () => {
  test("there are at least 12, with unique names", () => {
    expect(validSpecs.vectors.length).toBeGreaterThanOrEqual(12);
    expect(new Set(validSpecs.vectors.map(({ name }) => name)).size).toBe(validSpecs.vectors.length);
  });

  test("one has a non-ASCII description in NFC", () => {
    const descriptions = validSpecs.vectors.map(({ spec }) => spec.description);
    expect(descriptions.some((text) => !isAscii(text) && text.normalize("NFC") === text)).toBe(true);
  });

  for (const vector of validSpecs.vectors) {
    test(`${vector.name}: bytes, hash and constituents`, () => {
      const validation = validateSpec(vector.spec);
      if (!validation.ok) throw new Error(JSON.stringify(validation.errors));
      const bytes = hexToBytes(vector.canonicalHex);
      expect(validation.specBytes).toEqual(bytes);
      expect(canonicalize(vector.spec)).toEqual(bytes);
      expect<string>(specHash(bytes)).toBe(vector.specHash);
      expect<unknown>(computeConstituents(validation.spec)).toEqual(vector.constituents);
      expect(vector.constituents.reduce((total, { weightBps }) => total + weightBps, 0)).toBe(10_000);
    });

    test(`${vector.name}: the canonical bytes parse back and verify`, () => {
      const bytes = hexToBytes(vector.canonicalHex);
      const parsed = parseCanonical(bytes);
      if (!parsed.ok) throw new Error(parsed.message);
      expect(parsed.value).toEqual(vector.spec);
      const report = verifyVersion({
        specBytes: bytes,
        specHash: vector.specHash,
        constituents: vector.constituents,
        chainId: vector.spec.chainId,
      });
      expect(report.checks.map(({ status }) => status)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
      expect(report.conformant).toBe(true);
    });

    test(`${vector.name}: an independent RFC 8785 implementation produces the same bytes`, () => {
      const reference = referenceCanonicalize(vector.spec);
      if (reference === undefined) throw new Error("the reference produced no output");
      expect(utf8(reference)).toEqual(hexToBytes(vector.canonicalHex));
    });
  }
});

describe("published vectors: invalid specs", () => {
  test("names are unique and one has a description that is not NFC", () => {
    expect(new Set(invalidSpecs.vectors.map(({ name }) => name)).size).toBe(invalidSpecs.vectors.length);
    const notNfc = invalidSpecs.vectors.filter(({ error }) => error.code === "not_nfc");
    expect(notNfc.length).toBeGreaterThanOrEqual(1);
  });

  for (const vector of invalidSpecs.vectors) {
    test(`${vector.name}: ${vector.error.code}`, () => {
      const validation = validateSpec(vector.spec);
      if (validation.ok) throw new Error("expected the spec to be invalid");
      expect<unknown>(validation.errors.map(({ path, code }) => ({ path, code }))).toEqual([vector.error]);
    });
  }
});

describe("the JSON Schema and validateSpec agree on the vectors", () => {
  test("the schema compiles in strict mode and names the schema it describes", () => {
    expect(INDEX_SPEC_JSON_SCHEMA.title).toBe("equityos.index/1");
    expect(INDEX_SPEC_JSON_SCHEMA.properties.schema.const).toBe("equityos.index/1");
  });

  for (const vector of validSpecs.vectors) {
    test(`${vector.name}: both accept`, () => {
      expect(matchesJsonSchema(vector.spec)).toBe(true);
      expect(validateSpec(vector.spec).ok).toBe(true);
    });
  }

  // The schema states the structure. The rules it cannot express are listed in its $comment, and the
  // vectors that break only one of those are marked `"jsonSchema": "accepts"`.
  for (const vector of invalidSpecs.vectors) {
    test(`${vector.name}: validateSpec rejects, the schema ${vector.jsonSchema}`, () => {
      expect(validateSpec(vector.spec).ok).toBe(false);
      expect(matchesJsonSchema(vector.spec)).toBe(vector.jsonSchema === "accepts");
    });
  }

  test("the schema is never stricter than validateSpec, and is weaker only on the documented rules", () => {
    const beyondSchema = invalidSpecs.vectors.filter(({ jsonSchema }) => jsonSchema === "accepts");
    expect([...new Set(beyondSchema.map(({ error }) => error.code))].sort()).toEqual([
      "cap_infeasible",
      "floor_infeasible",
      "invalid_weight_sum",
      "length_mismatch",
      "not_nfc",
      "spec_too_large",
      "tokens_not_strictly_ascending",
      "weight_above_max",
      "weight_below_min",
    ]);
  });
});

describe("published vectors: canonical bytes", () => {
  for (const vector of canonicalBytes.valid) {
    test(`${vector.name}: canonical form of the input`, () => {
      const bytes = hexToBytes(vector.canonicalHex);
      expect(utf8(vector.canonical)).toEqual(bytes);
      expect(canonicalize(JSON.parse(vector.json))).toEqual(bytes);
      expect(parseCanonical(bytes).ok).toBe(true);
      const reference = referenceCanonicalize(JSON.parse(vector.json));
      if (reference === undefined) throw new Error("the reference produced no output");
      expect(utf8(reference)).toEqual(bytes);
    });
  }

  for (const vector of canonicalBytes.invalid) {
    test(`${vector.name}: ${vector.code}`, () => {
      const result = parseCanonical(hexToBytes(vector.hex));
      if (result.ok) throw new Error("expected the bytes to be rejected");
      expect<string>(result.code).toBe(vector.code);
    });
  }
});

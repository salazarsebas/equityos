import { describe, expect, test } from "bun:test";
import {
  bytesToHex,
  canonicalize,
  computeConstituents,
  INDEX_SPEC_JSON_SCHEMA,
  parseCanonical,
  specHash,
  validateSpec,
  verifyVersion,
} from "@equityos/core";
import vectors from "../../core/vectors/specs-valid.json" with { type: "json" };
import * as sdk from "../src/index.ts";

describe("one entry for the methodology functions", () => {
  test("the core functions a consumer needs are the ones of @equityos/core", () => {
    expect(sdk.canonicalize).toBe(canonicalize);
    expect(sdk.specHash).toBe(specHash);
    expect(sdk.validateSpec).toBe(validateSpec);
    expect(sdk.computeConstituents).toBe(computeConstituents);
    expect(sdk.verifyVersion).toBe(verifyVersion);
    expect(sdk.parseCanonical).toBe(parseCanonical);
    expect(sdk.bytesToHex).toBe(bytesToHex);
    expect(sdk.INDEX_SPEC_JSON_SCHEMA).toBe(INDEX_SPEC_JSON_SCHEMA);
  });

  for (const vector of vectors.vectors) {
    test(`reproduces the canonical bytes, hash and weights of ${vector.name}`, () => {
      const validation = sdk.validateSpec(vector.spec);
      if (!validation.ok) throw new Error(JSON.stringify(validation.errors));
      const bytes = sdk.canonicalize(validation.spec);
      expect<string>(sdk.bytesToHex(bytes)).toBe(vector.canonicalHex);
      expect<string>(sdk.specHash(bytes)).toBe(vector.specHash);
      expect<readonly { token: string; weightBps: number }[]>(sdk.computeConstituents(validation.spec)).toEqual(
        vector.constituents,
      );
    });
  }
});

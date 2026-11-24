import { describe, expect, test } from "bun:test";
import { INDEX_SPEC_JSON_SCHEMA } from "@equityos/core";
import { ERROR_CODES } from "../src/lib/developers/error-codes";
import { apiExample, examplesOf } from "../src/lib/developers/examples";
import { describeType, fieldRows, operationsByTag } from "../src/lib/developers/openapi-view";
import { rulesBeyondSchema, SPEC_FIELD_MEANINGS, specFields } from "../src/lib/developers/spec-fields";
import { API_ERROR_CODES } from "../src/server/api/errors";
import { openApiDocument } from "../src/server/api/openapi";

describe("spec reference", () => {
  test("every property of the published JSON Schema has a meaning, and no other path has one", () => {
    const paths = specFields().map(({ path }) => path);
    expect([...paths].sort()).toEqual(Object.keys(SPEC_FIELD_MEANINGS).sort());
    expect(specFields().every(({ meaning }) => meaning.length > 0)).toBe(true);
  });

  test("the merged weighting variants state when weightsBps is present", () => {
    const weights = specFields().find(({ path }) => path === "weighting.weightsBps");
    expect(weights?.presence).toBe("required with fixed, absent with equal");
    expect(specFields().find(({ path }) => path === "weighting.type")?.type).toBe('"equal" or "fixed"');
  });

  test("the rules beyond the schema are the numbered rules of its $comment", () => {
    const numbered = INDEX_SPEC_JSON_SCHEMA.$comment.match(/\(\d+\)/g) ?? [];
    expect(rulesBeyondSchema()).toHaveLength(numbered.length);
    expect(rulesBeyondSchema()[0]).toBe("universe.tokens is strictly ascending.");
  });
});

describe("API reference", () => {
  test("every operation is listed once under a tag", () => {
    const listed = operationsByTag(openApiDocument).flatMap(({ operations }) =>
      operations.map(({ operation }) => operation.operationId),
    );
    const documented = Object.values(openApiDocument.paths).flatMap((item) =>
      Object.values(item).map((operation) => operation.operationId),
    );
    expect([...listed].sort()).toEqual([...documented].sort());
  });

  test("types read as the API states them", () => {
    expect(describeType({ $ref: "#/components/schemas/UintString" })).toEqual({ kind: "uint" });
    expect(describeType({ anyOf: [{ $ref: "#/components/schemas/Asset" }, { type: "null" }] })).toEqual({
      kind: "nullable",
      inner: { kind: "ref", name: "Asset" },
    });
    expect(describeType({ type: "integer", minimum: 0, maximum: 10_000 })).toEqual({
      kind: "scalar",
      name: "integer",
      detail: "0 to 10000",
    });
  });

  test("objects written in place are expanded under their field", () => {
    const portfolio = openApiDocument.components.schemas.Portfolio;
    if (portfolio === undefined) throw new Error("no Portfolio schema");
    const rows = fieldRows(portfolio);
    expect(rows.find(({ path }) => path === "totals.investedValueUsdE8")).toMatchObject({
      depth: 1,
      type: { kind: "nullable", inner: { kind: "uint" } },
    });
    expect(rows.find(({ path }) => path === "constituents")?.type).toEqual({
      kind: "array",
      items: { kind: "ref", name: "PortfolioPosition" },
    });
  });

  test("every error code has a status and a meaning", () => {
    expect(Object.keys(ERROR_CODES).sort()).toEqual([...API_ERROR_CODES].sort());
  });

  test("the overview and the reference find the recorded examples they show", () => {
    for (const name of ["listIndexes", "getIndexComposition", "getPortfolioPlan", "listIndexes.registryNotDeployed"]) {
      expect(apiExample(name).path.startsWith("/api/v1/")).toBe(true);
    }
    expect(examplesOf("getIndexVersion").map(({ status }) => status)).toEqual([200, 200]);
    expect(() => apiExample("missing")).toThrow();
  });
});

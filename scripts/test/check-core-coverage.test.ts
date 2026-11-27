import { describe, expect, test } from "bun:test";
import {
  checkCoreCoverage,
  type FileCoverage,
  formatCoreCoverage,
  parseArguments,
  parseCoverageMap,
  relativeSource,
} from "../check-core-coverage.ts";

/** A coverage map entry with the given statement and branch hit counts. */
function entry(statements: number[], branches: number[][]) {
  return {
    s: Object.fromEntries(statements.map((hits, i) => [String(i), hits])),
    b: Object.fromEntries(branches.map((arms, i) => [String(i), arms])),
    statementMap: {},
    branchMap: {},
  };
}

const MAP = {
  "C:\\repo\\packages\\core\\src\\b.ts": entry(
    [1, 0, 3],
    [
      [1, 0],
      [2, 2, 0],
    ],
  ),
  "/home/runner/work/equityos/packages/core/src/a.ts": entry([5], []),
};

describe("relativeSource", () => {
  test("keeps the path from src/ on, with forward slashes", () => {
    expect(relativeSource("C:\\repo\\packages\\core\\src\\b.ts")).toBe("src/b.ts");
    expect(relativeSource("/w/packages/core/src/a.ts")).toBe("src/a.ts");
    expect(relativeSource("src/a.ts")).toBe("src/a.ts");
  });
});

describe("parseCoverageMap", () => {
  test("counts covered statements and branch arms per file, in file order", () => {
    expect(parseCoverageMap(MAP)).toEqual([
      { file: "src/a.ts", statements: { covered: 1, total: 1 }, branches: { covered: 0, total: 0 } },
      { file: "src/b.ts", statements: { covered: 2, total: 3 }, branches: { covered: 3, total: 5 } },
    ]);
  });

  test("rejects a malformed map", () => {
    expect(() => parseCoverageMap([])).toThrow("missing coverage map");
    expect(() => parseCoverageMap({ "src/a.ts": { s: {} } })).toThrow("missing branches of src/a.ts");
    expect(() => parseCoverageMap({ "src/a.ts": { s: { 0: -1 }, b: {} } })).toThrow("invalid statement count");
    expect(() => parseCoverageMap({ "src/a.ts": { s: {}, b: { 0: 1 } } })).toThrow("invalid branch counts");
  });
});

describe("checkCoreCoverage", () => {
  const full: FileCoverage = {
    file: "src/a.ts",
    statements: { covered: 99, total: 100 },
    branches: { covered: 19, total: 20 },
  };

  test("passes at the floor over all files together", () => {
    const small: FileCoverage = {
      file: "src/b.ts",
      statements: { covered: 1, total: 1 },
      branches: { covered: 0, total: 0 },
    };
    const check = checkCoreCoverage([full, small], ["src/a.ts", "src/b.ts"], 95);
    expect(check.statementsPercent).toBeCloseTo((100 / 101) * 100);
    expect(check.branchesPercent).toBe(95);
    expect(check.ok).toBe(true);
    expect(formatCoreCoverage(check, 95)).toContain(
      "ok   packages/core/src: statements 99.01% (100/101), branches 95.00% (19/20)",
    );
  });

  test("fails below the floor on statements or on branches", () => {
    expect(checkCoreCoverage([full], ["src/a.ts"], 99.5).ok).toBe(false);
    const branches: FileCoverage = {
      ...full,
      statements: { covered: 100, total: 100 },
      branches: { covered: 18, total: 20 },
    };
    expect(checkCoreCoverage([branches], ["src/a.ts"], 95).ok).toBe(false);
  });

  test("fails when a source file was not loaded by any test, or when nothing was measured", () => {
    const check = checkCoreCoverage([full], ["src/a.ts", "src/unused.ts"], 95);
    expect(check.missing).toEqual(["src/unused.ts"]);
    expect(check.ok).toBe(false);
    expect(formatCoreCoverage(check, 95)).toContain("FAIL src/unused.ts: not loaded by any test");
    expect(checkCoreCoverage([], [], 95).ok).toBe(false);
  });
});

describe("parseArguments", () => {
  test("reads the map, the source directory and an optional floor", () => {
    expect(parseArguments(["c.json", "packages/core/src"])).toEqual({
      path: "c.json",
      sourceDir: "packages/core/src",
      minPercent: 95,
    });
    expect(parseArguments(["c.json", "src", "--min", "90"]).minPercent).toBe(90);
  });

  test("rejects missing, invalid and unknown arguments", () => {
    expect(() => parseArguments(["c.json"])).toThrow("usage");
    expect(() => parseArguments(["c.json", "src", "--min", "0"])).toThrow("invalid --min");
    expect(() => parseArguments(["c.json", "src", "--other"])).toThrow("unknown argument");
  });
});

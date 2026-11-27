import { describe, expect, test } from "bun:test";
import {
  type BaselineEntry,
  compare,
  type Finding,
  formatComparison,
  normalizePath,
  parseAderyn,
  parseArguments,
  parseBaseline,
  parseSlither,
  passes,
} from "../check-static-analysis.ts";

const SLITHER = {
  success: true,
  error: null,
  results: {
    detectors: [
      {
        check: "timestamp",
        impact: "Low",
        confidence: "Medium",
        elements: [
          {
            type: "function",
            name: "exists",
            source_mapping: { filename_relative: "src/IndexRegistry.sol" },
            type_specific_fields: { parent: { type: "contract", name: "IndexRegistry" } },
          },
        ],
      },
      {
        check: "naming-convention",
        impact: "Informational",
        confidence: "High",
        elements: [
          {
            type: "variable",
            name: "REGISTRY",
            source_mapping: { filename_relative: "src\\RebalanceLog.sol" },
            type_specific_fields: { parent: { type: "contract", name: "RebalanceLog" } },
          },
        ],
      },
    ],
  },
};

const ADERYN = {
  high_issues: { issues: [] },
  low_issues: {
    issues: [
      {
        title: "Unspecific Solidity Pragma",
        detector_name: "unspecific-solidity-pragma",
        instances: [
          { contract_path: "src/A.sol", line_no: 2 },
          { contract_path: "src/A.sol", line_no: 9 },
          { contract_path: "src/B.sol", line_no: 2 },
        ],
      },
    ],
  },
};

const TIMESTAMP: Finding = {
  tool: "slither",
  detector: "timestamp",
  severity: "Low",
  location: "src/IndexRegistry.sol:IndexRegistry.exists",
};

function entry(finding: Finding, verdict: BaselineEntry["verdict"] = "false-positive"): BaselineEntry {
  return { ...finding, verdict, reason: "reviewed" };
}

describe("normalizePath", () => {
  test("keeps relative paths and strips everything up to contracts/", () => {
    expect(normalizePath("src/A.sol")).toBe("src/A.sol");
    expect(normalizePath("C:\\repo\\contracts\\src\\A.sol")).toBe("src/A.sol");
    expect(normalizePath("/home/runner/work/equityos/contracts/src/A.sol")).toBe("src/A.sol");
  });
});

describe("parseSlither", () => {
  test("identifies a finding by detector, file and qualified element name", () => {
    expect(parseSlither(SLITHER)).toEqual([
      TIMESTAMP,
      {
        tool: "slither",
        detector: "naming-convention",
        severity: "Informational",
        location: "src/RebalanceLog.sol:RebalanceLog.REGISTRY",
      },
    ]);
  });

  test("reads a report without findings", () => {
    expect(parseSlither({ success: true, error: null, results: {} })).toEqual([]);
  });

  test("rejects a failed run", () => {
    expect(() => parseSlither({ success: false, error: "compilation failed", results: {} })).toThrow(
      "slither did not succeed",
    );
  });
});

describe("parseAderyn", () => {
  test("groups instances per detector and file", () => {
    expect(parseAderyn(ADERYN)).toEqual([
      { tool: "aderyn", detector: "unspecific-solidity-pragma", severity: "Low", location: "src/A.sol (2 instances)" },
      { tool: "aderyn", detector: "unspecific-solidity-pragma", severity: "Low", location: "src/B.sol (1 instance)" },
    ]);
  });

  test("maps high issues to High", () => {
    const report = { high_issues: { issues: [{ detector_name: "x", instances: [{ contract_path: "src/A.sol" }] }] } };
    expect(parseAderyn(report)).toEqual([
      { tool: "aderyn", detector: "x", severity: "High", location: "src/A.sol (1 instance)" },
    ]);
  });
});

describe("parseBaseline", () => {
  test("reads every entry", () => {
    expect(parseBaseline({ findings: [entry(TIMESTAMP)] })).toEqual([entry(TIMESTAMP)]);
  });

  test("rejects an entry without a reason or with an unknown verdict", () => {
    expect(() => parseBaseline({ findings: [{ ...TIMESTAMP, verdict: "false-positive" }] })).toThrow("reason");
    expect(() => parseBaseline({ findings: [{ ...TIMESTAMP, verdict: "ignored", reason: "x" }] })).toThrow(
      "unknown verdict",
    );
  });
});

describe("compare", () => {
  test("passes when the reports match the baseline exactly", () => {
    const comparison = compare([TIMESTAMP], [entry(TIMESTAMP)]);
    expect(passes(comparison)).toBe(true);
    expect(formatComparison(comparison)).toContain("matches the reviewed baseline (1 findings)");
  });

  test("fails on a new finding", () => {
    const comparison = compare([TIMESTAMP], []);
    expect(comparison.unreviewed).toEqual([TIMESTAMP]);
    expect(passes(comparison)).toBe(false);
    expect(formatComparison(comparison)).toContain("new finding");
  });

  test("fails on a stale entry", () => {
    const comparison = compare([], [entry(TIMESTAMP)]);
    expect(comparison.stale).toEqual([entry(TIMESTAMP)]);
    expect(passes(comparison)).toBe(false);
  });

  test("fails on one more Aderyn instance in the same file", () => {
    const baseline = parseAderyn(ADERYN).map((finding) => entry(finding, "accepted"));
    const more = {
      low_issues: {
        issues: [
          {
            detector_name: "unspecific-solidity-pragma",
            instances: [
              { contract_path: "src/A.sol" },
              { contract_path: "src/A.sol" },
              { contract_path: "src/A.sol" },
              { contract_path: "src/B.sol" },
            ],
          },
        ],
      },
    };
    expect(passes(compare(parseAderyn(more), baseline))).toBe(false);
  });

  test("never accepts a High or Medium finding as a known risk", () => {
    const medium: Finding = { ...TIMESTAMP, severity: "Medium" };
    const comparison = compare([medium], [entry(medium, "accepted")]);
    expect(comparison.unresolved).toHaveLength(1);
    expect(passes(comparison)).toBe(false);
    expect(passes(compare([medium], [entry(medium, "false-positive")]))).toBe(true);
  });
});

describe("parseArguments", () => {
  test("reads the three paths in any order", () => {
    expect(parseArguments(["--aderyn", "a.json", "--baseline", "b.json", "--slither", "s.json"])).toEqual({
      baseline: "b.json",
      slither: "s.json",
      aderyn: "a.json",
    });
  });

  test("rejects missing and unknown arguments", () => {
    expect(() => parseArguments(["--baseline", "b.json"])).toThrow("usage");
    expect(() => parseArguments(["--baseline"])).toThrow("missing value");
    expect(() => parseArguments(["--other", "x"])).toThrow("unknown argument");
  });
});

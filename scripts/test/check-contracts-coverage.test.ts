import { describe, expect, test } from "bun:test";
import {
  checkCoverage,
  DEFAULT_MIN_PERCENT,
  formatCoverageReport,
  parseArguments,
  parseLcov,
  percent,
} from "../check-contracts-coverage.ts";

const REPORT = [
  "TN:",
  "SF:src/IndexRegistry.sol",
  "DA:58,4",
  "LF:84",
  "LH:84",
  "BRDA:59,0,0,1",
  "BRF:21",
  "BRH:21",
  "end_of_record",
  "TN:",
  "SF:src/RebalanceLog.sol",
  "LF:5",
  "LH:4",
  "BRF:1",
  "BRH:1",
  "end_of_record",
  "TN:",
  "SF:test/mocks/UsageMocks.sol",
  "LF:30",
  "LH:0",
  "BRF:4",
  "BRH:0",
  "end_of_record",
].join("\n");

describe("parseLcov", () => {
  test("reads the totals of every record", () => {
    expect(parseLcov(REPORT)).toEqual([
      { file: "src/IndexRegistry.sol", linesFound: 84, linesHit: 84, branchesFound: 21, branchesHit: 21 },
      { file: "src/RebalanceLog.sol", linesFound: 5, linesHit: 4, branchesFound: 1, branchesHit: 1 },
      { file: "test/mocks/UsageMocks.sol", linesFound: 30, linesHit: 0, branchesFound: 4, branchesHit: 0 },
    ]);
  });

  test("accepts Windows line endings and separators", () => {
    const report = "SF:C:\\repo\\contracts\\src\\A.sol\r\nLF:2\r\nLH:2\r\nend_of_record\r\n";
    expect(parseLcov(report)).toEqual([
      { file: "C:/repo/contracts/src/A.sol", linesFound: 2, linesHit: 2, branchesFound: 0, branchesHit: 0 },
    ]);
  });

  test("drops a record that is never closed", () => {
    expect(parseLcov("SF:src/A.sol\nLF:2\nLH:1\n")).toEqual([]);
  });
});

describe("percent", () => {
  test("is 100 when there is nothing to cover", () => {
    expect(percent(0, 0)).toBe(100);
  });

  test("is the hit ratio otherwise", () => {
    expect(percent(19, 20)).toBe(95);
  });
});

describe("checkCoverage", () => {
  test("checks src files only, against lines and branches", () => {
    const checks = checkCoverage(parseLcov(REPORT), DEFAULT_MIN_PERCENT);
    expect(checks.map(({ file, ok }) => [file, ok])).toEqual([
      ["src/IndexRegistry.sol", true],
      ["src/RebalanceLog.sol", false],
    ]);
  });

  test("passes exactly at the floor", () => {
    const [check] = checkCoverage(
      [{ file: "src/A.sol", linesFound: 20, linesHit: 19, branchesFound: 20, branchesHit: 19 }],
      95,
    );
    expect(check?.ok).toBe(true);
  });

  test("fails on branches alone", () => {
    const [check] = checkCoverage(
      [{ file: "src/A.sol", linesFound: 10, linesHit: 10, branchesFound: 10, branchesHit: 9 }],
      95,
    );
    expect(check?.ok).toBe(false);
  });
});

describe("formatCoverageReport", () => {
  test("prints one line per file and the floor", () => {
    const text = formatCoverageReport(checkCoverage(parseLcov(REPORT), 95), 95);
    expect(text).toBe(
      [
        "ok   src/IndexRegistry.sol: lines 100.00%, branches 100.00%",
        "FAIL src/RebalanceLog.sol: lines 80.00%, branches 100.00%",
        "floor: 95% lines and branches per file",
      ].join("\n"),
    );
  });

  test("fails an empty report", () => {
    expect(formatCoverageReport([], 95)).toStartWith("FAIL");
  });
});

describe("parseArguments", () => {
  test("defaults the floor", () => {
    expect(parseArguments(["lcov.info"])).toEqual({ path: "lcov.info", minPercent: DEFAULT_MIN_PERCENT });
  });

  test("reads --min", () => {
    expect(parseArguments(["lcov.info", "--min", "90"])).toEqual({ path: "lcov.info", minPercent: 90 });
  });

  test("rejects a missing path, a bad floor and unknown arguments", () => {
    expect(() => parseArguments([])).toThrow("usage");
    expect(() => parseArguments(["lcov.info", "--min", "101"])).toThrow("invalid --min");
    expect(() => parseArguments(["lcov.info", "--max", "1"])).toThrow("unknown argument");
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ApiIssue } from "../../src/lib/portfolio/api";
import { describeIssues, ISSUE_TEXT, transferWarningLines } from "../../src/lib/portfolio/issues";

/** Every finding code of the calculation specification, from its table of blockers and warnings. */
function specifiedCodes(): string[] {
  const text = readFileSync(new URL("../../../../docs/architecture/calculation.md", import.meta.url), "utf8");
  const table = text.slice(text.indexOf("## Blockers and warnings"));
  return [...table.matchAll(/^\| `([a-z_]+)` +\| (?:Blocker|Warning) /gm)].flatMap((match) => match[1] ?? []);
}

/** Every code the published plan vectors of @equityos/core produce. */
function vectorCodes(): string[] {
  const text = readFileSync(new URL("../../../../packages/core/vectors/rebalance-plans.json", import.meta.url), "utf8");
  return [...new Set([...text.matchAll(/"code": "([a-z_]+)"/g)].flatMap((match) => match[1] ?? []))];
}

const issue = (code: ApiIssue["code"], fields: Partial<ApiIssue> = {}): ApiIssue => ({
  code,
  severity: "warning",
  token: null,
  minimumDeployableValueUsdE8: null,
  uninvestedQuote: null,
  currentMaxAbsDriftBps: null,
  projectedMaxAbsDriftBps: null,
  ...fields,
});

const BANNED = /\b(should|recommend\w*|opportunit\w*|advice|buy now|sell now)\b/i;

describe("plain-language findings", () => {
  test("every code of the calculation has a sentence, and nothing else does", () => {
    const codes = specifiedCodes();
    expect(codes.length).toBeGreaterThan(10);
    expect(Object.keys(ISSUE_TEXT).sort()).toEqual([...codes].sort());
    for (const code of vectorCodes()) expect(Object.keys(ISSUE_TEXT)).toContain(code);
  });

  test("each sentence states its numbers, and none reads as advice", () => {
    for (const code of Object.keys(ISSUE_TEXT) as ApiIssue["code"][]) {
      const [line] = describeIssues([issue(code, { token: "0xb2" })], () => "NVDAc");
      expect(line?.text).not.toMatch(BANNED);
    }
    const [minimum] = describeIssues(
      [issue("below_minimum_portfolio_value", { severity: "blocker", minimumDeployableValueUsdE8: "1005033970" })],
      String,
    );
    expect(minimum?.text).toContain("10.05 USD");
    const [left] = describeIssues([issue("uninvested_quote", { uninvestedQuote: "12500000" })], String);
    expect(left?.text).toContain("12.50 USD");
    const [increase] = describeIssues(
      [issue("projected_drift_increase", { currentMaxAbsDriftBps: null, projectedMaxAbsDriftBps: 37 })],
      String,
    );
    expect(increase?.text).toBe("After the plan the largest drift would be 0.37 pp, above the current 0.00 pp.");
  });

  test("findings of one code about several tokens become one sentence, blockers first", () => {
    const lines = describeIssues(
      [
        issue("market_closed", { token: "0x1" }),
        issue("price_unavailable", { token: "0x3", severity: "blocker" }),
        issue("market_closed", { token: "0x2" }),
      ],
      (token) => ({ "0x1": "AAPLc", "0x2": "NVDAc", "0x3": "TSLAc" })[token] ?? token,
    );
    expect(lines.map(({ code }) => code)).toEqual(["price_unavailable", "market_closed"]);
    expect(lines[1]?.text).toStartWith("Market closed for AAPLc and NVDAc:");
  });
});

describe("transferWarningLines", () => {
  test("adds one line to the plan statement per constituent whose transfers are paused", () => {
    expect(transferWarningLines([])).toEqual([]);
    expect(
      transferWarningLines([
        { code: "transfers_paused", token: "0xb20000000000000000000078ee7ce2fe4908108c", symbol: "NVDAc" },
        { code: "transfers_paused", token: "0xb200000000000000000000000000000000000001", symbol: null },
      ]),
    ).toEqual([
      "Transfers of NVDAc are paused by its issuer: a leg in it cannot be executed while the pause lasts.",
      "Transfers of 0xb200000000000000000000000000000000000001 are paused by its issuer: a leg in it cannot be executed while the pause lasts.",
    ]);
  });
});

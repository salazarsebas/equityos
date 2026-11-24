import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import type { PriceStatus } from "@equityos/core";
import type { QuoteFailureReason } from "../../src/lib/execution/calldata";
import { CHECK_STATUS_TEXT, CHECK_TEXT, describeCheck } from "../../src/lib/execution/check-text";
import type { CheckStatus } from "../../src/lib/execution/response";
import {
  allowanceCheck,
  balanceCheck,
  type CheckResult,
  deviationCheck,
  freshnessCheck,
  jurisdictionCheck,
  multiplierCheck,
  pauseCheck,
  policyCheck,
} from "../../src/server/execution/checks";
import type { Jurisdiction } from "../../src/server/jurisdiction";
import { NVDA } from "./support";

/** Every value of a server union, checked by the compiler: a missing or an extra member does not compile. */
const PRICE_STATUSES = Object.keys({
  live: true,
  delayed: true,
  last_close: true,
  unavailable: true,
  missing: true,
} satisfies Record<PriceStatus, true>);
const QUOTE_FAILURES = Object.keys({
  no_route: true,
  provider_rejected: true,
  provider_rate_limited: true,
  provider_unavailable: true,
  provider_malformed: true,
  router_not_allowed: true,
  unknown_selector: true,
  executor_not_allowed: true,
  flags_not_allowed: true,
  executor_data_unrecognized: true,
  calldata_mismatch: true,
} satisfies Record<QuoteFailureReason, true>);
const JURISDICTIONS: Jurisdiction[] = [
  { restricted: true, reason: "restricted_country", country: "US" },
  { restricted: true, reason: "country_unknown", country: null },
  { restricted: false, reason: "permitted_country", country: "DE" },
  { restricted: false, reason: "development_no_geolocation", country: null },
];

/**
 * Reasons the server passes as a typed expression rather than a literal, and every value that expression takes.
 * A new expression in the server fails the scan below until it is listed here.
 */
const TYPED_REASONS: Readonly<Record<string, readonly string[]>> = {
  "jurisdiction.reason": JURISDICTIONS.map(({ reason }) => reason),
  status: PRICE_STATUSES,
  "verified.reason": QUOTE_FAILURES,
};

interface ServerCode {
  readonly check: string;
  readonly reason: string;
  /** The status reported with it, when the source states it as a literal. */
  readonly status: string | null;
  readonly where: string;
}

/** The arguments of a call starting at `start` (just after the opening parenthesis), split at top-level commas. */
function callArguments(source: string, start: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(" || char === "{" || char === "[") depth += 1;
    if (char === ")" || char === "}" || char === "]") {
      if (depth === 0) break;
      depth -= 1;
    }
    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
    } else current += char;
  }
  args.push(current.trim());
  return args;
}

const LITERAL = /^"([a-z_]+)"$/;
const TERNARY = /^(.+?)\s*\?\s*"([a-z_]+)"\s*:\s*"([a-z_]+)"$/;

/** The values an argument can take: a literal, or both branches of a ternary of literals. `null` otherwise. */
function literals(expression: string): { condition: string | null; values: string[] } | null {
  const literal = LITERAL.exec(expression);
  if (literal?.[1] !== undefined) return { condition: null, values: [literal[1]] };
  const ternary = TERNARY.exec(expression);
  if (ternary?.[1] !== undefined && ternary[2] !== undefined && ternary[3] !== undefined) {
    return { condition: ternary[1], values: [ternary[2], ternary[3]] };
  }
  return null;
}

/** Every check and reason the server's execution code reports, read from its `result(...)` calls. */
function serverCodes(): ServerCode[] {
  const directory = new URL("../../src/server/execution/", import.meta.url);
  const codes: ServerCode[] = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(new URL(file, directory), "utf8");
    for (const match of source.matchAll(/\bresult\(\s*"/g)) {
      const where = `${file}:${source.slice(0, match.index).split("\n").length}`;
      const [checkArg = "", statusArg = "", reasonArg = ""] = callArguments(source, match.index + "result(".length);
      const check = LITERAL.exec(checkArg)?.[1];
      if (check === undefined) throw new Error(`${where}: the check is not a literal: ${checkArg}`);
      const status = literals(statusArg);
      const reasons = literals(reasonArg);
      if (reasons === null) {
        const typed = TYPED_REASONS[reasonArg];
        if (typed === undefined) throw new Error(`${where}: the reason ${reasonArg} is not a literal nor a known type`);
        // The type narrows with the control flow around the call, so the status is checked by running the code.
        for (const reason of typed) codes.push({ check, reason, status: null, where });
        continue;
      }
      reasons.values.forEach((reason, branch) => {
        // A status that is a literal applies to every reason; one with the same condition pairs branch by branch.
        const paired =
          status === null
            ? null
            : status.condition === null
              ? (status.values[0] ?? null)
              : status.condition === reasons.condition
                ? (status.values[branch] ?? null)
                : null;
        codes.push({ check, reason, status: paired, where });
      });
    }
  }
  return codes;
}

/** The text the review has for a reason, read without the fallback of `describeCheck`. */
function textOf(check: string, reason: string) {
  if (!Object.hasOwn(CHECK_TEXT, check)) return undefined;
  const reasons: Readonly<Record<string, { status: CheckStatus; result: string; meaning?: string }>> =
    CHECK_TEXT[check as keyof typeof CHECK_TEXT].reasons;
  return Object.hasOwn(reasons, reason) ? reasons[reason] : undefined;
}

/** The results of the server's check functions, over every branch they have. */
function checkFunctionResults(): CheckResult[] {
  const block = 1_000;
  return [
    ...JURISDICTIONS.map(jurisdictionCheck),
    ...PRICE_STATUSES.map((status) => freshnessCheck(status as PriceStatus, NVDA, 0)),
    deviationCheck(10n, 20n, 150, NVDA, 0),
    deviationCheck(10n, 151n, 150, NVDA, 0),
    multiplierCheck(null, block, block, 86_400, NVDA),
    multiplierCheck(0, block, block, 86_400, NVDA),
    multiplierCheck(block + 10, block, block, 86_400, NVDA),
    multiplierCheck(block + 100_000, block, block, 86_400, NVDA),
    pauseCheck(null, NVDA),
    pauseCheck(true, NVDA),
    pauseCheck(false, NVDA),
    policyCheck({ sender: null, receiver: true, executor: true }, NVDA),
    policyCheck({ sender: true, receiver: false, executor: true }, NVDA),
    policyCheck({ sender: true, receiver: true, executor: true }, NVDA),
    allowanceCheck(null, 5n, NVDA),
    allowanceCheck(6n, 5n, NVDA),
    allowanceCheck(5n, 5n, NVDA),
    balanceCheck(null, 5n, NVDA),
    balanceCheck(4n, 5n, NVDA),
    balanceCheck(5n, 5n, NVDA),
  ];
}

/** Words that would turn a state into a recommendation or an urge to trade. */
const FORBIDDEN = /\b(should|recommend|now!|don't miss|opportunity|profit|best|guarantee[ds]? returns?)\b/i;
const EM_DASH = String.fromCodePoint(0x2014);

describe("check and warning text", () => {
  const codes = serverCodes();

  test("the scan of the server finds its checks", () => {
    // A refactor that hides the calls from the scan must not pass silently.
    expect(codes.length).toBeGreaterThanOrEqual(50);
    expect(new Set(codes.map(({ check }) => check))).toEqual(new Set(Object.keys(CHECK_TEXT)));
  });

  test("every check and reason the server reports has text, with the status it is reported with", () => {
    const missing = codes.filter(({ check, reason }) => textOf(check, reason) === undefined);
    expect(missing).toEqual([]);
    const mismatched = codes.filter(
      ({ check, reason, status }) => status !== null && textOf(check, reason)?.status !== status,
    );
    expect(mismatched).toEqual([]);
  });

  test("the server's check functions report every reason with the status its text states", () => {
    for (const { check, status, reason } of checkFunctionResults()) {
      expect({ check, reason, status: textOf(check, reason)?.status }).toEqual({ check, reason, status });
    }
  });

  test("every quote failure blocks, as the plan reports it", () => {
    for (const reason of QUOTE_FAILURES) expect(textOf("quote", reason)?.status).toBe("block");
  });

  test("the text has no reason the server does not report", () => {
    const reported = new Set(codes.map(({ check, reason }) => `${check}:${reason}`));
    const described = Object.entries(CHECK_TEXT).flatMap(([check, { reasons }]) =>
      Object.keys(reasons).map((reason) => `${check}:${reason}`),
    );
    expect(described.filter((code) => !reported.has(code))).toEqual([]);
  });

  test("every warning says what it means for the user", () => {
    const warnings = Object.values(CHECK_TEXT).flatMap(({ reasons }) =>
      Object.values(reasons).filter((text) => text.status === "warn"),
    );
    expect(warnings.length).toBe(3);
    for (const warning of warnings) expect(warning.status === "warn" && warning.meaning.length > 0).toBe(true);
  });

  test("every sentence is complete, plain and gives no advice", () => {
    const sentences = Object.values(CHECK_TEXT).flatMap(({ checked, reasons }) => [
      checked,
      ...Object.values(reasons).flatMap((text) =>
        text.status === "warn" ? [text.result, text.meaning] : [text.result],
      ),
    ]);
    for (const sentence of sentences) {
      expect(sentence).toMatch(/^[A-Z].*\.$/);
      expect(FORBIDDEN.test(sentence)).toBe(false);
      expect(sentence).not.toContain(EM_DASH);
      // A code is shown next to the text for developers, never inside it.
      expect(sentence).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    }
    for (const title of Object.values(CHECK_TEXT).map((text) => text.title)) expect(title).toMatch(/^[A-Z][a-z ]+$/);
    expect(Object.values(CHECK_STATUS_TEXT)).toEqual([
      "Passed",
      "Warning",
      "Blocks the plan",
      "Not simulated",
      "Not checked",
    ]);
  });

  test("a check or reason the page does not know is described as unknown, not guessed at", () => {
    expect(describeCheck({ check: "reference_freshness", status: "warn", reason: "delayed" })).toMatchObject({
      title: "Reference price",
      known: true,
    });
    expect(describeCheck({ check: "reference_freshness", status: "warn", reason: "delayed" }).meaning).toContain(
      "0.5%",
    );
    expect(describeCheck({ check: "allowance", status: "pass", reason: "within_plan" }).meaning).toBeNull();
    expect(describeCheck({ check: "new_check", status: "block", reason: "x" })).toMatchObject({
      title: "Unknown check",
      known: false,
    });
    expect(describeCheck({ check: "allowance", status: "block", reason: "toString" })).toMatchObject({
      title: "Allowance",
      known: false,
    });
  });
});

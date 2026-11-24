import { describe, expect, test } from "bun:test";
import { keccak256, toHex } from "viem";
import {
  allowanceCheck,
  approvalFor,
  balanceCheck,
  deviationBps,
  deviationCheck,
  freshnessCheck,
  jurisdictionCheck,
  multiplierCheck,
  pauseCheck,
  policyCheck,
  reportedDeviation,
  verdict,
} from "../../src/server/execution/checks";
import { POLICY_SCOPES } from "../../src/server/execution/reads";
import { KYBERSWAP_ROUTER } from "../../src/lib/execution/calldata";
import { classifyJurisdiction } from "../../src/server/jurisdiction";
import { NVDA } from "./support";

const country = (code: string | null, env: string) =>
  jurisdictionCheck(
    classifyJurisdiction(new Headers(code === null ? {} : { "x-vercel-ip-country": code }), { NODE_ENV: env }),
  );

describe("jurisdiction", () => {
  test("blocks restricted countries and fails closed in production when the country is unknown", () => {
    expect(country("US", "production")).toMatchObject({ status: "block", reason: "restricted_country" });
    expect(country("PR", "development")).toMatchObject({ status: "block", reason: "restricted_country" });
    expect(country(null, "production")).toMatchObject({ status: "block", reason: "country_unknown" });
    expect(country("??", "development")).toMatchObject({ status: "block", reason: "country_unknown" });
  });

  test("passes a permitted country and only warns outside production without a header", () => {
    expect(country("DE", "production")).toMatchObject({ status: "pass", reason: "permitted_country", detail: "DE" });
    expect(country(null, "development")).toMatchObject({ status: "warn", reason: "development_no_geolocation" });
    expect(country(null, "test")).toMatchObject({ status: "warn" });
  });
});

describe("reference freshness", () => {
  test("live passes, delayed warns, last_close and unavailable block", () => {
    expect(freshnessCheck("live", NVDA, 0).status).toBe("pass");
    expect(freshnessCheck("delayed", NVDA, 0).status).toBe("warn");
    expect(freshnessCheck("last_close", NVDA, 1)).toMatchObject({ status: "block", reason: "last_close", leg: 1 });
    expect(freshnessCheck("unavailable", NVDA, 0).status).toBe("block");
  });
});

describe("deviation", () => {
  // 0.03 of an 8-decimal token at a reference of 160.00 USD is 4.80 USDC.
  const reference = { tokens: 3_000_000n, decimals: 8, priceE8: 16_000_000_000n };
  const of = (usdc: bigint) => deviationBps(usdc, reference.tokens, reference.decimals, reference.priceE8);

  test("is zero at the reference and signed: positive above it, negative below", () => {
    expect(of(4_800_000n)).toBe(0n);
    expect(of(4_848_000n)).toBe(100n);
    expect(of(4_752_000n)).toBe(-100n);
  });

  test("rounds away from zero, so it is never reported smaller than it is", () => {
    expect(of(4_800_001n)).toBe(1n);
    expect(of(4_799_999n)).toBe(-1n);
    // 4,848,001 is 100.0021 bps above: reported as 101.
    expect(of(4_848_001n)).toBe(101n);
    expect(of(4_751_999n)).toBe(-101n);
  });

  test("a buy that pays more than the reference is positive", () => {
    // 5.00 USDC for 0.0125 at 400.00 is the reference; for 0.0124 it pays 0.81% more.
    expect(deviationBps(5_000_000n, 1_250_000n, 8, 40_000_000_000n)).toBe(0n);
    expect(deviationBps(5_000_000n, 1_240_000n, 8, 40_000_000_000n)).toBe(81n);
  });

  test("the band also holds for the minimum-out price, so the worst accepted outcome is within it", () => {
    expect(deviationCheck(0n, -100n, 100, NVDA, 0).status).toBe("pass");
    expect(deviationCheck(0n, -101n, 100, NVDA, 0)).toMatchObject({ status: "block", detail: "0/-101" });
    expect(deviationCheck(0n, 101n, 100, NVDA, 0).status).toBe("block");
  });

  test("the band is inclusive in both directions and the report is clamped", () => {
    expect(deviationCheck(100n, 100n, 100, NVDA, 0).status).toBe("pass");
    expect(deviationCheck(-100n, -100n, 100, NVDA, 0).status).toBe("pass");
    expect(deviationCheck(101n, 0n, 100, NVDA, 0)).toMatchObject({
      status: "block",
      reason: "outside_band",
      detail: "101/0",
    });
    expect(deviationCheck(-101n, 0n, 100, NVDA, 0).status).toBe("block");
    expect(reportedDeviation(10n ** 12n)).toBe(1_000_000);
    expect(() => deviationBps(1n, 0n, 8, 1n)).toThrow(RangeError);
  });
});

describe("multiplier window", () => {
  const block = 1_000_000;
  const now = block + 2;
  test("passes with no update or one already in effect", () => {
    expect(multiplierCheck(0, block, now, 86_400, NVDA)).toMatchObject({ status: "pass", reason: "none_pending" });
    expect(multiplierCheck(block, block, now, 86_400, NVDA).reason).toBe("none_pending");
  });

  test("blocks an update that takes effect within the window, the window end included", () => {
    expect(multiplierCheck(block + 1, block, now, 86_400, NVDA).status).toBe("block");
    expect(multiplierCheck(now + 86_400, block, now, 86_400, NVDA)).toMatchObject({
      status: "block",
      reason: "pending_within_window",
      detail: String(now + 86_400),
    });
    expect(multiplierCheck(now + 86_401, block, now, 86_400, NVDA).reason).toBe("pending_outside_window");
    expect(multiplierCheck(null, block, now, 86_400, NVDA).reason).toBe("read_failed");
  });
});

describe("pause and policy", () => {
  test("a paused or unread token blocks", () => {
    expect(pauseCheck(false, NVDA).status).toBe("pass");
    expect(pauseCheck(true, NVDA)).toMatchObject({ status: "block", reason: "paused" });
    expect(pauseCheck(null, NVDA)).toMatchObject({ status: "block", reason: "read_failed" });
  });

  test("names every scope that denies, and blocks on an unread one", () => {
    const all = { sender: true, receiver: true, executor: true };
    expect(policyCheck(all, NVDA).status).toBe("pass");
    expect(policyCheck({ ...all, executor: false }, NVDA)).toMatchObject({ status: "block", detail: "executor" });
    expect(policyCheck({ ...all, sender: false, receiver: false }, NVDA).detail).toBe("sender,receiver");
    expect(policyCheck({ ...all, receiver: null }, NVDA).reason).toBe("read_failed");
  });

  test("the pinned policy scopes are the keccak256 of their names", () => {
    expect(POLICY_SCOPES.sender).toBe("0xb81736c875ab819dd97f59f2a6542cfb731ad52b4ae15a6f24df2fb02b0327f5");
    expect(POLICY_SCOPES.receiver).toBe(keccak256(toHex("TRANSFER_RECEIVER_POLICY")));
    expect(POLICY_SCOPES.executor).toBe(keccak256(toHex("TRANSFER_EXECUTOR_POLICY")));
  });
});

describe("balance and allowance", () => {
  test("a balance covers exactly the amount needed or blocks", () => {
    expect(balanceCheck(10n, 10n, NVDA)).toMatchObject({ status: "pass", detail: "10/10" });
    expect(balanceCheck(9n, 10n, NVDA)).toMatchObject({ status: "block", reason: "insufficient", detail: "10/9" });
    expect(balanceCheck(null, 10n, NVDA).reason).toBe("read_failed");
  });

  test("an approval is exactly the amount swapped and required only below it", () => {
    expect(approvalFor(NVDA, KYBERSWAP_ROUTER, 100n, 0n)).toEqual({
      token: NVDA,
      spender: KYBERSWAP_ROUTER,
      currentAllowance: 0n,
      amount: 100n,
      required: true,
    });
    expect(approvalFor(NVDA, KYBERSWAP_ROUTER, 100n, 99n).required).toBe(true);
    expect(approvalFor(NVDA, KYBERSWAP_ROUTER, 100n, 100n).required).toBe(false);
    expect(approvalFor(NVDA, KYBERSWAP_ROUTER, 100n, 2n ** 256n - 1n)).toMatchObject({ amount: 100n, required: false });
    expect(allowanceCheck(null, 100n, NVDA).status).toBe("block");
  });

  test("an allowance above the plan, unlimited included, is a warning with the amount", () => {
    expect(allowanceCheck(100n, 100n, NVDA)).toMatchObject({ status: "pass", reason: "within_plan" });
    expect(allowanceCheck(0n, 100n, NVDA).status).toBe("pass");
    expect(allowanceCheck(101n, 100n, NVDA)).toMatchObject({ status: "warn", reason: "above_plan", detail: "101" });
    expect(allowanceCheck(2n ** 256n - 1n, 100n, NVDA)).toMatchObject({
      status: "warn",
      detail: (2n ** 256n - 1n).toString(),
    });
  });
});

describe("verdict", () => {
  const pass = pauseCheck(false, NVDA);
  const notSimulated = { ...pass, check: "simulation" as const, status: "not_simulated" as const };
  test("not_simulated blocks unless accepted, and an accepted one is still not executable", () => {
    expect(verdict([pass, notSimulated], false)).toEqual({ blocking: [notSimulated], executable: false });
    expect(verdict([pass, notSimulated], true)).toEqual({ blocking: [], executable: false });
    expect(verdict([pass, freshnessCheck("delayed", NVDA, 0)], false)).toEqual({ blocking: [], executable: true });
  });
});

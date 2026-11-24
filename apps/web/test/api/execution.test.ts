import { describe, expect, spyOn, test } from "bun:test";
import { EXECUTION_STATEMENT, MAX_BODY_BYTES } from "../../src/server/api/execution";
import { planHash } from "../../src/server/execution/plan";
import type { PlannedCall } from "../../src/server/execution/simulate";
import { ABOVE, executionResponses, INDEX, post, READY_BODY, setup } from "./execution-support";
import { body, RECORDED_AT } from "./support";

type Plan = {
  status: string;
  executable: boolean;
  statement: string;
  priceBasis: string;
  checks: { check: string; status: string; reason: string }[];
  blockedBy: { check: string; reason: string }[];
  calls: (Omit<PlannedCall, "value" | "minAmountOut"> & { value: string; minAmountOut: string | null })[] | null;
  planHash: string | null;
  legs: { side: string; quote: { deviationBps: number } | null }[];
};

async function plan(handler: Awaited<ReturnType<typeof setup>>, request: Request) {
  const response = await handler(request, undefined);
  const parsed = await body(response);
  return { response, data: parsed.data as Plan, error: parsed.error };
}

describe("POST /api/v1/portfolio/execution-plan", () => {
  test("is ready for the constructed account with the market open, and binds its calls with planHash", async () => {
    const { response, data } = await plan(await setup(), post(READY_BODY));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(data.blockedBy).toEqual([]);
    expect(data).toMatchObject({ status: "ready", executable: true, priceBasis: "executable_quote" });
    expect(data.statement).toBe(EXECUTION_STATEMENT);
    const calls = (data.calls ?? []).map((call) => ({ to: call.to, value: BigInt(call.value), data: call.data }));
    expect(calls.length).toBeGreaterThan(2);
    expect(data.planHash).toBe(planHash(8453, ABOVE, calls));
    // Quoted at the reference price: what remains is the rounding of the quoted amount to a base unit.
    expect(data.legs.every((leg) => Math.abs(leg.quote?.deviationBps ?? 99) <= 1)).toBe(true);
  });

  test("blocks a restricted request, and one without a country in production, before quoting", async () => {
    const handler = await setup();
    for (const headers of [{ "x-vercel-ip-country": "US" }, {}]) {
      const { data } = await plan(handler, post(READY_BODY, headers));
      expect(data.status).toBe("blocked");
      expect(data.blockedBy.map(({ check }) => check)).toEqual(["jurisdiction"]);
      expect(data.legs).toEqual([]);
    }
    const local = await plan(await setup({ nodeEnv: "development" }), post(READY_BODY, {}));
    expect(local.data.checks[0]).toMatchObject({ check: "jurisdiction", status: "warn" });
    expect(local.data.status).toBe("ready");
  });

  test("blocks on the recorded closed market: the reference is a last close", async () => {
    const { data } = await plan(await setup({ at: RECORDED_AT }), post(READY_BODY));
    expect(data.status).toBe("blocked");
    expect(new Set(data.blockedBy.map(({ check, reason }) => `${check}:${reason}`))).toEqual(
      new Set(["reference_freshness:last_close"]),
    );
  });

  test("refuses replayed market data", async () => {
    const { response, error } = await plan(await setup({ marketMode: "replay" }), post(READY_BODY));
    expect(response.status).toBe(409);
    expect(error).toMatchObject({ code: "execution_unavailable", details: { reason: "market_data_replay" } });
  });

  test("validates the body strictly", async () => {
    const handler = await setup();
    const cases: [Request, string, string | null][] = [
      [post("not json"), "invalid_body", null],
      [post("[]"), "invalid_body", null],
      [post(`{"index":"${"x".repeat(MAX_BODY_BYTES)}"}`), "invalid_body", null],
      [
        new Request("https://equityos.test/", { method: "POST", body: JSON.stringify(READY_BODY) }),
        "invalid_body",
        null,
      ],
      [post({ ...READY_BODY, extra: 1 }), "invalid_parameter", "extra"],
      [post({ ...READY_BODY, mode: "sell_all" }), "invalid_parameter", "mode"],
      [post({ ...READY_BODY, slippageBps: 201 }), "invalid_parameter", "slippageBps"],
      [post({ ...READY_BODY, slippageBps: 1.5 }), "invalid_parameter", "slippageBps"],
      [post({ ...READY_BODY, maxDeviationBps: 501 }), "invalid_parameter", "maxDeviationBps"],
      [post({ ...READY_BODY, maxDeviationBps: "100" }), "invalid_parameter", "maxDeviationBps"],
      [post({ ...READY_BODY, allowUnsimulated: "true" }), "invalid_parameter", "allowUnsimulated"],
      [post({ ...READY_BODY, minLegValueUsdE8: 100 }), "invalid_parameter", "minLegValueUsdE8"],
      [post({ ...READY_BODY, reserveBps: 2_001 }), "invalid_parameter", "reserveBps"],
      [post({ ...READY_BODY, version: 0 }), "invalid_parameter", "version"],
      [post({ ...READY_BODY, address: "0x12" }), "invalid_address", "address"],
      [post({ index: INDEX, mode: "rebalance" }), "invalid_parameter", "address"],
    ];
    for (const [request, code, parameter] of cases) {
      const { response, error } = await plan(handler, request);
      expect(response.status).toBe(400);
      expect(error?.code).toBe(code);
      if (parameter !== null) expect(error?.details?.parameter).toBe(parameter);
    }
  });

  test("answers 503 when Base mainnet does not answer the pre-trade read", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const responses = await executionResponses();
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 400, 404, 409, 503]);
    } finally {
      log.mockRestore();
    }
  });
});

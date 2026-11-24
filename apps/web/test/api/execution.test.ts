import { describe, expect, spyOn, test } from "bun:test";
import { EXECUTION_STATEMENT, MAX_BODY_BYTES } from "../../src/server/api/execution";
import { planHash } from "../../src/lib/execution/calldata";
import { createExecutionLimits } from "../../src/server/execution/limits";
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
  expiresAt: string | null;
  warnings: { check: string; reason: string }[];
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
    const expiresAt = Date.parse(data.expiresAt ?? "") / 1000;
    expect(data.planHash).toBe(planHash(8453, ABOVE, expiresAt, calls));
    expect(data.warnings).toEqual([]);
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

  test("limits each address to 3 plans at once, then one every 20 seconds", async () => {
    let ms = 1_000_000;
    const handler = await setup({ limits: createExecutionLimits(() => ms) });
    const from = (ip: string) => post({ ...READY_BODY, slippageBps: 999 }, { "x-real-ip": ip });
    for (let i = 0; i < 3; i += 1) expect((await handler(from("192.0.2.1"), undefined)).status).toBe(400);
    const limited = await handler(from("192.0.2.1"), undefined);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("20");
    expect((await body(limited)).error?.code).toBe("rate_limited");
    expect((await handler(from("192.0.2.2"), undefined)).status).toBe(400);
    ms += 20_000;
    expect((await handler(from("192.0.2.1"), undefined)).status).toBe(400);
  });

  test("takes the plan's provider requests from the instance budget, and answers 503 when it is spent", async () => {
    let ms = 1_000_000;
    const handler = await setup({ limits: createExecutionLimits(() => ms) });
    const first = await plan(handler, post(READY_BODY));
    expect(first.response.status).toBe(200);
    // Each leg takes two of the 10 provider requests the instance may make in 10 seconds.
    const perPlan = first.data.legs.length * 2;
    for (let made = perPlan; made + perPlan <= 10; made += perPlan) {
      expect((await handler(post(READY_BODY), undefined)).status).toBe(200);
    }
    const spent = await handler(post(READY_BODY), undefined);
    expect(spent.status).toBe(503);
    expect((await body(spent)).error?.code).toBe("provider_rate_limited");
    expect(Number(spent.headers.get("retry-after"))).toBeGreaterThan(0);
    ms += 10_000;
    expect((await handler(post(READY_BODY), undefined)).status).toBe(200);
  });

  test("a 429 of the provider fails fast with 503 provider_rate_limited and its Retry-After", async () => {
    const handler = await setup({
      provider: (base) => ({
        ...base,
        quote: async () => ({ status: "failed", reason: "provider_rate_limited", detail: "9" }),
      }),
    });
    const response = await handler(post(READY_BODY), undefined);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("9");
    expect((await body(response)).error).toMatchObject({
      code: "provider_rate_limited",
      details: { source: "kyberswap_api" },
    });
  });

  test("answers 503 deadline_exceeded past the overall deadline, and aborts the provider requests", async () => {
    let aborted = false;
    const handler = await setup({
      deadlineMs: 30,
      provider: (base) => ({
        ...base,
        quote: (_request, context) =>
          new Promise((resolve) => {
            context.signal.addEventListener("abort", () => {
              aborted = true;
              resolve({ status: "failed", reason: "provider_unavailable", detail: null });
            });
          }),
      }),
    });
    const response = await handler(post(READY_BODY), undefined);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("15");
    expect((await body(response)).error?.code).toBe("deadline_exceeded");
    expect(aborted).toBe(true);
  });
});

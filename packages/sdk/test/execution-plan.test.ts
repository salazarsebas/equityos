import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ApiError, createClient, EXECUTION_STATEMENT } from "../src/index.ts";
import { example, mockFetch } from "./support.ts";

/** A response of the execution plan endpoint recorded against Base mainnet and the live quote provider. */
const recorded = JSON.parse(readFileSync(new URL("./fixtures/execution-plan.json", import.meta.url), "utf8")) as {
  readonly request: { readonly address: string; readonly index: string; readonly mode: string };
  readonly status: number;
  readonly body: unknown;
};

describe("executionPlan", () => {
  test("POSTs the request as JSON and decodes a recorded ready plan, amounts as bigint", async () => {
    const mock = mockFetch(() => Response.json(recorded.body, { status: recorded.status }));
    const client = createClient({ baseUrl: "https://equityos.example", fetch: mock.fetch });
    const { data, meta } = await client.executionPlan({ ...recorded.request, minLegValueUsdE8: 100_000_000n });
    const [call] = mock.calls;
    expect(call?.url).toBe("https://equityos.example/api/v1/portfolio/execution-plan");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(call?.init.body ?? "")).toEqual({ ...recorded.request, minLegValueUsdE8: "100000000" });
    expect(data.status).toBe("ready");
    expect(data.statement).toBe(EXECUTION_STATEMENT);
    expect(data.planHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(typeof data.legs[0]?.amountIn).toBe("bigint");
    expect(typeof data.legs[0]?.quote?.minAmountOut).toBe("bigint");
    expect(data.calls?.[0]?.kind).toBe("approve");
    expect(typeof data.totals?.maxUsdcForBuys).toBe("bigint");
    expect(meta.balances.chainId).toBe(8453);
  });

  test("a deployment that serves replayed data answers execution_unavailable", async () => {
    const { status, body } = example("executionPlan.replay");
    const client = createClient({
      baseUrl: "https://equityos.example",
      fetch: mockFetch(() => Response.json(body, { status })).fetch,
    });
    const error = await client.executionPlan(recorded.request).catch((rejection: unknown) => rejection);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "execution_unavailable" });
  });

  test("a rate limit carries the seconds of Retry-After", async () => {
    const body = { error: { code: "rate_limited", message: "Too many.", details: null } };
    const client = createClient({
      baseUrl: "https://equityos.example",
      fetch: mockFetch(() => Response.json(body, { status: 429, headers: { "Retry-After": "20" } })).fetch,
    });
    await expect(client.executionPlan(recorded.request)).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 20,
    });
  });
});

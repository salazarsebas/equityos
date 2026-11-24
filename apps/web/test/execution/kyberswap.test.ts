import { describe, expect, test } from "bun:test";
import {
  createKyberSwapProvider,
  DEFAULT_CLIENT_ID,
  KYBERSWAP_API,
  resolveClientId,
} from "../../src/server/execution/kyberswap";
import type { QuoteRequest } from "../../src/server/execution/provider";
import { verifyQuote } from "../../src/server/execution/router";
import { MissingConfigurationError } from "../../src/server/market/errors";
import { kyberswapFixture, type RecordedLeg } from "./support";

const [buy, sell] = kyberswapFixture.legs;
if (buy === undefined || sell === undefined) throw new Error("the fixture holds three legs");

function requestFor(leg: RecordedLeg): QuoteRequest {
  return {
    tokenIn: leg.request.tokenIn,
    tokenOut: leg.request.tokenOut,
    amountIn: BigInt(leg.request.amountIn),
    account: kyberswapFixture.account,
    slippageBps: kyberswapFixture.slippageBps,
    deadline: kyberswapFixture.deadline,
  };
}

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
}

type Answer = Response | "network_error";

/** A `fetch` that answers from a queue of responses and records every request. */
function scripted(answers: Answer[]) {
  const sent: Sent[] = [];
  const serve = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    sent.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body });
    const next = answers.shift();
    if (next === undefined) throw new Error("no answer left");
    if (next === "network_error") throw new TypeError("fetch failed");
    return next;
  };
  return { fetch: Object.assign(serve, { preconnect: fetch.preconnect }), sent };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

function recordedAnswers(leg: RecordedLeg): Answer[] {
  return [json(leg.route.status, leg.route.body), json(leg.build.status, leg.build.body)];
}

function provider(answers: Answer[], waits: number[] = []) {
  const transport = scripted(answers);
  const kyber = createKyberSwapProvider({
    clientId: "equityos",
    fetch: transport.fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { kyber, sent: transport.sent, waits };
}

describe("KyberSwap client on recorded answers", () => {
  test("requests a route then a build for the account, and the result verifies", async () => {
    for (const leg of kyberswapFixture.legs) {
      const { kyber, sent } = provider(recordedAnswers(leg));
      const request = requestFor(leg);
      const answer = await kyber.quote(request);
      if (answer.status !== "ok") throw new Error(`${leg.name}: ${answer.reason}`);
      expect(answer.quote.quotedAmountOut).toBe(BigInt(leg.build.body.data.amountOut));
      expect(verifyQuote(request, answer.quote).status).toBe("ok");
      const [route, build] = sent;
      expect(route?.url).toStartWith(`${KYBERSWAP_API}/routes?`);
      expect(new URL(route?.url ?? "").searchParams.get("amountIn")).toBe(leg.request.amountIn);
      expect(route?.headers.get("x-client-id")).toBe("equityos");
      expect(build?.method).toBe("POST");
      expect(build?.url).toBe(`${KYBERSWAP_API}/route/build`);
      expect(build?.headers.get("x-client-id")).toBe("equityos");
      expect(build?.body).toMatchObject({
        sender: kyberswapFixture.account,
        recipient: kyberswapFixture.account,
        slippageTolerance: 50,
        deadline: kyberswapFixture.deadline,
      });
      // No API key of any kind is sent.
      for (const request of sent) {
        expect([...request.headers.keys()].sort()).toEqual(
          request.method === "POST" ? ["accept", "content-type", "x-client-id"] : ["accept", "x-client-id"],
        );
      }
    }
  });

  test("a pair without a route is no_route, with the recorded error code, and is not retried", async () => {
    const { kyber, sent } = provider([
      json(kyberswapFixture.routeNotFound.status, kyberswapFixture.routeNotFound.body),
    ]);
    expect(await kyber.quote(requestFor(buy))).toEqual({ status: "failed", reason: "no_route", detail: "4008" });
    expect(sent).toHaveLength(1);
  });

  test("a refused request is provider_rejected and is not retried", async () => {
    const refused = { code: 4000, message: "bad request", details: [{ fieldViolations: [{ field: "wallets" }] }] };
    const { kyber, sent } = provider([json(buy.route.status, buy.route.body), json(400, refused)]);
    expect(await kyber.quote(requestFor(buy))).toEqual({
      status: "failed",
      reason: "provider_rejected",
      detail: "4000",
    });
    expect(sent).toHaveLength(2);
  });

  test("retries once after a 5xx, a timeout or a network error, then reports the provider unavailable", async () => {
    const recovered = provider([json(502, {}), ...recordedAnswers(buy)]);
    expect((await recovered.kyber.quote(requestFor(buy))).status).toBe("ok");
    expect(recovered.sent).toHaveLength(3);
    const down = provider(["network_error", json(503, {})]);
    expect(await down.kyber.quote(requestFor(buy))).toEqual({
      status: "failed",
      reason: "provider_unavailable",
      detail: null,
    });
    expect(down.sent).toHaveLength(2);
    expect(down.waits).toEqual([500]);
  });

  test("waits for the rate limit window before its one retry, at most 10 seconds", async () => {
    const limited = (after: string) => json(429, {}, { "x-ratelimit-reset-after": after });
    const once = provider([limited("3"), ...recordedAnswers(buy)]);
    expect((await once.kyber.quote(requestFor(buy))).status).toBe("ok");
    expect(once.waits).toEqual([3_000]);
    const twice = provider([limited("60"), limited("60")]);
    expect(await twice.kyber.quote(requestFor(buy))).toMatchObject({ reason: "provider_rate_limited" });
    expect(twice.waits).toEqual([10_000]);
  });

  test("an answer of an unexpected shape is provider_malformed and never retried or defaulted", async () => {
    const route = () => json(buy.route.status, buy.route.body);
    const build = (change: Record<string, unknown>) =>
      json(200, { ...buy.build.body, data: { ...buy.build.body.data, ...change } });
    const cases: [Answer[], string][] = [
      [[json(200, { code: 0, data: null })], "envelope"],
      [[json(200, "not json")], "envelope"],
      [[json(200, { code: 0, data: {} })], "routeSummary"],
      [[route(), build({ amountOut: 3061375 })], "amountOut"],
      [[route(), build({ data: "calldata" })], "data"],
      [[route(), build({ routerAddress: "0x12" })], "routerAddress"],
      [[route(), build({ transactionValue: undefined })], "transactionValue"],
    ];
    for (const [answers, detail] of cases) {
      const requests = answers.length;
      const { kyber, sent } = provider(answers);
      expect(await kyber.quote(requestFor(buy))).toEqual({ status: "failed", reason: "provider_malformed", detail });
      expect(sent.length).toBe(requests);
    }
  });

  test("a route for another pair or amount than requested is refused before building", async () => {
    const { kyber, sent } = provider([json(sell.route.status, sell.route.body)]);
    expect(await kyber.quote(requestFor(buy))).toEqual({
      status: "failed",
      reason: "provider_malformed",
      detail: "routeSummary",
    });
    expect(sent).toHaveLength(1);
  });
});

describe("client id", () => {
  test("defaults, is read from the environment and is validated", () => {
    expect(resolveClientId({})).toBe(DEFAULT_CLIENT_ID);
    expect(resolveClientId({ KYBERSWAP_CLIENT_ID: " my-app.v1 " })).toBe("my-app.v1");
    expect(() => resolveClientId({ KYBERSWAP_CLIENT_ID: "a b" })).toThrow(MissingConfigurationError);
    expect(() => resolveClientId({ KYBERSWAP_CLIENT_ID: "x".repeat(65) })).toThrow(MissingConfigurationError);
  });
});

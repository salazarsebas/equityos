import { expect, test } from "@playwright/test";
import { NOT_DEPLOYED_ORIGIN } from "./servers";

/** The recorded registry and the constructed balances of `test/fixtures/market/balances.json`. */
const INDEX = "diversified-equity-d622e2a5";
const ABOVE = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const EMPTY = "0x0000000000000000000000000000000000001003";

test.describe("portfolio API on the replay", () => {
  test("compares a constructed wallet and says where each input was read", async ({ request }) => {
    const response = await request.get(`/api/v1/portfolio?address=${ABOVE}&index=${INDEX}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["x-equityos-api-version"]).toBe("1.2.0");
    const { data, meta } = await response.json();
    expect(data.drift).toMatchObject({ maxAbsDriftBps: 1500, thresholdReached: true });
    expect(meta.registry).toMatchObject({ chainId: 31_337, mode: "replay" });
    expect(meta.balances).toEqual({
      chainId: 8453,
      blockNumber: "60489401",
      blockTimestamp: "2026-11-21T19:10:55Z",
      mode: "replay",
    });
  });

  test("the plan states that it is not a quote, and a blocked plan has no legs", async ({ request }) => {
    const ready = await (
      await request.get(`/api/v1/portfolio/plan?address=${ABOVE}&index=${INDEX}&mode=rebalance`)
    ).json();
    expect(ready.data).toMatchObject({ executable: false, priceBasis: "reference", plan: { status: "ready" } });
    const blocked = await (
      await request.get(`/api/v1/portfolio/plan?address=${EMPTY}&index=${INDEX}&mode=buy_only&depositUsdE8=200000000`)
    ).json();
    expect(blocked.data.plan.status).toBe("blocked");
    expect(blocked.data.plan.legs).toBeUndefined();
  });

  test("a chain without the registry answers 409", async ({ request }) => {
    const response = await request.get(`${NOT_DEPLOYED_ORIGIN}/api/v1/portfolio?address=${ABOVE}&index=${INDEX}`);
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe("registry_not_deployed");
  });
});

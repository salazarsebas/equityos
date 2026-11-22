import { describe, expect, test } from "bun:test";
import { ineligibilityText, parseAssetsResponse } from "../../src/lib/studio/assets";
import { evaluateDraft } from "../../src/lib/studio/evaluate";
import { publishFailureText } from "../../src/lib/studio/messages";
import { durationText, methodologyText } from "../../src/lib/studio/methodology-text";
import { ASSETS, TOKENS, validDraft } from "./support";

function text(overrides: Parameters<typeof validDraft>[0] = {}): string[] {
  const { valid } = evaluateDraft(validDraft(overrides), ASSETS);
  if (valid === null) throw new Error("expected a valid draft");
  return methodologyText(valid.spec, valid.constituents);
}

describe("methodologyText", () => {
  test("states the weighting, the bounds and the rebalance rule with their numbers", () => {
    expect(text()).toEqual([
      "Equal weight across 3 tokenized stocks: from 33.33% to 33.34%.",
      "A rebalance is due when a constituent is more than 5.00 percentage points away from its target weight, and at least 7 days have passed since the last rebalance.",
      "Weights are targets. They are measured with reference prices from one oracle feed per constituent.",
    ]);
    expect(
      text({ tokens: TOKENS.slice(0, 2), maxWeight: "60", minWeight: "40", minInterval: "0" }).slice(0, 3),
    ).toEqual([
      "Equal weight across 2 tokenized stocks: 50.00% each.",
      "Every weight must stay between 40.00% and 60.00%.",
      "A rebalance is due when a constituent is more than 5.00 percentage points away from its target weight, with no minimum time between two rebalances.",
    ]);
    const [first, cap] = text({
      tokens: TOKENS.slice(0, 2),
      weighting: "fixed",
      weights: { [TOKENS[0] ?? ""]: "70", [TOKENS[1] ?? ""]: "30" },
      maxWeight: "70",
    });
    expect(first).toBe("Fixed weights across 2 tokenized stocks: from 30.00% to 70.00%.");
    expect(cap).toBe("No weight may be above 70.00%.");
    expect(text({ tokens: TOKENS.slice(0, 1), minWeight: "100" })[1]).toBe("No weight may be below 100.00%.");
  });

  test("durations use the largest unit that divides them", () => {
    expect(durationText(604_800)).toBe("7 days");
    expect(durationText(86_400)).toBe("1 day");
    expect(durationText(129_600)).toBe("36 hours");
    expect(durationText(90)).toBe("90 seconds");
  });
});

describe("publishFailureText", () => {
  test("explains an index that already exists and offers a new salt, never a silent one", () => {
    const id = `0x${"ab".repeat(32)}`;
    const failure = publishFailureText({ kind: "contract_error", name: "IndexAlreadyExists", args: [id] });
    expect(failure.offersNewSalt).toBe(true);
    expect(failure.body).toContain(`IndexAlreadyExists(${id})`);
    expect(failure.body).toContain("Nothing was sent.");
  });

  test("names any other custom error with its arguments", () => {
    const failure = publishFailureText({ kind: "contract_error", name: "SpecTooLarge", args: [9000n, 8192n] });
    expect(failure).toMatchObject({
      offersNewSalt: false,
      title: "The registry would reject this call with SpecTooLarge.",
    });
    expect(failure.body).toContain("SpecTooLarge(9000, 8192)");
    expect(publishFailureText({ kind: "unknown" }).offersNewSalt).toBe(false);
  });
});

const asset = {
  address: TOKENS[0],
  symbol: "AAAc",
  name: "Company",
  eligibility: { eligible: true, reasons: [] },
  referencePrice: {
    status: "last_close",
    priceE8: "34529769685",
    updatedAt: "2026-11-20T23:12:02Z",
    feedProxy: "0x787f13dea48db0897cbcdd985de77809d837f988",
  },
};
const meta = {
  datasets: { onchain: { blockNumber: "60489401", blockTimestamp: "2026-11-21T19:10:55Z", servedStale: false } },
};

describe("parseAssetsResponse", () => {
  test("reads the envelope of GET /api/v1/assets", () => {
    const ineligible = {
      ...asset,
      address: TOKENS[1],
      eligibility: { eligible: false, reasons: ["not_minted", "missing_feed"] },
      referencePrice: { status: "unavailable", priceE8: null, updatedAt: null, feedProxy: null },
    };
    const parsed = parseAssetsResponse({ data: [asset, ineligible], meta });
    expect(parsed).toMatchObject({ blockNumber: 60_489_401n, blockTimestamp: 1_795_288_255, servedStale: false });
    expect(parsed?.assets).toEqual([
      {
        address: TOKENS[0] ?? "0x",
        symbol: "AAAc",
        name: "Company",
        eligible: true,
        reasons: [],
        feed: "0x787f13dea48db0897cbcdd985de77809d837f988",
        priceE8: 34_529_769_685n,
        priceStatus: "last_close",
        priceUpdatedAt: 1_795_216_322,
      },
      {
        address: TOKENS[1] ?? "0x",
        symbol: "AAAc",
        name: "Company",
        eligible: false,
        reasons: ["not_minted", "missing_feed"],
        feed: null,
        priceE8: null,
        priceStatus: "unavailable",
        priceUpdatedAt: null,
      },
    ]);
  });

  test("an asset without a feed is never selectable, and a malformed price is no price", () => {
    const noFeed = { ...asset, referencePrice: { ...asset.referencePrice, feedProxy: "0xNOPE" } };
    const badPrice = { ...asset, referencePrice: { ...asset.referencePrice, priceE8: "12.5" } };
    const parsed = parseAssetsResponse({ data: [noFeed, badPrice], meta });
    expect(parsed?.assets[0]).toMatchObject({ eligible: false, feed: null });
    expect(parsed?.assets[1]).toMatchObject({ priceE8: null, priceStatus: "unavailable" });
  });

  test("drops entries that are not assets and rejects a body of another shape", () => {
    expect(parseAssetsResponse({ data: [asset, null, 7, { address: "0x1" }], meta })?.assets).toHaveLength(1);
    for (const body of [null, [], { data: {} }, { data: [], meta: {} }, { error: { code: "upstream_failure" } }]) {
      expect(parseAssetsResponse(body)).toBeNull();
    }
  });

  test("ineligibility reasons are worded", () => {
    expect(ineligibilityText(["not_minted", "missing_feed"])).toBe("not minted, no reference feed");
    expect(ineligibilityText(["some_new_code"])).toBe("some new code");
    expect(ineligibilityText([])).toBe("not eligible");
  });
});

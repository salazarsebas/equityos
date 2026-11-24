import { describe, expect, test } from "bun:test";
import { ineligibilityText, parseAssetsResponse } from "../../src/lib/studio/assets";
import { publishFailureText } from "../../src/lib/studio/messages";
import { TOKENS } from "./support";

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
    expect(publishFailureText({ kind: "unknown" })).toMatchObject({ offersNewSalt: false, reported: null });
  });

  test("a plain revert reason is kept apart from the app's own sentences", () => {
    const failure = publishFailureText({ kind: "revert", reason: "custom text" });
    expect(failure.reported).toBe("custom text");
    expect(`${failure.title} ${failure.body}`).not.toContain("custom text");
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

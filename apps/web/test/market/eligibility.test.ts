import { describe, expect, test } from "bun:test";
import type { ListedAsset } from "../../src/server/market/asset-list";
import { assessEligibility, type EligibilityInput } from "../../src/server/market/eligibility";
import type { ReferenceFeed } from "../../src/server/market/feeds";
import type { FeedRead, TokenRead, TokenState } from "../../src/server/market/onchain";
import { TOKENS } from "./support";

const asset: ListedAsset = {
  address: TOKENS.NVDA,
  symbol: "NVDAc",
  name: "NVIDIA Corporation",
  decimals: 8,
  isin: "US67066G1040",
  iconUrl: null,
};
const state: TokenState = {
  decimals: 8,
  totalSupply: 6_201_973_777_574n,
  multiplierWad: 1_000_537_939_576_369_481n,
  pendingMultiplier: null,
  transfersPaused: false,
};
const token: TokenRead = { status: "ok", state };
const feed: ReferenceFeed = { proxy: "0x04689a41629776563E6822F76f2e57D148d28513", description: "Coinbase NVDA" };
const feedRead: FeedRead = {
  status: "ok",
  decimals: 8,
  description: "Coinbase NVDA",
  round: { roundId: 5n, answer: 12_982_480_034n, updatedAt: 1_795_218_160, answeredInRound: 5n },
};
const eligible: EligibilityInput = { asset, token, feed, feedRead };

function reasons(input: Partial<EligibilityInput>) {
  const result = assessEligibility({ ...eligible, ...input });
  return result.eligible ? [] : result.reasons;
}

describe("assessEligibility", () => {
  test("a listed, initialized, minted token with a verified feed is eligible", () => {
    expect(assessEligibility(eligible)).toEqual({ eligible: true });
  });

  test("not listed", () => {
    expect(reasons({ asset: undefined })).toEqual(["not_listed"]);
  });

  test("not minted: a total supply of zero, and one base unit is enough", () => {
    expect(reasons({ token: { status: "ok", state: { ...state, totalSupply: 0n } } })).toEqual(["not_minted"]);
    expect(reasons({ token: { status: "ok", state: { ...state, totalSupply: 1n } } })).toEqual([]);
  });

  test("not initialized", () => {
    expect(reasons({ token: { status: "not_initialized" } })).toEqual(["not_initialized"]);
  });

  test("no reference feed", () => {
    expect(reasons({ feed: undefined, feedRead: undefined })).toEqual(["missing_feed"]);
  });

  test("fails closed when the token state was not read", () => {
    expect(reasons({ token: { status: "read_failed" } })).toEqual(["onchain_read_failed"]);
    expect(reasons({ token: undefined })).toEqual(["onchain_read_failed"]);
  });

  test("decimals that differ between the chain and the list", () => {
    expect(reasons({ token: { status: "ok", state: { ...state, decimals: 18 } } })).toEqual(["decimals_mismatch"]);
  });

  test("a feed proxy that answers with another identity", () => {
    expect(reasons({ feedRead: { ...feedRead, description: "Coinbase AMD" } })).toEqual(["feed_mismatch"]);
    expect(reasons({ feedRead: { ...feedRead, decimals: 18 } })).toEqual(["feed_mismatch"]);
  });

  test("a feed that could not be read does not change eligibility", () => {
    expect(reasons({ feedRead: { status: "read_failed" } })).toEqual([]);
    expect(reasons({ feedRead: undefined })).toEqual([]);
  });

  test("paused transfers and a pending multiplier do not change eligibility", () => {
    const paused = {
      ...state,
      transfersPaused: true,
      pendingMultiplier: { multiplierWad: 2n * 10n ** 18n, effectiveAt: 2_000_000_000 },
    };
    expect(reasons({ token: { status: "ok", state: paused } })).toEqual([]);
  });

  test("reports every failed condition, in a stable order", () => {
    expect(
      reasons({ token: { status: "ok", state: { ...state, decimals: 6, totalSupply: 0n } }, feed: undefined }),
    ).toEqual(["decimals_mismatch", "not_minted", "missing_feed"]);
    expect(reasons({ token: { status: "not_initialized" }, feed: undefined })).toEqual([
      "not_initialized",
      "missing_feed",
    ]);
  });
});

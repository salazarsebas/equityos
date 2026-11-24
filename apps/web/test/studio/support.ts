import { type Address, bytesToHex } from "@equityos/core";
import type { StudioAsset } from "../../src/lib/studio/assets";
import { type Draft, newDraft } from "../../src/lib/studio/draft";
import { evaluateDraft } from "../../src/lib/studio/evaluate";
import type { VersionTarget } from "../../src/lib/studio/version";

export const SALT = `0x${"5a".repeat(32)}` as const;
export const CHAIN_ID = 31_337;

export const TOKENS: readonly Address[] = [
  "0xb200000000000000000000000000000000000001",
  "0xb200000000000000000000000000000000000002",
  "0xb200000000000000000000000000000000000003",
  "0xb200000000000000000000000000000000000004",
];

export const ASSETS: readonly StudioAsset[] = TOKENS.map((address, i) => ({
  address,
  symbol: ["AAAc", "BBBc", "CCCc", "DDDc"][i] ?? "Xc",
  name: `Company ${i + 1}`,
  eligible: true,
  reasons: [],
  feed: `0xfeed${address.slice(6)}`,
  priceE8: 10_000_000_000n,
  priceStatus: "live",
  priceUpdatedAt: 1_800_000_000,
}));

/** A draft that is a valid spec: three equal constituents. */
export function validDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    ...newDraft(CHAIN_ID, SALT),
    name: "Test Index",
    slug: "test-index",
    tokens: [TOKENS[2], TOKENS[0], TOKENS[1]].flatMap((token) => token ?? []),
    ...overrides,
  };
}

export const INDEX_ID = `0x${"ab".repeat(32)}` as const;

/** An index at version 1, the spec of `validDraft()`, created by `creator` in `registry`. */
export function versionTarget(creator: Address, registry: Address, draft: Draft = validDraft()): VersionTarget {
  const { valid } = evaluateDraft(draft, ASSETS);
  if (valid === null) throw new Error("expected a valid draft");
  const { spec, specBytes, specHash } = valid;
  return {
    identifier: `${spec.slug}-abababab`,
    indexId: INDEX_ID,
    chainId: CHAIN_ID,
    registry,
    creator,
    latestVersion: 1,
    deprecated: false,
    base: { version: 1, spec, specBytes, specHex: bytesToHex(specBytes), specHash },
  };
}

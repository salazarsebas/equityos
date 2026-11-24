import { describe, expect, test } from "bun:test";
import { type Address, bytesToHex, type IndexSpec } from "@equityos/core";
import { buildSeedIndexes, type SeedVersion } from "../../scripts/seed/indexes";
import { diffSpecs, summarizeDiff } from "../../src/lib/indexes/diff";
import type { StudioAsset } from "../../src/lib/studio/assets";
import { setName, setSlug, toggleToken } from "../../src/lib/studio/draft";
import { evaluateDraft } from "../../src/lib/studio/evaluate";
import { takeReviewSnapshot } from "../../src/lib/studio/snapshot";
import {
  describeChanges,
  draftFromSpec,
  type IndexHead,
  identifierAfter,
  indexesOf,
  isUnchanged,
  loadTarget,
  parseIndexPage,
  parseIndexResponse,
  parseVersionResponse,
  type StoredVersion,
} from "../../src/lib/studio/version";
import { ASSETS, CHAIN_ID, INDEX_ID, SALT, TOKENS, validDraft, versionTarget } from "./support";

const REGISTRY: Address = "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c";
const CREATOR: Address = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const SEEDS = buildSeedIndexes(CHAIN_ID);

/** The asset list a seed version was written against: its own tokens with its own feeds. */
function assetsOf(spec: IndexSpec): StudioAsset[] {
  return spec.universe.tokens.map((address, i) => ({
    address,
    symbol: `T${i}`,
    name: `Token ${i}`,
    eligible: true,
    reasons: [],
    feed: spec.pricing.feeds[i] ?? null,
    priceE8: null,
    priceStatus: "unavailable",
    priceUpdatedAt: null,
  }));
}

function head(overrides: Partial<IndexHead> = {}): IndexHead {
  return {
    identifier: "test-index-abababab",
    indexId: INDEX_ID,
    chainId: CHAIN_ID,
    registry: REGISTRY,
    creator: CREATOR,
    latestVersion: 1,
    deprecated: false,
    ...overrides,
  };
}

function storedOf(version: SeedVersion, number = 1): StoredVersion {
  return {
    version: number,
    specHex: bytesToHex(version.specBytes),
    specHash: version.specHash,
    constituents: version.tokens.map((token, i) => ({ token, weightBps: version.weightsBps[i] ?? 0 })),
  };
}

const conformant = SEEDS.flatMap((seed) => seed.versions).filter(
  (version) => version.spec.slug !== "mismatched-weights",
);

describe("draftFromSpec", () => {
  test("every conformant seed version opens as a draft that gives back the same bytes", () => {
    expect(conformant.length).toBeGreaterThan(3);
    for (const version of conformant) {
      const loaded = draftFromSpec(version.spec, SALT);
      if (!loaded.ok) throw new Error(loaded.reason);
      const { valid } = evaluateDraft(loaded.draft, assetsOf(version.spec));
      expect(valid?.specHash).toBe(version.specHash);
      expect(loaded.draft.slugEdited).toBe(true);
    }
  });

  test("renaming a loaded draft keeps its slug, so the identifier never changes by itself", () => {
    const loaded = draftFromSpec(versionTarget(CREATOR, REGISTRY).base.spec, SALT);
    if (!loaded.ok) throw new Error(loaded.reason);
    expect(setName(loaded.draft, "Another Name").slug).toBe("test-index");
  });

  test("a spec the editor cannot write is refused with the reason", () => {
    const { spec } = versionTarget(CREATOR, REGISTRY).base;
    const odd = { ...spec, rebalance: { ...spec.rebalance, minIntervalSeconds: 5_400 } };
    expect(draftFromSpec(odd, SALT)).toEqual({
      ok: false,
      reason: "Its minimum rebalance interval, 5400 seconds, is not a whole number of hours.",
    });
    const parent = { chainId: CHAIN_ID, registry: REGISTRY, indexId: INDEX_ID, version: 1, specHash: INDEX_ID };
    expect(draftFromSpec({ ...spec, parent }, SALT)).toMatchObject({ ok: false });
    const hours = draftFromSpec({ ...spec, rebalance: { ...spec.rebalance, minIntervalSeconds: 7_200 } }, SALT);
    expect(hours.ok && [hours.draft.minInterval, hours.draft.minIntervalUnit]).toEqual(["2", "hours"]);
  });
});

describe("loadTarget", () => {
  const [mismatched, deprecated, equal] = SEEDS;
  const first = (seed: (typeof SEEDS)[number] | undefined) => {
    const version = seed?.versions[0];
    if (version === undefined) throw new Error("missing seed");
    return version;
  };

  test("a conformant latest version opens, prefilled, with the base it was verified as", () => {
    const version = first(equal);
    const loaded = loadTarget(head(), storedOf(version), SALT);
    if (loaded.status !== "ready") throw new Error(loaded.status);
    expect(loaded.target.base).toMatchObject({ version: 1, specHash: version.specHash });
    expect(loaded.target.base.specBytes).toEqual(version.specBytes);
    expect(loaded.draft.name).toBe(version.spec.name);
  });

  test("a version that fails a check of core cannot be edited, and the failed check is named", () => {
    const loaded = loadTarget(head(), storedOf(first(mismatched)), SALT);
    expect(loaded).toMatchObject({ status: "not_conformant", check: { id: "C5", status: "fail" } });
    // The same bytes read from another chain than the one the spec names.
    const elsewhere = loadTarget(head({ chainId: 8453 }), storedOf(first(equal)), SALT);
    expect(elsewhere).toMatchObject({ status: "not_conformant", check: { id: "C4" } });
    const tampered = { ...storedOf(first(equal)), specHash: first(deprecated).specHash };
    expect(loadTarget(head(), tampered, SALT)).toMatchObject({ status: "not_conformant", check: { id: "C1" } });
  });

  test("a deprecated index is refused before anything is verified", () => {
    expect(loadTarget(head({ deprecated: true }), storedOf(first(equal)), SALT)).toMatchObject({
      status: "deprecated",
    });
  });
});

describe("the unchanged-spec rule", () => {
  const target = versionTarget(CREATOR, REGISTRY);
  const loaded = draftFromSpec(target.base.spec, SALT);
  if (!loaded.ok) throw new Error(loaded.reason);
  const { draft } = loaded;

  test("the prefilled draft is the latest version byte for byte, and no review opens for it", () => {
    const { valid } = evaluateDraft(draft, ASSETS);
    if (valid === null) throw new Error("expected a valid draft");
    expect(isUnchanged(valid, target.base)).toBe(true);
    expect(takeReviewSnapshot(draft, ASSETS, target)).toBeNull();
    // The same draft as a new index is reviewed: the rule is about versions only.
    expect(takeReviewSnapshot(draft, ASSETS)).not.toBeNull();
  });

  test("any change of the bytes makes it publishable, a change undone does not", () => {
    for (const edited of [setName(draft, "Test Index Two"), toggleToken(draft, TOKENS[3] ?? "0x")]) {
      const { valid } = evaluateDraft(edited, ASSETS);
      if (valid === null) throw new Error("expected a valid draft");
      expect(isUnchanged(valid, target.base)).toBe(false);
      expect(takeReviewSnapshot(edited, ASSETS, target)?.target).toBe(target);
    }
    const undone = evaluateDraft(setName(setName(draft, "Other"), "Test Index"), ASSETS).valid;
    expect(undone !== null && isUnchanged(undone, target.base)).toBe(true);
  });
});

describe("describeChanges", () => {
  test("uses the version diff of the index profile, phrase for phrase", () => {
    const target = versionTarget(CREATOR, REGISTRY);
    const { valid } = evaluateDraft(validDraft({ tokens: [...TOKENS], name: "Test Index Wide" }), ASSETS);
    if (valid === null) throw new Error("expected a valid draft");
    const changes = describeChanges(valid, target.base);
    expect(changes).toEqual(summarizeDiff(diffSpecs(target.base.spec, valid.spec)));
    expect(changes).toEqual([
      "1 constituent added",
      "3 weights changed",
      'Name changed from "Test Index" to "Test Index Wide"',
    ]);
  });

  test("the two-version seed index reads the same here as in its version history", () => {
    const twice = SEEDS.find(({ versions }) => versions.length === 2);
    const [v1, v2] = twice?.versions ?? [];
    if (v1 === undefined || v2 === undefined) throw new Error("missing seed");
    const loaded = loadTarget(head(), storedOf(v1), SALT);
    if (loaded.status !== "ready") throw new Error(loaded.status);
    const next = draftFromSpec(v2.spec, SALT);
    if (!next.ok) throw new Error(next.reason);
    const { valid } = evaluateDraft(next.draft, assetsOf(v2.spec));
    if (valid === null) throw new Error("expected a valid draft");
    expect(describeChanges(valid, loaded.target.base)).toEqual(summarizeDiff(diffSpecs(v1.spec, v2.spec)));
  });
});

describe("identifierAfter", () => {
  test("keeps the identifier with the slug, and moves it with a new slug and the same id prefix", () => {
    const target = versionTarget(CREATOR, REGISTRY);
    expect(identifierAfter(target, "test-index")).toBe("test-index-abababab");
    expect(identifierAfter(target, setSlug(validDraft(), "renamed").slug)).toBe("renamed-abababab");
  });
});

describe("API bodies", () => {
  const meta = { registry: { chainId: CHAIN_ID, address: REGISTRY, mode: "live" } };
  const index = {
    indexId: INDEX_ID,
    identifier: "test-index-abababab",
    creator: CREATOR,
    latestVersion: 2,
    deprecated: false,
    latest: { name: "Test Index" },
  };

  test("an index and a version are read field by field, and anything else is refused", () => {
    expect(parseIndexResponse({ data: index, meta })).toEqual(head({ latestVersion: 2 }));
    expect(parseIndexResponse({ data: { ...index, latestVersion: 0 }, meta })).toBeNull();
    expect(parseIndexResponse({ data: { ...index, creator: "0x1" }, meta })).toBeNull();
    expect(parseIndexResponse({ data: index, meta: {} })).toBeNull();
    const version = {
      version: 2,
      specHash: INDEX_ID,
      specBytes: "0x7b7d",
      constituents: [{ token: CREATOR, weightBps: 1 }],
    };
    expect(parseVersionResponse({ data: version })).toEqual({
      version: 2,
      specHash: INDEX_ID,
      specHex: "0x7b7d",
      constituents: [{ token: CREATOR, weightBps: 1 }],
    });
    expect(parseVersionResponse({ data: { ...version, specBytes: "7b7d" } })).toBeNull();
    expect(parseVersionResponse({ data: { ...version, constituents: [{ token: CREATOR }] } })).toBeNull();
  });

  test("the list is filtered to the indexes of one account, in any letter case", () => {
    const other = { ...index, identifier: "other-cdcdcdcd", creator: REGISTRY, latest: { name: null } };
    const page = parseIndexPage({ data: [index, other], meta: { ...meta, nextOffset: null } });
    expect(page?.nextOffset).toBeNull();
    expect(indexesOf(page?.indexes ?? [], "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toEqual([
      { identifier: "test-index-abababab", creator: CREATOR, latestVersion: 2, deprecated: false, name: "Test Index" },
    ]);
    expect(parseIndexPage({ data: [{ ...index, deprecated: "no" }], meta: { ...meta, nextOffset: null } })).toBeNull();
  });
});

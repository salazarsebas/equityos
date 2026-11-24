import { describe, expect, test } from "bun:test";
import {
  draftWeightsBps,
  newDraft,
  normalizePercentText,
  randomSalt,
  setDescription,
  setName,
  setSlug,
  setWeight,
  setWeighting,
  suggestSlug,
  toggleToken,
  withEqualWeights,
} from "../../src/lib/studio/draft";
import { CHAIN_ID, SALT, TOKENS, validDraft } from "./support";

const [T1, T2, T3] = TOKENS as [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`];

describe("slug", () => {
  test("is suggested from the name within the rules of the spec", () => {
    expect(suggestSlug("Semiconductors Equal Weight")).toBe("semiconductors-equal-weight");
    expect(suggestSlug("  AI & Chips (2026)!  ")).toBe("ai-chips-2026");
    expect(suggestSlug("Café Índice")).toBe("caf-ndice");
    expect(suggestSlug("x".repeat(40))).toHaveLength(32);
    expect(suggestSlug("abcdefghij abcdefghij abcdefghij a")).toBe("abcdefghij-abcdefghij-abcdefghij");
    expect(suggestSlug("!!!")).toBe("");
  });

  test("follows the name until it is typed, and follows it again once cleared", () => {
    let draft = setName(newDraft(CHAIN_ID, SALT), "Alpha One");
    expect(draft.slug).toBe("alpha-one");
    draft = setSlug(draft, "mine");
    draft = setName(draft, "Alpha Two");
    expect(draft).toMatchObject({ slug: "mine", slugEdited: true });
    draft = setSlug(draft, "");
    expect(draft).toMatchObject({ slug: "alpha-two", slugEdited: false });
  });
});

describe("description", () => {
  test("is stored in NFC whatever form was typed", () => {
    const decomposed = "Café";
    const draft = setDescription(newDraft(CHAIN_ID, SALT), decomposed);
    expect(draft.description).toBe("Café");
    expect(draft.description).toBe(draft.description.normalize("NFC"));
  });
});

describe("constituents and weights", () => {
  test("a removed token loses its weight", () => {
    let draft = setWeight(validDraft({ weighting: "fixed" }), T1, "50");
    draft = toggleToken(draft, T1);
    expect(draft.tokens).not.toContain(T1);
    expect(draft.weights).toEqual({});
    expect(toggleToken(draft, T1).tokens).toContain(T1);
  });

  test("switching to fixed starts from the equal split, but keeps weights that were typed", () => {
    const fixed = setWeighting(validDraft(), "fixed");
    expect(fixed.weights).toEqual({ [T1]: "33.34", [T2]: "33.33", [T3]: "33.33" });
    const typed = setWeighting(setWeight(validDraft(), T1, "60"), "fixed");
    expect(typed.weights).toEqual({ [T1]: "60" });
    expect(withEqualWeights(newDraft(CHAIN_ID, SALT)).weights).toEqual({});
  });

  test("weights are read in spec order, blank as 0 bps and malformed as unknown", () => {
    const draft = validDraft({ weighting: "fixed", weights: { [T1]: "12.5", [T3]: "1.234" } });
    expect(draftWeightsBps(draft)).toEqual([
      { token: T1, weightBps: 1250 },
      { token: T2, weightBps: 0 },
      { token: T3, weightBps: null },
    ]);
  });

  test("a percent field is rewritten the way it is read, and text that is not one is kept", () => {
    expect(normalizePercentText("12.5")).toBe("12.50");
    expect(normalizePercentText(" 40 ")).toBe("40.00");
    expect(normalizePercentText("")).toBe("");
    expect(normalizePercentText("12.345")).toBe("12.345");
  });
});

describe("randomSalt", () => {
  test("is 32 random bytes of lowercase hex", () => {
    const salts = new Set(Array.from({ length: 20 }, randomSalt));
    expect(salts.size).toBe(20);
    for (const salt of salts) expect(salt).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

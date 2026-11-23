import { describe, expect, test } from "bun:test";
import {
  DRAFT_STORAGE_KEY,
  type DraftStorage,
  discardDraft,
  loadDraft,
  parseStoredDraft,
  saveDraft,
  serializeDraft,
} from "../../src/lib/studio/storage";
import { CHAIN_ID, SALT, TOKENS, validDraft } from "./support";

const CHAINS = [8453, 84_532, CHAIN_ID] as const;
const FRESH = `0x${"11".repeat(32)}` as const;
const fresh = () => FRESH;
const parse = (raw: string | null) => parseStoredDraft(raw, CHAINS, fresh);

function memory(initial: Record<string, string> = {}): DraftStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

describe("draft storage", () => {
  test("the key carries the format version", () => {
    expect(DRAFT_STORAGE_KEY).toBe("equityos.studio.draft.v1");
  });

  test("a draft survives a save and a load unchanged, salt included", () => {
    const draft = validDraft({ weighting: "fixed", weights: { [TOKENS[0] ?? "0x"]: "40.00" }, maxWeight: "50" });
    const storage = memory();
    expect(saveDraft(storage, draft, 1_700_000_000_000)).toBe(true);
    expect(loadDraft(storage, CHAINS, fresh)).toEqual({ draft, savedAt: 1_700_000_000_000 });
  });

  test("nothing stored, text that is not JSON and JSON of another shape are no draft", () => {
    for (const raw of [null, "", "{", "null", "42", '"draft"', "[]", "{}", '{"draft":null}', '{"draft":[1]}']) {
      expect(parse(raw)).toBeNull();
    }
  });

  test("a draft saved without newer fields opens with their defaults", () => {
    const stored = parse(JSON.stringify({ draft: { name: "Old", slug: "old", salt: SALT, chainId: CHAIN_ID } }));
    expect(stored?.savedAt).toBeNull();
    expect(stored?.draft).toMatchObject({
      name: "Old",
      slug: "old",
      salt: SALT,
      chainId: CHAIN_ID,
      tokens: [],
      weighting: "equal",
      weights: {},
      driftThreshold: "5.00",
      minInterval: "7",
      minIntervalUnit: "days",
    });
  });

  test("every field is checked on its own: wrong types fall back, unknown fields are dropped", () => {
    const stored = parse(
      JSON.stringify({
        savedAt: "yesterday",
        draft: {
          chainId: 1,
          name: 42,
          slug: ["x"],
          slugEdited: "yes",
          description: "Café",
          tokens: [TOKENS[1], "0xNOTANADDRESS", TOKENS[1], 7, TOKENS[0]?.toUpperCase(), TOKENS[0]],
          weighting: "capped",
          weights: { [TOKENS[1] ?? ""]: "25", [TOKENS[3] ?? ""]: "10", [TOKENS[0] ?? ""]: { nested: true } },
          maxWeight: null,
          minIntervalUnit: "weeks",
          salt: "0x1234",
          injected: "<script>",
        },
      }),
    );
    expect(stored).toEqual({
      savedAt: null,
      draft: {
        chainId: 8453,
        name: "",
        slug: "",
        slugEdited: false,
        description: "Café",
        tokens: [TOKENS[1] ?? "0x", TOKENS[0] ?? "0x"],
        weighting: "equal",
        weights: { [TOKENS[1] ?? ""]: "25" },
        maxWeight: "",
        minWeight: "",
        driftThreshold: "5.00",
        minInterval: "7",
        minIntervalUnit: "days",
        salt: FRESH,
      },
    });
  });

  test("a stored salt is kept, so a retry targets the same index id", () => {
    expect(parse(serializeDraft(validDraft(), 1))?.draft.salt).toBe(SALT);
  });

  test("oversized text is not read back", () => {
    const stored = parse(JSON.stringify({ draft: { name: "n".repeat(10_000), salt: SALT } }));
    expect(stored?.draft.name).toBe("");
  });

  test("a browser that refuses storage has no draft and reports that nothing was saved", () => {
    const refusing: DraftStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadDraft(refusing, CHAINS, fresh)).toBeNull();
    expect(saveDraft(refusing, validDraft(), 1)).toBe(false);
    expect(() => discardDraft(refusing)).not.toThrow();
  });

  test("discarding removes the stored draft", () => {
    const storage = memory();
    saveDraft(storage, validDraft(), 1);
    discardDraft(storage);
    expect(storage.data).toEqual({});
  });
});

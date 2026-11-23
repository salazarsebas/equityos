import { describe, expect, test } from "bun:test";
import { takeReviewSnapshot, withSalt } from "../../src/lib/studio/snapshot";
import { ASSETS, SALT, validDraft } from "./support";

describe("review snapshot", () => {
  test("holds the draft, a copy of the assets and the spec they made", () => {
    const draft = validDraft();
    const assets = [...ASSETS];
    const snapshot = takeReviewSnapshot(draft, assets);
    if (snapshot === null) throw new Error("expected a snapshot");
    expect(snapshot.draft).toBe(draft);
    expect(snapshot.assets).toEqual(ASSETS);
    expect(snapshot.valid.spec.name).toBe("Test Index");
    // A later change of the asset list does not reach the snapshot.
    assets.length = 0;
    expect(snapshot.assets).toEqual(ASSETS);
  });

  test("is not taken for a draft that is not valid against the assets", () => {
    expect(takeReviewSnapshot(validDraft({ name: "" }), ASSETS)).toBeNull();
    // A selected asset that is missing from the list has no feed, so the spec is not valid.
    expect(takeReviewSnapshot(validDraft(), ASSETS.slice(1))).toBeNull();
  });

  test("a new salt keeps the bytes and the hash that were reviewed", () => {
    const snapshot = takeReviewSnapshot(validDraft(), ASSETS);
    if (snapshot === null) throw new Error("expected a snapshot");
    const salt = `0x${"77".repeat(32)}` as const;
    const salted = withSalt(snapshot, salt);
    expect(salted.draft.salt).toBe(salt);
    expect(snapshot.draft.salt).toBe(SALT);
    expect(salted.valid).toBe(snapshot.valid);
    expect(salted.assets).toBe(snapshot.assets);
  });
});

import { describe, expect, test } from "bun:test";
import { createIndexDirectory, formatIdentifier, parseIdentifier } from "../../src/server/registry/identifier";
import { indexIdOf } from "./support";

describe("parseIdentifier", () => {
  test("accepts an index id in any letter case and normalizes it", () => {
    const indexId = indexIdOf("ab12cd");
    expect(parseIdentifier(indexId)).toEqual({ kind: "index_id", indexId });
    expect(parseIdentifier(`0x${indexId.slice(2).toUpperCase()}`)).toEqual({ kind: "index_id", indexId });
  });

  test("splits a slug identifier at its last hyphen", () => {
    expect(parseIdentifier("alpha-a1b2c3d4")).toEqual({ kind: "slug", slug: "alpha", prefix: "a1b2c3d4" });
    expect(parseIdentifier("large-cap-deadbeef-a1b2c3d4e5")).toEqual({
      kind: "slug",
      slug: "large-cap-deadbeef",
      prefix: "a1b2c3d4e5",
    });
    expect(parseIdentifier(`a-${"f".repeat(64)}`)).toEqual({ kind: "slug", slug: "a", prefix: "f".repeat(64) });
  });

  test("rejects everything else", () => {
    const rejected = [
      "",
      "alpha",
      "alpha-a1b2c3d",
      "alpha-a1b2c3dg",
      "alpha-A1B2C3D4",
      "Alpha-a1b2c3d4",
      "-a1b2c3d4",
      "alpha--a1b2c3d4",
      "a1b2c3d4",
      `${"a".repeat(33)}-a1b2c3d4`,
      `a-${"f".repeat(65)}`,
      "0x1234",
      `0x${"g".repeat(64)}`,
      " alpha-a1b2c3d4",
      "alpha-a1b2c3d4\n",
    ];
    for (const identifier of rejected) expect(parseIdentifier(identifier)).toBeNull();
  });

  test("formatIdentifier output parses back", () => {
    expect(parseIdentifier(formatIdentifier("large-cap", "a1b2c3d4"))).toEqual({
      kind: "slug",
      slug: "large-cap",
      prefix: "a1b2c3d4",
    });
  });
});

describe("createIndexDirectory", () => {
  test("gives every id its first eight digits when none collide", () => {
    const directory = createIndexDirectory();
    directory.append([indexIdOf("a1b2c3d4e5"), indexIdOf("a1b2c3d5")]);
    directory.append([indexIdOf("00000000ff")]);
    expect(directory.size).toBe(3);
    expect([0, 1, 2].map((position) => directory.prefixAt(position))).toEqual(["a1b2c3d4", "a1b2c3d5", "00000000"]);
    expect(directory.idAt(2)).toBe(indexIdOf("00000000ff"));
    expect(directory.positionOf(indexIdOf("a1b2c3d5"))).toBe(1);
    expect(directory.positionOfPrefix("a1b2c3d5")).toBe(1);
    expect(directory.idAt(3)).toBeUndefined();
    expect(directory.prefixAt(3)).toBeUndefined();
    expect(directory.positionOf(indexIdOf("ff"))).toBeUndefined();
  });

  test("a later id that shares the digits of earlier ones gets one digit more than the longest shared run", () => {
    const directory = createIndexDirectory();
    directory.append([indexIdOf("a1b2c3d4e5f6")]);
    directory.append([indexIdOf("a1b2c3d4e5f7"), indexIdOf("a1b2c3d4ee"), indexIdOf("a1b2c3d4e5f70001")]);
    expect([0, 1, 2, 3].map((position) => directory.prefixAt(position))).toEqual([
      "a1b2c3d4",
      "a1b2c3d4e5f7",
      "a1b2c3d4ee",
      "a1b2c3d4e5f70001",
    ]);
  });

  test("a prefix resolves only in its exact canonical length", () => {
    const directory = createIndexDirectory();
    directory.append([indexIdOf("a1b2c3d4e5f6"), indexIdOf("a1b2c3d4e5f7")]);
    expect(directory.positionOfPrefix("a1b2c3d4")).toBe(0);
    expect(directory.positionOfPrefix("a1b2c3d4e")).toBeUndefined();
    expect(directory.positionOfPrefix("a1b2c3d4e5f6")).toBeUndefined();
    expect(directory.positionOfPrefix("a1b2c3d4e5f7")).toBe(1);
    expect(directory.positionOfPrefix("a1b2c3d4e5f70")).toBeUndefined();
  });

  test("the prefix of an id does not depend on the ids appended after it", () => {
    const ids = [indexIdOf("a1b2c3d4e5f6"), indexIdOf("a1b2c3d4e5"), indexIdOf("a1b2c3d4e5f6ff")];
    const all = createIndexDirectory();
    all.append(ids);
    for (const [position] of ids.entries()) {
      const upTo = createIndexDirectory();
      upTo.append(ids.slice(0, position + 1));
      expect(upTo.prefixAt(position)).toBe(all.prefixAt(position));
    }
  });
});

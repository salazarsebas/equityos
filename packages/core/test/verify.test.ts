import { describe, expect, test } from "bun:test";
import {
  canonicalize,
  type Constituent,
  computeConstituents,
  specHash,
  validateSpec,
  verifyVersion,
} from "../src/index.ts";
import { address, baseSpec, utf8 } from "./helpers.ts";

const CHAIN_ID = 8453;

/** What a registry would return for a correctly published version of `spec`. */
function published(spec: Record<string, unknown>) {
  const validation = validateSpec(spec);
  if (!validation.ok) throw new Error(JSON.stringify(validation.errors));
  return {
    specBytes: validation.specBytes,
    specHash: specHash(validation.specBytes),
    constituents: computeConstituents(validation.spec),
    chainId: CHAIN_ID,
  };
}

/** A version whose stored bytes are `bytes`, with a matching hash and no constituents. */
function publishedBytes(bytes: Uint8Array) {
  return { specBytes: bytes, specHash: specHash(bytes), constituents: [], chainId: CHAIN_ID };
}

function summary(input: Parameters<typeof verifyVersion>[0]): string[] {
  return verifyVersion(input).checks.map(({ id, status, code }) => `${id} ${status} ${code}`);
}

const fixedSpec = {
  ...baseSpec(4),
  weighting: { type: "fixed", weightsBps: [4000, 3000, 2250, 750] },
  constraints: { maxWeightBps: 4000 },
};

describe("verifyVersion", () => {
  test("passes C1 to C5 for a correctly published version", () => {
    const report = verifyVersion(published(fixedSpec));
    expect(report.conformant).toBe(true);
    expect(report.checks.map(({ id }) => id)).toEqual(["C1", "C2", "C3", "C4", "C5"]);
    expect(report.checks.every(({ status, code }) => status === "pass" && code === "ok")).toBe(true);
    expect(report.specErrors).toEqual([]);
    expect<unknown>(report.spec).toEqual(fixedSpec);
    for (const check of report.checks) {
      expect(check.title.length).toBeGreaterThan(10);
      expect(check.reason.length).toBeGreaterThan(10);
    }
  });

  test("accepts checksummed addresses and an uppercase hash, as chain clients return them", () => {
    const input = published(baseSpec(2));
    const constituents = input.constituents.map(({ token, weightBps }) => ({
      token: token.toUpperCase().replace("0X", "0x"),
      weightBps,
    }));
    const hash = input.specHash.toUpperCase().replace("0X", "0x");
    expect(verifyVersion({ ...input, constituents, specHash: hash }).conformant).toBe(true);
  });

  test("C1 fails when the hash is not the hash of the bytes, and the other checks still run", () => {
    const input = published(baseSpec(2));
    const other = specHash(utf8("other"));
    expect(summary({ ...input, specHash: other })).toEqual([
      "C1 fail hash_mismatch",
      "C2 pass ok",
      "C3 pass ok",
      "C4 pass ok",
      "C5 pass ok",
    ]);
    expect(verifyVersion({ ...input, specHash: other }).conformant).toBe(false);
  });

  test("C1 fails when a single byte of the spec changes", () => {
    const input = published(baseSpec(2));
    const tampered = Uint8Array.from(input.specBytes);
    tampered[tampered.length - 2] = 0x20;
    expect(summary({ ...input, specBytes: tampered })[0]).toBe("C1 fail hash_mismatch");
  });

  test("C1 fails on a malformed hash", () => {
    const input = published(baseSpec(2));
    for (const malformed of ["", "0x", input.specHash.slice(2), input.specHash.slice(0, 64), `${input.specHash}00`]) {
      expect(summary({ ...input, specHash: malformed })[0]).toBe("C1 fail invalid_spec_hash");
    }
  });

  test("C2 fails on bytes that are not UTF-8 JSON without duplicate keys, and nothing later is evaluated", () => {
    const cases: [Uint8Array, string][] = [
      [Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]), "invalid_utf8"],
      [utf8('{"a":1'), "invalid_json"],
      [new Uint8Array(), "invalid_json"],
      [utf8('{"a":1,"a":2}'), "duplicate_key"],
      [utf8("[".repeat(100) + "]".repeat(100)), "too_deep"],
    ];
    for (const [bytes, code] of cases) {
      const report = verifyVersion(publishedBytes(bytes));
      expect(report.checks.map(({ id, status, code: reported }) => `${id} ${status} ${reported}`)).toEqual([
        "C1 pass ok",
        `C2 fail ${code}`,
        "C3 skipped skipped",
        "C4 skipped skipped",
        "C5 skipped skipped",
      ]);
      expect(report.conformant).toBe(false);
      expect(report.spec).toBeUndefined();
    }
  });

  test("C2 fails on a duplicate key even when both spellings of the document are otherwise valid", () => {
    const canonical = new TextDecoder().decode(published(baseSpec(2)).specBytes);
    const duplicated = canonical.replace('"chainId":8453,', '"chainId":8453,"chainId":8453,');
    expect(summary(publishedBytes(utf8(duplicated)))[1]).toBe("C2 fail duplicate_key");
  });

  test("C3 fails on valid JSON that is not canonical, and nothing later is evaluated", () => {
    const spec = baseSpec(2);
    const canonical = new TextDecoder().decode(canonicalize(spec));
    const cases: [string, string][] = [
      [JSON.stringify(spec), "not_canonical"],
      [JSON.stringify(spec, null, 2), "not_canonical"],
      [`${canonical}\n`, "not_canonical"],
      [canonical.replace('"chainId":8453', '"chainId":8453.0'), "not_canonical"],
      [canonical.replace('"chainId":8453', '"chainId":8453.5'), "unsupported_value"],
      [canonical.replace('"description":"A test index."', '"description":null'), "unsupported_value"],
    ];
    for (const [text, code] of cases) {
      expect(summary(publishedBytes(utf8(text)))).toEqual([
        "C1 pass ok",
        "C2 pass ok",
        `C3 fail ${code}`,
        "C4 skipped skipped",
        "C5 skipped skipped",
      ]);
    }
  });

  test("C4 fails on a canonical document that violates the schema, and reports every violation", () => {
    const invalid = { ...baseSpec(2), slug: "Not A Slug", extra: true };
    const report = verifyVersion(publishedBytes(canonicalize(invalid)));
    expect(report.checks.map(({ id, status, code }) => `${id} ${status} ${code}`)).toEqual([
      "C1 pass ok",
      "C2 pass ok",
      "C3 pass ok",
      "C4 fail schema_violation",
      "C5 skipped skipped",
    ]);
    expect(report.specErrors.map(({ path, code }) => `${path} ${code}`)).toEqual([
      "/extra unknown_property",
      "/slug invalid_slug",
    ]);
    expect(report.checks[3]?.reason).toContain("/extra");
    expect(report.checks[3]?.reason).toContain("1 more");
    expect(report.spec).toBeUndefined();
  });

  test("C4 names the document itself when the only violation is at its root", () => {
    const report = verifyVersion(publishedBytes(canonicalize([1, 2])));
    expect(report.checks[3]?.code).toBe("schema_violation");
    expect(report.specErrors.map(({ path }) => path)).toEqual([""]);
    expect(report.checks[3]?.reason).toStartWith("document: ");
    expect(report.checks[3]?.reason).not.toContain("more");
  });

  test("C4 reports an unsupported schema or calc as such and computes nothing", () => {
    const otherSchema = verifyVersion(publishedBytes(canonicalize({ ...baseSpec(2), schema: "equityos.index/2" })));
    expect(otherSchema.checks.slice(3).map(({ status, code }) => `${status} ${code}`)).toEqual([
      "fail unsupported_schema",
      "skipped skipped",
    ]);
    const otherCalc = verifyVersion(publishedBytes(canonicalize({ ...baseSpec(2), calc: "equityos.calc/2" })));
    expect(otherCalc.checks.slice(3).map(({ status, code }) => `${status} ${code}`)).toEqual([
      "fail unsupported_calc",
      "skipped skipped",
    ]);
  });

  test("C4 fails when the spec is for another chain", () => {
    const input = published(baseSpec(2));
    expect(summary({ ...input, chainId: 84_532 })).toEqual([
      "C1 pass ok",
      "C2 pass ok",
      "C3 pass ok",
      "C4 fail chain_mismatch",
      "C5 skipped skipped",
    ]);
  });

  describe("C5", () => {
    const input = published(fixedSpec);
    const c5 = (constituents: readonly { token: string; weightBps: number }[]) =>
      summary({ ...input, constituents }).slice(3);
    const replace = (index: number, change: Partial<Constituent>) =>
      input.constituents.map((constituent, i) => (i === index ? { ...constituent, ...change } : constituent));

    test("expects fixed weights exactly as the spec states them", () => {
      expect(input.constituents.map(({ weightBps }) => weightBps)).toEqual([4000, 3000, 2250, 750]);
      const swapped = input.constituents.map(({ token }, i) => ({ token, weightBps: [3000, 4000, 2250, 750][i] ?? 0 }));
      expect(c5(swapped)).toEqual(["C4 pass ok", "C5 fail weight_mismatch"]);
    });

    test("expects the rounded equal weights of an equal-weight spec", () => {
      const equal = published(baseSpec(3));
      const weights = (weightsBps: readonly number[]) =>
        equal.constituents.map(({ token }, i) => ({ token, weightBps: weightsBps[i] ?? 0 }));
      expect(summary({ ...equal, constituents: weights([3334, 3333, 3333]) })[4]).toBe("C5 pass ok");
      expect(summary({ ...equal, constituents: weights([3333, 3334, 3333]) })[4]).toBe("C5 fail weight_mismatch");
      expect(summary({ ...equal, constituents: weights([3333, 3333, 3334]) })[4]).toBe("C5 fail weight_mismatch");
    });

    test("fails on a different number of constituents", () => {
      expect(c5(input.constituents.slice(1))).toEqual(["C4 pass ok", "C5 fail constituent_count_mismatch"]);
      expect(c5([])).toEqual(["C4 pass ok", "C5 fail constituent_count_mismatch"]);
      const extra = [...input.constituents, { token: address(0xffff), weightBps: 1 }];
      expect(c5(extra)).toEqual(["C4 pass ok", "C5 fail constituent_count_mismatch"]);
    });

    test("fails on a different token or a different order", () => {
      expect(c5(replace(2, { token: address(0xdead) }))).toEqual(["C4 pass ok", "C5 fail token_mismatch"]);
      expect(c5([...input.constituents].reverse())).toEqual(["C4 pass ok", "C5 fail token_mismatch"]);
    });

    test("fails on a weight that differs by one basis point", () => {
      const shifted = input.constituents.map(({ token, weightBps }, i) => ({
        token,
        weightBps: weightBps + (i === 0 ? -1 : i === 1 ? 1 : 0),
      }));
      expect(c5(shifted)).toEqual(["C4 pass ok", "C5 fail weight_mismatch"]);
    });

    test("fails on a zero weight, the mirror of a version published without weights", () => {
      const zeroed = input.constituents.map(({ token }) => ({ token, weightBps: 0 }));
      expect(c5(zeroed)).toEqual(["C4 pass ok", "C5 fail weight_mismatch"]);
    });

    test("fails on a constituent that is not an address with an integer weight", () => {
      const malformed = [{ token: "0x1234" }, { token: input.constituents[0]?.token.slice(2) }, { weightBps: 4000.5 }];
      for (const change of malformed) {
        const constituents = input.constituents.map((constituent, i) =>
          i === 0 ? { ...constituent, ...change } : constituent,
        );
        expect(c5(constituents.map(({ token, weightBps }) => ({ token: token ?? "", weightBps })))).toEqual([
          "C4 pass ok",
          "C5 fail invalid_constituent",
        ]);
      }
    });
  });
});

describe("verifyVersion reasons", () => {
  const input = published(fixedSpec);
  const [first] = input.constituents;
  if (first === undefined) throw new Error("no constituent");
  const reasons = (report: ReturnType<typeof verifyVersion>) => report.checks.map(({ reason }) => reason);

  test("a conformant version states what was checked", () => {
    const report = verifyVersion(input);
    expect(report.conformant).toBe(true);
    expect(report.spec).toBeDefined();
    expect(reasons(report)).toEqual([
      `keccak256 of the ${input.specBytes.length} bytes is ${input.specHash}`,
      "well-formed UTF-8, one JSON value, no duplicate property names",
      "the bytes equal the canonical serialization of the parsed value",
      "valid equityos.index/1 document for chain 8453",
      "4 constituents match the spec in order and weight",
    ]);
  });

  test("C1 names both hashes, and rejects a hash with anything before or after its 64 digits", () => {
    const other = `0x${"ab".repeat(32)}`;
    expect(verifyVersion({ ...input, specHash: other }).checks[0]?.reason).toBe(
      `keccak256 of the bytes is ${input.specHash}, the published hash is ${other}`,
    );
    for (const malformed of [`x${input.specHash}`, `${input.specHash}0`, input.specHash.slice(0, -1)]) {
      const check = verifyVersion({ ...input, specHash: malformed }).checks[0];
      expect(check?.code).toBe("invalid_spec_hash");
      expect(check?.reason).toBe("the published hash is not 32 bytes of hexadecimal");
    }
  });

  test("a check that is not evaluated names the check it needed", () => {
    const malformed = verifyVersion(publishedBytes(utf8('{"a":1,"a":2}')));
    expect(malformed.conformant).toBe(false);
    expect(malformed.specErrors).toEqual([]);
    expect(malformed.spec).toBeUndefined();
    expect(reasons(malformed).slice(2)).toEqual([
      "not evaluated because C2 did not pass",
      "not evaluated because C3 did not pass",
      "not evaluated because C4 did not pass",
    ]);
    const spaced = verifyVersion(publishedBytes(utf8('{ "a": 1 }')));
    expect(spaced.conformant).toBe(false);
    expect(spaced.specErrors).toEqual([]);
    expect(reasons(spaced).slice(3)).toEqual([
      "not evaluated because C3 did not pass",
      "not evaluated because C4 did not pass",
    ]);
  });

  test("C4 names both chains and keeps the spec, and C5 is not evaluated", () => {
    const report = verifyVersion({ ...input, chainId: 84532 });
    expect(report.conformant).toBe(false);
    expect(report.spec).toBeDefined();
    expect(report.specErrors).toEqual([]);
    expect(reasons(report).slice(3)).toEqual([
      "the spec is for chain 8453, the version was read from chain 84532",
      "not evaluated because C4 did not pass",
    ]);
  });

  test("C5 names the constituent and both values that differ", () => {
    const c5 = (constituents: readonly { token: string; weightBps: number }[]) =>
      verifyVersion({ ...input, constituents }).checks[4]?.reason;
    expect(c5(input.constituents.slice(1))).toBe("the spec implies 4 constituents, 3 are published");
    const rest = input.constituents.slice(1);
    expect(c5([{ ...first, token: address(0xdead) }, ...rest])).toBe(
      `constituent 0 is ${address(0xdead)}, the spec implies ${first.token}`,
    );
    expect(c5([{ ...first, weightBps: first.weightBps - 1 }, ...rest])).toBe(
      `${first.token} is published at ${first.weightBps - 1} bps, the spec implies ${first.weightBps} bps`,
    );
    for (const token of [`${first.token}0`, `x${first.token}`, first.token.slice(0, -1)]) {
      expect(c5([{ ...first, token }, ...rest])).toBe("constituent 0 is not an address with an integer weight");
    }
    expect(c5([{ ...first, weightBps: 0.5 }, ...rest])).toBe("constituent 0 is not an address with an integer weight");
  });
});

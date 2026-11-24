import { describe, expect, test } from "bun:test";
import {
  array,
  boolean,
  constant,
  DecodeFailure,
  enumOf,
  hex,
  integer,
  literal,
  nullable,
  object,
  uint,
  union,
} from "../src/decode.ts";

function failure(run: () => unknown): DecodeFailure {
  try {
    run();
  } catch (error) {
    if (error instanceof DecodeFailure) return error;
    throw error;
  }
  throw new Error("expected a DecodeFailure");
}

describe("uint", () => {
  test("decodes a decimal string to bigint, beyond the safe integer range", () => {
    expect(uint().decode("0", "")).toBe(0n);
    expect(uint().decode("36893488147419104856", "")).toBe(36893488147419104856n);
  });

  test("refuses a number, a sign, a fraction, an exponent, a leading zero and hex", () => {
    for (const value of [12, "-1", "+1", "1.5", "1e3", "01", "0x10", "", " 1"]) {
      expect(failure(() => uint().decode(value, "priceE8")).path).toBe("priceE8");
    }
  });
});

describe("integer", () => {
  test("accepts a safe integer and refuses a fraction, a string and an unsafe integer", () => {
    expect(integer().decode(-10_000, "")).toBe(-10_000);
    for (const value of [1.5, "1", 2 ** 53]) expect(() => integer().decode(value, "")).toThrow(DecodeFailure);
  });
});

describe("object", () => {
  const decoder = object({ a: integer(), b: nullable(boolean()), c: integer() }, ["c"]);

  test("decodes required, nullable and optional properties and drops unknown ones", () => {
    expect(decoder.decode({ a: 1, b: null, extra: "x" }, "")).toEqual({ a: 1, b: null });
    expect(decoder.decode({ a: 1, b: true, c: 2 }, "")).toEqual({ a: 1, b: true, c: 2 });
  });

  test("a missing required property and a null optional one fail at their path", () => {
    expect(failure(() => decoder.decode({ a: 1 }, "data")).path).toBe("data.b");
    expect(failure(() => decoder.decode({ a: 1, b: null, c: null }, "data")).path).toBe("data.c");
    expect(() => decoder.decode([], "")).toThrow(DecodeFailure);
  });

  test("an array locates the failing item", () => {
    expect(failure(() => array(object({ x: uint() })).decode([{ x: "1" }, { x: 2 }], "data")).path).toBe("data[1].x");
  });
});

describe("enumerations and constants", () => {
  test("an enumeration and a string constant keep a value they do not know", () => {
    expect(enumOf(["a", "b"]).decode("c", "")).toBe("c");
    expect(constant("chainlink").decode("another_source", "")).toBe("another_source");
    expect(() => enumOf(["a"]).decode(1, "")).toThrow(DecodeFailure);
  });

  test("a literal accepts its value only", () => {
    expect(literal(false).decode(false, "")).toBe(false);
    expect(() => literal(false).decode(true, "")).toThrow(DecodeFailure);
  });
});

describe("union", () => {
  const decoder = union("status", {
    ready: object({ status: literal("ready"), legs: array(integer()) }),
    blocked: object({ status: literal("blocked") }),
  });

  test("chooses the option by the discriminant", () => {
    expect(decoder.decode({ status: "ready", legs: [1] }, "")).toEqual({ status: "ready", legs: [1] });
    expect(decoder.decode({ status: "blocked" }, "")).toEqual({ status: "blocked" });
  });

  test("an unknown discriminant fails, since the option cannot be decoded", () => {
    expect(failure(() => decoder.decode({ status: "queued" }, "plan")).path).toBe("plan.status");
  });
});

describe("hex", () => {
  test("accepts 0x and hexadecimal digits only", () => {
    expect(hex().decode("0xAbC0", "")).toBe("0xAbC0");
    for (const value of ["abc", "0xg", 1]) expect(() => hex().decode(value, "")).toThrow(DecodeFailure);
  });
});

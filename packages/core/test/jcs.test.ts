import { describe, expect, test } from "bun:test";
import referenceCanonicalize from "canonicalize";
import {
  type CanonicalErrorCode,
  CanonicalizationError,
  canonicalize,
  MAX_DEPTH,
  parseCanonical,
} from "../src/index.ts";
import { createRandom, utf8 } from "./helpers.ts";

const BACKSLASH = String.fromCharCode(0x5c);
/** Starts a JSON `\uXXXX` escape in a test input. */
const U = `${BACKSLASH}u`;
const LONE_HIGH_SURROGATE = String.fromCharCode(0xd83d);
const LONE_LOW_SURROGATE = String.fromCharCode(0xde00);

function text(value: unknown): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(canonicalize(value));
}

function errorCode(run: () => unknown): CanonicalErrorCode | "no error" {
  try {
    run();
  } catch (error) {
    if (error instanceof CanonicalizationError) return error.code;
    throw error;
  }
  return "no error";
}

function parseCode(input: string | Uint8Array): CanonicalErrorCode | "ok" {
  const result = parseCanonical(typeof input === "string" ? utf8(input) : input);
  return result.ok ? "ok" : result.code;
}

describe("canonicalize", () => {
  test("writes no whitespace and keeps array order", () => {
    expect(text({ b: [3, 1, 2], a: { d: true, c: false } })).toBe('{"a":{"c":false,"d":true},"b":[3,1,2]}');
    expect(text([])).toBe("[]");
    expect(text({})).toBe("{}");
    expect(text("")).toBe('""');
  });

  // RFC 8785 section 3.2.3: the expected order is by UTF-16 code units, which puts the emoji
  // (surrogates d83d de00) before U+FB33 although its code point U+1F600 is larger.
  test("sorts property names by UTF-16 code units (RFC 8785 section 3.2.3)", () => {
    const euro = String.fromCharCode(0x20ac);
    const dalet = String.fromCharCode(0xfb33);
    const emoji = String.fromCodePoint(0x1f600);
    const control = String.fromCharCode(0x80);
    const oDiaeresis = String.fromCharCode(0xf6);
    const input = {
      [euro]: "Euro Sign",
      "\r": "Carriage Return",
      [dalet]: "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      [emoji]: "Emoji: Grinning Face",
      [control]: "Control",
      [oDiaeresis]: "Latin Small Letter O With Diaeresis",
    };
    const expected =
      `{"${BACKSLASH}r":"Carriage Return","1":"One","${control}":"Control",` +
      `"${oDiaeresis}":"Latin Small Letter O With Diaeresis","${euro}":"Euro Sign",` +
      `"${emoji}":"Emoji: Grinning Face","${dalet}":"Hebrew Letter Dalet With Dagesh"}`;
    expect(text(input)).toBe(expected);
  });

  test("orders a prefix before its extensions and uppercase before lowercase", () => {
    expect(text({ aa: 1, a: 2, B: 3, "": 4, A: 5, a0: 6 })).toBe('{"":4,"A":5,"B":3,"a":2,"a0":6,"aa":1}');
  });

  test("does not depend on insertion order", () => {
    expect(text({ x: 1, y: { b: 1, a: 2 } })).toBe(text({ y: { a: 2, b: 1 }, x: 1 }));
  });

  // RFC 8785 section 3.2.2.2, with the string of the example in section 3.2.2.
  test("escapes strings as RFC 8785 section 3.2.2.2 requires", () => {
    const value = `${String.fromCharCode(0x20ac)}$${String.fromCharCode(0x0f)}\nA'B"${BACKSLASH}${BACKSLASH}"/`;
    const expected = `"${String.fromCharCode(0x20ac)}$${U}000f${BACKSLASH}nA'B${BACKSLASH}"${BACKSLASH.repeat(4)}${BACKSLASH}"/"`;
    expect(text(value)).toBe(expected);
  });

  test("uses the short escape where one exists and lowercase hexadecimal otherwise", () => {
    const controls = Array.from({ length: 0x20 }, (_, unit) => String.fromCharCode(unit)).join("");
    const short = new Map([
      [0x08, "b"],
      [0x09, "t"],
      [0x0a, "n"],
      [0x0c, "f"],
      [0x0d, "r"],
    ]);
    const expected = Array.from({ length: 0x20 }, (_, unit) => {
      const letter = short.get(unit);
      return letter === undefined ? `${U}${unit.toString(16).padStart(4, "0")}` : `${BACKSLASH}${letter}`;
    }).join("");
    expect(text(controls)).toBe(`"${expected}"`);
  });

  test("leaves the solidus, DEL and every non-ASCII character unescaped", () => {
    const value = `/${String.fromCharCode(0x7f, 0x80, 0x2028, 0x2029, 0xffff)}${String.fromCodePoint(0x10ffff)}`;
    expect(text(value)).toBe(`"${value}"`);
  });

  test("encodes one to four byte UTF-8 sequences", () => {
    const value = `a${String.fromCharCode(0xe9, 0x20ac)}${String.fromCodePoint(0x1f600)}`;
    expect([...canonicalize(value)]).toEqual([0x22, 0x61, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80, 0x22]);
  });

  test("writes safe integers as decimal digits and negative zero as 0", () => {
    const values = [0, -0, 1, -1, 10, 1e21 / 1e9, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];
    expect(text(values)).toBe("[0,0,1,-1,10,1000000000000,9007199254740991,-9007199254740991]");
  });

  test("rejects numbers that are not safe integers", () => {
    for (const value of [1.5, 0.1, 2 ** 53, -(2 ** 53), 1e21, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(errorCode(() => canonicalize([value]))).toBe("unsupported_value");
    }
  });

  test("rejects null, undefined and values that are not JSON", () => {
    class Instance {
      readonly a = 1;
    }
    const withSymbolKey = { a: 1, [Symbol("key")]: 2 };
    const unsupported = [
      null,
      undefined,
      1n,
      () => 1,
      Symbol("s"),
      new Date(0),
      new Map(),
      new Instance(),
      withSymbolKey,
    ];
    for (const value of unsupported) {
      expect(errorCode(() => canonicalize(value))).toBe("unsupported_value");
      expect(errorCode(() => canonicalize({ a: [value] }))).toBe("unsupported_value");
    }
  });

  test("rejects a hole in a sparse array", () => {
    const sparse: number[] = [];
    sparse[2] = 1;
    expect(errorCode(() => canonicalize(sparse))).toBe("unsupported_value");
  });

  test("accepts an object without prototype", () => {
    const bare: Record<string, unknown> = Object.create(null);
    bare.b = 1;
    bare.a = 2;
    expect(text(bare)).toBe('{"a":2,"b":1}');
  });

  test("rejects lone surrogates in strings and in property names", () => {
    for (const lone of [LONE_HIGH_SURROGATE, LONE_LOW_SURROGATE, `${LONE_LOW_SURROGATE}${LONE_HIGH_SURROGATE}`]) {
      expect(errorCode(() => canonicalize(`a${lone}b`))).toBe("lone_surrogate");
      expect(errorCode(() => canonicalize({ [`a${lone}`]: 1 }))).toBe("lone_surrogate");
    }
    expect(errorCode(() => canonicalize(`${LONE_HIGH_SURROGATE}${LONE_LOW_SURROGATE}`))).toBe("no error");
  });

  test("rejects nesting beyond MAX_DEPTH, including cycles", () => {
    const nest = (depth: number): unknown => (depth === 0 ? 1 : [nest(depth - 1)]);
    expect(errorCode(() => canonicalize(nest(MAX_DEPTH)))).toBe("no error");
    expect(errorCode(() => canonicalize(nest(MAX_DEPTH + 1)))).toBe("too_deep");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(errorCode(() => canonicalize(cycle))).toBe("too_deep");
  });
});

/** Random values of the supported space, biased towards the characters and names that are easy to get wrong. */
function randomValue(random: (bound: number) => number, depth: number): unknown {
  const kind = random(depth >= 4 ? 4 : 6);
  if (kind === 0) return randomString(random);
  if (kind === 1) return random(2) === 0;
  if (kind === 2)
    return random(2) === 0 ? random(1000) - 500 : (random(2) === 0 ? 1 : -1) * (2 ** 53 - 1 - random(1000));
  if (kind === 3) return random(2 ** 31) * 2 ** 21 + random(2 ** 21);
  if (kind === 4) return Array.from({ length: random(4) }, () => randomValue(random, depth + 1));
  const members: Record<string, unknown> = {};
  for (let i = random(5); i > 0; i--) {
    Object.defineProperty(members, randomString(random), {
      value: randomValue(random, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return members;
}

function randomString(random: (bound: number) => number): string {
  const alphabet = [0x00, 0x08, 0x0a, 0x1f, 0x20, 0x22, 0x2f, 0x41, 0x5c, 0x61, 0x7f, 0x80, 0xe9, 0x7ff, 0x800, 0x20ac];
  let out = "";
  for (let i = random(6); i > 0; i--) {
    const pick = random(alphabet.length + 3);
    if (pick < alphabet.length) out += String.fromCharCode(alphabet[pick] ?? 0x61);
    else if (pick === alphabet.length) out += String.fromCharCode(0xe000 + random(0x1fff));
    else if (pick === alphabet.length + 1) out += String.fromCodePoint(0x10000 + random(0x100000));
    else out += "__proto__";
  }
  return out;
}

describe("canonicalize against independent implementations", () => {
  test("agrees with the canonicalize package on 3000 random values", () => {
    const random = createRandom(8785);
    for (let i = 0; i < 3000; i++) {
      const value = randomValue(random, 0);
      const expected = referenceCanonicalize(value);
      if (expected === undefined) throw new Error("the reference produced no output");
      expect(canonicalize(value)).toEqual(utf8(expected));
    }
  });

  test("canonical output parses back to the same value and is a fixed point", () => {
    const random = createRandom(3629);
    for (let i = 0; i < 3000; i++) {
      const value = randomValue(random, 0);
      const bytes = canonicalize(value);
      const parsed = parseCanonical(bytes);
      if (!parsed.ok) throw new Error(`rejected canonical output: ${parsed.message}`);
      expect(canonicalize(parsed.value)).toEqual(bytes);
      expect(parsed.value).toEqual(JSON.parse(new TextDecoder().decode(bytes)));
    }
  });
});

describe("parseCanonical", () => {
  test("accepts canonical bytes and returns the value", () => {
    const result = parseCanonical(utf8('{"a":[1,true,"x"],"b":{}}'));
    expect(result).toEqual({ ok: true, value: { a: [1, true, "x"], b: {} } });
  });

  test("rejects duplicate property names, including ones that differ only by escaping", () => {
    expect(parseCode('{"a":1,"a":2}')).toBe("duplicate_key");
    expect(parseCode('{"a":1,"a":1}')).toBe("duplicate_key");
    expect(parseCode(`{"a":1,"${U}0061":2}`)).toBe("duplicate_key");
    expect(parseCode('{"a":{"b":1,"b":2}}')).toBe("duplicate_key");
    expect(parseCode('{"a":{"b":1},"c":{"b":2}}')).toBe("ok");
  });

  test("keeps names of Object.prototype members as ordinary properties", () => {
    const result = parseCanonical(utf8('{"__proto__":{"polluted":true},"constructor":1,"toString":2}'));
    if (!result.ok) throw new Error(result.message);
    expect(Object.keys(Object(result.value))).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(Object.hasOwn({}, "polluted")).toBe(false);
    expect(parseCode('{"__proto__":1,"__proto__":2}')).toBe("duplicate_key");
  });

  test("rejects every non-canonical spelling of a canonical document", () => {
    const spellings = [
      '{"a": 1}',
      ' {"a":1}',
      '{"a":1}\n',
      '{"b":1,"a":2}',
      "[1.0]",
      "[1e0]",
      "[-0]",
      "[10E-1]",
      `["${BACKSLASH}/"]`,
      `["${U}0041"]`,
      `["${U}00e9"]`,
      `["${U}000a"]`,
      `["${U}001F"]`,
      `["${U}d83d${U}de00"]`,
    ];
    for (const spelling of spellings) expect(parseCode(spelling)).toBe("not_canonical");
  });

  test("rejects code point order where it differs from UTF-16 code unit order", () => {
    const dalet = String.fromCharCode(0xfb33);
    const emoji = String.fromCodePoint(0x1f600);
    expect(parseCode(`{"${emoji}":1,"${dalet}":2}`)).toBe("ok");
    expect(parseCode(`{"${dalet}":2,"${emoji}":1}`)).toBe("not_canonical");
  });

  test("rejects JSON values outside the supported space", () => {
    for (const input of ["null", "[null]", "1.5", "[9007199254740992]", "1e400", '{"a":0.1}']) {
      expect(parseCode(input)).toBe("unsupported_value");
    }
  });

  test("rejects text that is not JSON", () => {
    const malformed = [
      "",
      " ",
      "{",
      "[1,]",
      '{"a":1,}',
      "{a:1}",
      "['a']",
      "01",
      "+1",
      "1.",
      ".5",
      "0x10",
      "tru",
      "{}{}",
    ];
    const strings = ['"a', `"${BACKSLASH}x"`, `"${U}12g4"`, `"${U}12"`, '"a\nb"', `"${String.fromCharCode(0x1f)}"`];
    for (const input of [...malformed, ...strings, "[1 2]", '{"a" 1}', '{"a":1 "b":2}', "undefined", "NaN"]) {
      expect(parseCode(input)).toBe("invalid_json");
    }
  });

  test("rejects a byte order mark and other non-JSON whitespace", () => {
    expect(parseCode(Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toBe("invalid_json");
    expect(parseCode(`${String.fromCharCode(0xa0)}{}`)).toBe("invalid_json");
    expect(parseCode(`{}${String.fromCharCode(0x0b)}`)).toBe("invalid_json");
  });

  test("rejects escaped lone surrogates", () => {
    expect(parseCode(`["${U}d83d"]`)).toBe("lone_surrogate");
    expect(parseCode(`["${U}de00${U}d83d"]`)).toBe("lone_surrogate");
    expect(parseCode(`{"${U}dc00":1}`)).toBe("lone_surrogate");
  });

  test("bounds nesting instead of exhausting the stack", () => {
    expect(parseCode("[".repeat(MAX_DEPTH) + "]".repeat(MAX_DEPTH))).toBe("ok");
    expect(parseCode("[".repeat(MAX_DEPTH + 1) + "]".repeat(MAX_DEPTH + 1))).toBe("too_deep");
    expect(parseCode("[".repeat(200_000))).toBe("too_deep");
    expect(parseCode('{"a":'.repeat(MAX_DEPTH + 1))).toBe("too_deep");
  });

  test("rejects ill-formed UTF-8", () => {
    const illFormed = [
      [0x80],
      [0xbf],
      [0xc0, 0xaf],
      [0xc1, 0xbf],
      [0xc3],
      [0xc3, 0x28],
      [0xe0, 0x80, 0xaf],
      [0xe0, 0x9f, 0xbf],
      [0xe2, 0x82],
      [0xed, 0xa0, 0x80],
      [0xed, 0xbf, 0xbf],
      [0xf0, 0x80, 0x80, 0xaf],
      [0xf0, 0x8f, 0xbf, 0xbf],
      [0xf4, 0x90, 0x80, 0x80],
      [0xf5, 0x80, 0x80, 0x80],
      [0xf8, 0x88, 0x80, 0x80, 0x80],
      [0xfe],
      [0xff],
    ];
    for (const bytes of illFormed) {
      expect(parseCode(Uint8Array.from([0x22, ...bytes, 0x22]))).toBe("invalid_utf8");
      expect(parseCode(Uint8Array.from([0x22, 0x22, ...bytes]))).toBe("invalid_utf8");
    }
  });

  test("accepts the boundary code points of each UTF-8 length", () => {
    for (const codePoint of [0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x10000, 0x10ffff]) {
      expect(parseCode(`"${String.fromCodePoint(codePoint)}"`)).toBe("ok");
    }
  });

  test("decodes UTF-8 exactly like a fatal TextDecoder on 20000 random byte strings", () => {
    const random = createRandom(2279);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const leads = [0x61, 0x7f, 0x80, 0xbf, 0xc0, 0xc2, 0xdf, 0xe0, 0xe1, 0xed, 0xef, 0xf0, 0xf1, 0xf4, 0xf5, 0xff];
    const tails = [0x61, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0];
    for (let i = 0; i < 20_000; i++) {
      const body = Array.from({ length: 1 + random(5) }, (_, k) => {
        const pool = k === 0 || random(4) === 0 ? leads : tails;
        return pool[random(pool.length)] ?? 0x61;
      });
      const bytes = Uint8Array.from([0x22, ...body, 0x22]);
      let wellFormed = true;
      try {
        decoder.decode(bytes);
      } catch {
        wellFormed = false;
      }
      expect(parseCode(bytes) !== "invalid_utf8").toBe(wellFormed);
    }
  });

  test("accepts and rejects the same texts as JSON.parse on 20000 mutated documents", () => {
    const random = createRandom(8259);
    const fragments = [
      '"',
      BACKSLASH,
      "u",
      "0",
      "1",
      "e",
      "E",
      "-",
      "+",
      ".",
      ",",
      ":",
      "{",
      "}",
      "[",
      "]",
      " ",
      "\n",
      "a",
      "true",
      "null",
      "d800",
      "/",
    ];
    for (let i = 0; i < 20_000; i++) {
      const source = JSON.stringify(randomValue(random, 0), null, random(2));
      const at = random(source.length + 1);
      const mutated = source.slice(0, at) + (fragments[random(fragments.length)] ?? "") + source.slice(at + random(2));
      let reference = true;
      try {
        JSON.parse(mutated);
      } catch {
        reference = false;
      }
      // Duplicate names, lone surrogates and excessive depth are valid for JSON.parse and rejected here on
      // purpose. They can also be reported for a text that is malformed further on.
      const code = parseCode(mutated);
      if (reference) expect(code).not.toBe("invalid_json");
      else expect(["invalid_json", "duplicate_key", "lone_surrogate", "too_deep"]).toContain(code);
    }
  });
});

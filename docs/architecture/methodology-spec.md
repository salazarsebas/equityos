# Methodology spec `equityos.index/1`

An index is defined by one JSON document, the methodology spec. Its canonical bytes are hashed with keccak256,
and that hash identifies the methodology. This page specifies the document, its canonical form, the hash, the
weight calculation `equityos.calc/1` and the conformance checks, in enough detail to write a second
implementation that agrees with the reference one byte for byte.

The reference implementation is `@equityos/core` (`packages/core`). It is pure: it reads no chain, file or
clock. Test vectors are published in `packages/core/vectors` and described [below](#test-vectors).

```
specBytes = UTF8(JCS(spec))        RFC 8785
specHash  = keccak256(specBytes)   32 bytes
```

## Document

Every property is required unless marked optional. No other property is allowed at any level, and `null` is
never a valid value.

| Property                       | Type             | Rule                                                                                      |
| ------------------------------ | ---------------- | ----------------------------------------------------------------------------------------- |
| `schema`                       | string           | Exactly `equityos.index/1`                                                                |
| `calc`                         | string           | Exactly `equityos.calc/1`                                                                 |
| `chainId`                      | integer          | EIP-155 chain id of the tokens and feeds, 1 to 2^53 - 1                                   |
| `name`                         | string           | 1 to 64 printable ASCII characters (U+0020 to U+007E)                                     |
| `slug`                         | string           | `^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$`                                                    |
| `description`                  | string           | Any Unicode text in Normalization Form C, may be empty                                    |
| `universe.type`                | string           | Exactly `static`                                                                          |
| `universe.tokens`              | array of address | 1 to 64 items, strictly ascending, none the zero address                                  |
| `weighting.type`               | string           | `equal` or `fixed`                                                                        |
| `weighting.weightsBps`         | array of integer | Only with `fixed`, and required: one per token, each 1 to 10000, summing to exactly 10000 |
| `constraints` (optional)       | object           | Bounds every weight must satisfy; at least one of the two below                           |
| `constraints.maxWeightBps`     | integer          | 1 to 10000; no weight may be above it                                                     |
| `constraints.minWeightBps`     | integer          | 1 to 10000; no weight may be below it                                                     |
| `pricing.source`               | string           | Exactly `chainlink-aggregator-v3`                                                         |
| `pricing.feeds`                | array of address | One per token, `feeds[i]` is the feed of `tokens[i]`                                      |
| `rebalance.trigger`            | string           | Exactly `drift`                                                                           |
| `rebalance.driftThresholdBps`  | integer          | 1 to 10000                                                                                |
| `rebalance.minIntervalSeconds` | integer          | 0 to 2^53 - 1                                                                             |
| `parent` (optional)            | object           | The version this spec was forked from; all five properties below                          |
| `parent.chainId`               | integer          | 1 to 2^53 - 1                                                                             |
| `parent.registry`              | address          |                                                                                           |
| `parent.indexId`               | bytes32          |                                                                                           |
| `parent.version`               | integer          | 1 to 2^32 - 1                                                                             |
| `parent.specHash`              | bytes32          |                                                                                           |

`n` is the number of tokens. Types:

- **integer**: a JSON number that is an integer with absolute value below 2^53. Weights and thresholds are in
  basis points (10000 bps = 100%), durations in seconds. There are no fractions anywhere in the document.
- **address**: a string matching `^0x[0-9a-f]{40}$`. Mixed-case (EIP-55) addresses are invalid, so an address
  has exactly one spelling.
- **bytes32**: a string matching `^0x[0-9a-f]{64}$`.

Addresses are compared as 160-bit numbers. Because they are lowercase and of equal length, comparing the
strings byte by byte gives the same order.

Two properties of the document follow from these rules and are worth stating:

- A single constituent is valid. Its weight is 10000 bps, so a `maxWeightBps` below 10000 makes the spec
  invalid.
- `constraints` are validation rules. They never change a weight: a published weight is exactly what the
  author wrote (`fixed`) or exactly equal (`equal`), and a spec whose weights break a bound is invalid.
- The creator, the version number and any timestamp are not part of the document, so the same methodology
  published twice has the same hash.

### JSON Schema and the rules beyond it

The JSON Schema (draft 2020-12) is published in the package as
`@equityos/core/schema/equityos.index-1.schema.json` (source:
`packages/core/src/schema/equityos.index-1.schema.json`) and exported as `INDEX_SPEC_JSON_SCHEMA`. It states
the structure: types, required and unknown properties, patterns, ranges and item counts.

A JSON Schema cannot express the following rules. A document is valid only if it satisfies the schema and all
of them:

1. `universe.tokens` is strictly ascending.
2. `pricing.feeds` has exactly `n` items.
3. `weighting.weightsBps` has exactly `n` items.
4. `weighting.weightsBps` sums to exactly 10000.
5. With `fixed` weighting, every weight satisfies `minWeightBps <= weightsBps[i] <= maxWeightBps`, for each
   bound that is present. The error names the index of the offending weight.
6. With `equal` weighting, `maxWeightBps * n >= 10000` and `minWeightBps * n <= 10000`, for each bound that
   is present. The equal weights are `floor(10000 / n)` or one more, so these two inequalities hold exactly
   when every rounded weight is within the bounds.
7. `description` equals its NFC normalization and contains no lone surrogate.
8. The canonical form is at most 8192 bytes.

`validateSpec` enforces the schema and these rules, and reports every violation as `{ path, code, message }`
where `path` is a JSON Pointer (RFC 6901) and `code` is stable. A document whose `schema` is not
`equityos.index/1` is reported as `unsupported_schema` and nothing else in it is interpreted.

### Limits

| Limit                     | Value      |
| ------------------------- | ---------- |
| Canonical form            | 8192 bytes |
| Constituents              | 1 to 64    |
| Nesting accepted on parse | 32 levels  |

The two limits are consistent. A constituent costs 90 bytes of canonical form (its token and its feed), plus
2 to 6 bytes with fixed weights. The largest document the schema allows apart from its description is 6801
bytes: 64 constituents, fixed weights written with the most digits they can have, a 64-character name, a
32-character slug, both bounds, a parent and every integer at its longest. That leaves at least 1391 bytes for
`description` in every valid spec.

## Canonical form

The canonical form is the JSON Canonicalization Scheme of RFC 8785, encoded as UTF-8. For this document it
reduces to:

- No whitespace between tokens.
- Object properties sorted by name, comparing names as sequences of UTF-16 code units. This differs from
  code point order for characters outside the Basic Multilingual Plane; property names of the spec are ASCII,
  so it only matters to a general implementation.
- Array order preserved.
- Integers as decimal digits with a leading `-` when negative: no fraction, no exponent, no leading zero, and
  zero is `0`. This is the whole of RFC 8785 number serialization that the document can reach, because it
  contains no other numbers.
- Strings in double quotes. `"` and `\` are escaped as `\"` and `\\`. U+0008, U+0009, U+000A, U+000C and U+000D
  are escaped as `\b`, `\t`, `\n`, `\f` and `\r`. Every other code point below U+0020 is escaped as `\u00xx`
  with lowercase hexadecimal digits. Everything else is written literally as UTF-8, including `/`, U+007F and
  all non-ASCII characters.
- Canonicalization does not normalize Unicode. That is why `description` is required to be NFC already.

The reference implementation supports exactly this value space: objects, arrays, strings, booleans and safe
integers. It rejects fractions, integers of magnitude 2^53 or more, `null`, lone surrogates and anything that
is not JSON.

### Parsing canonical bytes

`parseCanonical(bytes)` accepts bytes only if all of the following hold, and returns a coded failure otherwise:

| Code                | Meaning                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_utf8`      | Not well-formed UTF-8 (RFC 3629): truncated or overlong sequence, encoded surrogate, code point above U+10FFFF. A byte order mark is not skipped. |
| `invalid_json`      | Not exactly one JSON value (RFC 8259)                                                                                                             |
| `duplicate_key`     | An object has two properties with the same name, compared after unescaping                                                                        |
| `lone_surrogate`    | A string has an escaped surrogate that is not part of a pair                                                                                      |
| `too_deep`          | Arrays and objects nested more than 32 levels                                                                                                     |
| `unsupported_value` | A fraction, an integer of magnitude 2^53 or more, or `null`                                                                                       |
| `not_canonical`     | Re-canonicalizing the parsed value does not reproduce the input byte for byte                                                                     |

Do not use a general JSON parser for this step without checking its behavior: most keep the last of two
duplicate properties, and many decoders replace invalid UTF-8 instead of failing.

## Hash

`specHash` is Keccak-256 of the canonical bytes, the function the EVM exposes as `keccak256`. It is not NIST
SHA3-256, which uses different padding. It is written as `0x` followed by 64 lowercase hexadecimal digits.

Example, the vector `equal-3`. Its canonical form is this single line, with no whitespace and no final
newline:

```text
{"calc":"equityos.calc/1","chainId":8453,"description":"Test vector with 3 constituents.","name":"Test Index 3","pricing":{"feeds":["0xfeed000000000000000000000000000000000001","0xfeed000000000000000000000000000000000002","0xfeed000000000000000000000000000000000003"],"source":"chainlink-aggregator-v3"},"rebalance":{"driftThresholdBps":500,"minIntervalSeconds":604800,"trigger":"drift"},"schema":"equityos.index/1","slug":"test-index-3","universe":{"tokens":["0xb200000000000000000000000000000000000001","0xb200000000000000000000000000000000000002","0xb200000000000000000000000000000000000003"],"type":"static"},"weighting":{"type":"equal"}}
```

These 642 bytes hash to `0x0303f9e547c0c4b543d9c661f47bb6867f9048fbbd4bd66b8c37a88e4b3680e3`.

The hash therefore depends on the content of a spec and on nothing else. `packages/core/test/hash-properties.test.ts`
checks it over seeded random specs of 1 to 64 tokens: property order, whitespace and escapes in the JSON text and
a round trip through the canonical bytes leave the bytes and the hash unchanged, the bytes agree with an
independent RFC 8785 implementation, and a change to any part of the content changes the hash.

## Weight calculation `equityos.calc/1`

The calculation maps a valid spec to its constituents: each token of `universe.tokens`, in the same order,
with a weight in basis points. The weights are integers of at least 1 and sum to exactly 10000. All arithmetic
is on integers; no step uses floating point.

- **`fixed`**: the weight of `tokens[i]` is `weightsBps[i]`, unchanged.
- **`equal`**: with `n` tokens, every token gets `floor(10000 / n)` bps. Let `m = 10000 - n * floor(10000 / n)`
  be the basis points still missing. They are distributed one each by largest remainder, ties broken by
  ascending token address. All remainders are equal here, so the `m` lowest addresses get one more basis
  point.

`constraints` take no part in the calculation. The calculator never moves weight between constituents to
satisfy a bound, so a published weight can always be read off the spec: it is the number the author wrote, or
the equal share. A methodology that wants capped weights states weights that already respect the cap.

Examples, from the vectors:

| Vector                | Spec                                                   | Constituent weights in bps  |
| --------------------- | ------------------------------------------------------ | --------------------------- |
| `equal-3`             | 3 tokens, `equal`                                      | 3334, 3333, 3333            |
| `equal-7`             | 7 tokens, `equal`                                      | 1429 four times, then 1428  |
| `equal-64`            | 64 tokens, `equal`                                     | 157 sixteen times, then 156 |
| `fixed-within-bounds` | `fixed` 4000, 3000, 2250, 750 with bounds 750 and 4000 | 4000, 3000, 2250, 750       |

## Verifying a published version

A version is published as three values: the spec bytes, the spec hash and the list of constituents
(`token`, `weightBps`). Given those and the chain id they were read from, five checks decide whether the
version is conformant. They depend on nothing else, so their result never changes for a version.

| Check | Statement                                                                                                  |
| ----- | ---------------------------------------------------------------------------------------------------------- |
| C1    | `keccak256(specBytes)` equals the published hash                                                           |
| C2    | The bytes are well-formed UTF-8 and one JSON value without duplicate property names                        |
| C3    | The bytes equal the canonical form of the value they parse to                                              |
| C4    | The value is a valid `equityos.index/1` document and its `chainId` is the chain it was read from           |
| C5    | The published constituents are the tokens of the spec, in order, with the weights of the calculation above |

`verifyVersion({ specBytes, specHash, constituents, chainId })` returns the five results in order, each with
a `status` (`pass`, `fail` or `skipped`), a stable `code` and a `reason` for display, plus `conformant`, which
is true only if all five pass. C1 and C2 are always evaluated. C3 requires C2, C4 requires C3 and C5 requires
C4; a check whose requirement did not pass is `skipped`, so nothing is computed from a document that is not
known to be valid. In C5, token addresses are compared as numbers, so the letter case a chain client returns
does not matter.

A document with an unknown `schema` or `calc` fails C4 with `unsupported_schema` or `unsupported_calc`. An
implementation must report it as unsupported and must not compute weights for it.

These checks say nothing about the state of the chain: whether a token or a feed exists and is live is
time-dependent and is not covered here.

## Test vectors

All files are JSON under `packages/core/vectors`, and are importable as `@equityos/core/vectors/<file>`.
Hexadecimal values are `0x`-prefixed.

| File                   | Content                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `specs-valid.json`     | `vectors[]`: `name`, `description`, `spec`, `canonicalHex`, `specHash`, `constituents`     |
| `specs-invalid.json`   | `vectors[]`: `name`, `spec`, `error` (`path`, `code`), `jsonSchema`                        |
| `canonical-bytes.json` | `valid[]`: `name`, `json`, `canonical`, `canonicalHex`. `invalid[]`: `name`, `hex`, `code` |

- For each valid spec: canonicalizing `spec` gives `canonicalHex`, hashing those bytes gives `specHash`, and
  the calculation gives `constituents`.
- Each invalid spec breaks exactly one rule and `validateSpec` reports exactly the listed error. `jsonSchema`
  is `rejects` when the JSON Schema alone rejects the document and `accepts` when only one of the eight rules
  above does.
- `canonical-bytes.json` is independent of the spec. `valid` pairs a JSON text with its canonical form and
  includes the property sorting and string examples of RFC 8785. `invalid` lists byte sequences that
  `parseCanonical` must reject and the code it reports.

## Versioning

`schema` and `calc` are exact identifiers. Because unknown properties are rejected, there is no compatible
extension of a schema: any change to the document shape is a new `schema` identifier, and any change to the
calculation is a new `calc` identifier.

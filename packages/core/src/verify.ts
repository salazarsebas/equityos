/**
 * Conformance checks C1 to C5 of a published index version.
 *
 * The inputs are what a registry returns for one version (spec bytes, spec hash, constituents) and the
 * chain they were read from. Every check is a pure function of those inputs and its result never
 * changes for a given version. Checks that need the network, such as whether a token or a feed is
 * live, are not part of this module.
 */

import { specHash } from "./hash.ts";
import { type CanonicalErrorCode, parseCanonical } from "./jcs.ts";
import type { IndexSpec } from "./spec.ts";
import { type SpecError, validateSpec } from "./validate.ts";
import { computeConstituents } from "./weights.ts";

export type CheckId = "C1" | "C2" | "C3" | "C4" | "C5";

/** `skipped` means an earlier check failed and this one cannot be evaluated. It is never a success. */
export type CheckStatus = "pass" | "fail" | "skipped";

export type CheckCode =
  | "ok"
  | "skipped"
  /** C1: the expected hash is not `0x` followed by 64 hexadecimal digits. */
  | "invalid_spec_hash"
  | "hash_mismatch"
  /** C2 and C3: the reason `parseCanonical` rejected the bytes. */
  | CanonicalErrorCode
  | "unsupported_schema"
  | "unsupported_calc"
  | "schema_violation"
  | "chain_mismatch"
  /** C5: a constituent is not an address with an integer weight. */
  | "invalid_constituent"
  | "constituent_count_mismatch"
  | "token_mismatch"
  | "weight_mismatch";

export interface CheckResult {
  readonly id: CheckId;
  /** What the check establishes. */
  readonly title: string;
  readonly status: CheckStatus;
  readonly code: CheckCode;
  /** Why the check has this status, for display. */
  readonly reason: string;
}

/** A constituent as read from the registry. The address may be in any letter case. */
export interface PublishedConstituent {
  readonly token: string;
  readonly weightBps: number;
}

export interface VerificationInput {
  /** The stored spec, byte for byte. */
  readonly specBytes: Uint8Array;
  /** The hash the registry recorded for the version. */
  readonly specHash: string;
  /** The stored composition, in the order the registry returns it. */
  readonly constituents: readonly PublishedConstituent[];
  /** The chain the version was read from. */
  readonly chainId: number;
}

export interface VerificationReport {
  /** True only if C1 to C5 all pass. A client must not compute or execute against any other version. */
  readonly conformant: boolean;
  /** C1 to C5, in order. */
  readonly checks: readonly CheckResult[];
  /** The validated spec, present when the document passes schema validation. */
  readonly spec?: IndexSpec;
  /** Every schema violation found by C4. */
  readonly specErrors: readonly SpecError[];
}

const TITLES: Readonly<Record<CheckId, string>> = {
  C1: "The spec bytes hash to the published spec hash",
  C2: "The spec bytes are UTF-8 JSON without duplicate keys",
  C3: "The spec bytes are the canonical serialization",
  C4: "The spec is valid for its schema and for this chain",
  C5: "The published constituents are the ones the spec implies",
};

/** Failures of `parseCanonical` that mean the bytes are not acceptable JSON at all (C2), not merely non-canonical (C3). */
const MALFORMED: readonly CanonicalErrorCode[] = [
  "invalid_utf8",
  "invalid_json",
  "duplicate_key",
  "lone_surrogate",
  "too_deep",
];

function result(id: CheckId, status: CheckStatus, code: CheckCode, reason: string): CheckResult {
  return { id, title: TITLES[id], status, code, reason };
}

function skipped(id: CheckId, requirement: CheckId): CheckResult {
  return result(id, "skipped", "skipped", `not evaluated because ${requirement} did not pass`);
}

function checkHash(specBytes: Uint8Array, expected: string): CheckResult {
  if (!/^0x[0-9a-fA-F]{64}$/.test(expected)) {
    return result("C1", "fail", "invalid_spec_hash", "the published hash is not 32 bytes of hexadecimal");
  }
  const actual = specHash(specBytes);
  if (actual !== expected.toLowerCase()) {
    return result(
      "C1",
      "fail",
      "hash_mismatch",
      `keccak256 of the bytes is ${actual}, the published hash is ${expected}`,
    );
  }
  return result("C1", "pass", "ok", `keccak256 of the ${specBytes.length} bytes is ${actual}`);
}

function checkSchema(
  value: unknown,
  chainId: number,
): { readonly check: CheckResult; readonly spec?: IndexSpec; readonly errors: readonly SpecError[] } {
  const validation = validateSpec(value);
  if (!validation.ok) {
    const { errors } = validation;
    const unsupported = errors
      .map(({ code }) => code)
      .find((code): code is "unsupported_schema" | "unsupported_calc" => code.startsWith("unsupported_"));
    const first = errors[0];
    const code = unsupported ?? "schema_violation";
    const summary = first === undefined ? "the document is invalid" : `${first.path || "document"}: ${first.message}`;
    const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : "";
    return { check: result("C4", "fail", code, `${summary}${more}`), errors };
  }
  const { spec } = validation;
  if (spec.chainId !== chainId) {
    const reason = `the spec is for chain ${spec.chainId}, the version was read from chain ${chainId}`;
    return { check: result("C4", "fail", "chain_mismatch", reason), spec, errors: [] };
  }
  return { check: result("C4", "pass", "ok", `valid ${spec.schema} document for chain ${chainId}`), spec, errors: [] };
}

function checkConstituents(spec: IndexSpec, published: readonly PublishedConstituent[]): CheckResult {
  const expected = computeConstituents(spec);
  if (published.length !== expected.length) {
    const reason = `the spec implies ${expected.length} constituents, ${published.length} are published`;
    return result("C5", "fail", "constituent_count_mismatch", reason);
  }
  for (const [i, { token, weightBps }] of expected.entries()) {
    const actual = published[i];
    if (actual === undefined || !/^0x[0-9a-fA-F]{40}$/.test(actual.token) || !Number.isSafeInteger(actual.weightBps)) {
      return result("C5", "fail", "invalid_constituent", `constituent ${i} is not an address with an integer weight`);
    }
    if (actual.token.toLowerCase() !== token) {
      return result("C5", "fail", "token_mismatch", `constituent ${i} is ${actual.token}, the spec implies ${token}`);
    }
    if (actual.weightBps !== weightBps) {
      const reason = `${token} is published at ${actual.weightBps} bps, the spec implies ${weightBps} bps`;
      return result("C5", "fail", "weight_mismatch", reason);
    }
  }
  return result("C5", "pass", "ok", `${expected.length} constituents match the spec in order and weight`);
}

/**
 * Runs C1 to C5 on one published version.
 *
 * - C1: `keccak256(specBytes)` equals the published hash.
 * - C2: the bytes are well-formed UTF-8 and one JSON value without duplicate property names.
 * - C3: the bytes equal the canonical serialization (RFC 8785) of the value they parse to.
 * - C4: the value is a valid spec and its `chainId` is the chain the version was read from.
 * - C5: the published constituents are the spec's tokens, in order, with the weights the spec implies.
 *
 * C1 and C2 are always evaluated. C3 needs C2, C4 needs C3 and C5 needs C4; a check whose requirement
 * did not pass is `skipped`, so nothing is ever computed from a document that is not known to be valid.
 */
export function verifyVersion(input: VerificationInput): VerificationReport {
  const c1 = checkHash(input.specBytes, input.specHash);
  const parsed = parseCanonical(input.specBytes);
  if (!parsed.ok && MALFORMED.includes(parsed.code)) {
    const checks = [c1, result("C2", "fail", parsed.code, parsed.message), skipped("C3", "C2"), skipped("C4", "C3")];
    return { conformant: false, checks: [...checks, skipped("C5", "C4")], specErrors: [] };
  }
  const c2 = result("C2", "pass", "ok", "well-formed UTF-8, one JSON value, no duplicate property names");
  if (!parsed.ok) {
    const checks = [
      c1,
      c2,
      result("C3", "fail", parsed.code, parsed.message),
      skipped("C4", "C3"),
      skipped("C5", "C4"),
    ];
    return { conformant: false, checks, specErrors: [] };
  }
  const c3 = result("C3", "pass", "ok", "the bytes equal the canonical serialization of the parsed value");
  const schema = checkSchema(parsed.value, input.chainId);
  const c5 =
    schema.spec !== undefined && schema.check.status === "pass"
      ? checkConstituents(schema.spec, input.constituents)
      : skipped("C5", "C4");
  const checks = [c1, c2, c3, schema.check, c5];
  return {
    conformant: checks.every(({ status }) => status === "pass"),
    checks,
    ...(schema.spec === undefined ? {} : { spec: schema.spec }),
    specErrors: schema.errors,
  };
}

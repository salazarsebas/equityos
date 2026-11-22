import type { CheckId, CheckStatus } from "@equityos/core";

/**
 * What each conformance check means for a reader, in one sentence. The checks themselves are computed by
 * `verifyVersion` in `@equityos/core`. This is only their fixed wording.
 */
export const CHECK_MEANINGS: Readonly<Record<CheckId, { readonly name: string; readonly meaning: string }>> = {
  C1: {
    name: "Hash matches",
    meaning:
      "The methodology stored onchain hashes to the spec hash the registry recorded, so it is the published one.",
  },
  C2: {
    name: "Well-formed document",
    meaning: "The stored bytes are valid UTF-8 and a single JSON document with no repeated property.",
  },
  C3: {
    name: "Canonical form",
    meaning: "The document is written in its one canonical form, so the same methodology cannot have two hashes.",
  },
  C4: {
    name: "Valid methodology",
    meaning: "The document follows the equityos.index/1 schema and all of its rules, and was written for this chain.",
  },
  C5: {
    name: "Composition matches",
    meaning: "The tokens and weights the registry stores are exactly the ones the methodology implies.",
  },
};

export const CHECK_STATUS_LABELS: Readonly<Record<CheckStatus, string>> = {
  pass: "Pass",
  fail: "Fail",
  skipped: "Not evaluated",
};

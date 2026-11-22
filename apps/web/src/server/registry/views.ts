import "server-only";
import { verifyVersion } from "@equityos/core";
import { hexToBytes } from "viem";
import type { IndexVersionView, PublishedVersion } from "./types";

/**
 * Verifies a published version and builds its view.
 *
 * `verifyVersion` parses the stored bytes with `parseCanonical`, validates the document and compares the
 * stored composition with the one the spec implies (checks C1 to C5). Its report carries the parsed spec as
 * soon as the document is schema-valid, which is earlier than conformance: a spec for another chain, or one
 * whose stored composition differs, is still returned there. The view exposes the spec only when the version
 * is conformant.
 */
export function buildVersionView(published: PublishedVersion): IndexVersionView {
  const report = verifyVersion({
    specBytes: hexToBytes(published.specBytes),
    specHash: published.specHash,
    constituents: published.constituents,
    chainId: published.chainId,
  });
  const verification = { checks: report.checks, specErrors: report.specErrors };
  if (report.conformant && report.spec !== undefined) {
    return { ...published, verification, conformant: true, spec: report.spec };
  }
  return { ...published, verification, conformant: false, spec: null };
}

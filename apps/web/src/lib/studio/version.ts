import {
  type Address,
  bytesToHex,
  type CheckResult,
  type Hex,
  type IndexSpec,
  isAddress,
  verifyVersion,
} from "@equityos/core";
import { hexToBytes, isHex } from "viem";
import { diffSpecs, summarizeDiff } from "@/lib/indexes/diff";
import { formatIdentifier, parseIdentifier } from "@/lib/registry/identifier";
import type { Draft } from "./draft";
import type { ValidDraft } from "./evaluate";
import { bpsToPercentText } from "./weights";

/** An index as the registry describes it now, and the registry it was read from. */
export interface IndexHead {
  readonly identifier: string;
  readonly indexId: Hex;
  readonly chainId: number;
  readonly registry: Address;
  readonly creator: Address;
  /** Number of versions published. */
  readonly latestVersion: number;
  readonly deprecated: boolean;
}

/** One version as the registry stores it. Nothing in it is trusted before `loadTarget` has verified it. */
export interface StoredVersion {
  readonly version: number;
  readonly specHex: Hex;
  readonly specHash: Hex;
  readonly constituents: readonly { readonly token: string; readonly weightBps: number }[];
}

/** The latest version of an index, verified in this browser: the base a new version is edited from. */
export interface BaseVersion {
  readonly version: number;
  readonly spec: IndexSpec;
  readonly specBytes: Uint8Array;
  readonly specHex: Hex;
  readonly specHash: Hex;
}

/** The index a new version is published to. */
export interface VersionTarget extends IndexHead {
  readonly base: BaseVersion;
}

export type TargetLoad =
  | { readonly status: "ready"; readonly target: VersionTarget; readonly draft: Draft }
  /** Deprecation is terminal: the registry accepts no version, so the editor does not open. */
  | { readonly status: "deprecated"; readonly head: IndexHead }
  /** The latest version fails a check of core. Nothing may be computed from it, so it cannot be edited. */
  | { readonly status: "not_conformant"; readonly head: IndexHead; readonly check: CheckResult }
  /** A valid spec the editor cannot represent without changing it silently. */
  | { readonly status: "not_editable"; readonly head: IndexHead; readonly reason: string };

/** The minimum interval as the editor types it, or `null` when it is not a whole number of hours. */
function intervalOf(seconds: number): Pick<Draft, "minInterval" | "minIntervalUnit"> | null {
  if (seconds % 86_400 === 0) return { minInterval: String(seconds / 86_400), minIntervalUnit: "days" };
  if (seconds % 3_600 === 0) return { minInterval: String(seconds / 3_600), minIntervalUnit: "hours" };
  return null;
}

/**
 * The draft a spec describes. Evaluated against an asset list with the same feeds, it gives the same canonical
 * bytes. The slug is marked as typed, so renaming the index never changes its identifier by itself.
 */
export function draftFromSpec(
  spec: IndexSpec,
  salt: Hex,
): { readonly ok: true; readonly draft: Draft } | { readonly ok: false; readonly reason: string } {
  if (spec.parent !== undefined) {
    return { ok: false, reason: "It names a parent version, and the Studio does not write parent references." };
  }
  const interval = intervalOf(spec.rebalance.minIntervalSeconds);
  if (interval === null) {
    const seconds = spec.rebalance.minIntervalSeconds;
    return { ok: false, reason: `Its minimum rebalance interval, ${seconds} seconds, is not a whole number of hours.` };
  }
  const { tokens } = spec.universe;
  const fixed = spec.weighting.type === "fixed" ? spec.weighting.weightsBps : null;
  const weights: Record<Address, string> = {};
  tokens.forEach((token, i) => {
    const weightBps = fixed?.[i];
    if (weightBps !== undefined) weights[token] = bpsToPercentText(weightBps);
  });
  const bound = (bps: number | undefined) => (bps === undefined ? "" : bpsToPercentText(bps));
  return {
    ok: true,
    draft: {
      chainId: spec.chainId,
      name: spec.name,
      slug: spec.slug,
      slugEdited: true,
      description: spec.description,
      tokens: [...tokens],
      weighting: spec.weighting.type,
      weights,
      maxWeight: bound(spec.constraints?.maxWeightBps),
      minWeight: bound(spec.constraints?.minWeightBps),
      driftThreshold: bpsToPercentText(spec.rebalance.driftThresholdBps),
      ...interval,
      salt,
    },
  };
}

/**
 * Verifies the latest version with checks C1 to C5 of core, on the bytes, hash and constituents the registry
 * returned and the chain they were read from, and turns it into a draft. A deprecated index is refused first.
 */
export function loadTarget(head: IndexHead, stored: StoredVersion, salt: Hex): TargetLoad {
  if (head.deprecated) return { status: "deprecated", head };
  const specBytes = hexToBytes(stored.specHex);
  const report = verifyVersion({
    specBytes,
    specHash: stored.specHash,
    constituents: stored.constituents,
    chainId: head.chainId,
  });
  const failed = report.checks.find(({ status }) => status !== "pass");
  if (!report.conformant || report.spec === undefined || failed !== undefined) {
    const check = failed ?? report.checks[0];
    if (check === undefined) throw new Error("verifyVersion returned no check");
    return { status: "not_conformant", head, check };
  }
  const loaded = draftFromSpec(report.spec, salt);
  if (!loaded.ok) return { status: "not_editable", head, reason: loaded.reason };
  const base = {
    version: stored.version,
    spec: report.spec,
    specBytes,
    specHex: bytesToHex(specBytes),
    specHash: stored.specHash,
  };
  return { status: "ready", target: { ...head, base }, draft: loaded.draft };
}

/** True when the draft is byte for byte the latest version: publishing it would add nothing. */
export function isUnchanged(valid: ValidDraft, base: BaseVersion): boolean {
  const { specBytes } = valid;
  return specBytes.length === base.specBytes.length && specBytes.every((byte, i) => byte === base.specBytes[i]);
}

/** What the draft changes against the latest version, in the words of the version history of the profile. */
export function describeChanges(valid: ValidDraft, base: BaseVersion): string[] {
  return summarizeDiff(diffSpecs(base.spec, valid.spec));
}

/**
 * The canonical identifier the index will have after publishing a version with this slug. It is the current
 * one while the slug stays, and the new slug with the same id prefix otherwise.
 */
export function identifierAfter(target: VersionTarget, slug: string): string {
  const parsed = parseIdentifier(target.identifier);
  if (slug === target.base.spec.slug || parsed?.kind !== "slug") return target.identifier;
  return formatIdentifier(slug, parsed.prefix);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : null;
}

function version(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 0xffff_ffff ? value : null;
}

function hash(value: unknown): Hex | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? `0x${value.slice(2).toLowerCase()}` : null;
}

function address(value: unknown): Address | null {
  return typeof value === "string" && isAddress(value) ? value : null;
}

/** `GET /api/v1/indexes/{identifier}`: the head of the index and the registry it was read from. `null` if malformed. */
export function parseIndexResponse(body: unknown): IndexHead | null {
  const data = record(record(body)?.data);
  const registry = record(record(record(body)?.meta)?.registry);
  const indexId = hash(data?.indexId);
  const creator = address(data?.creator);
  const latestVersion = version(data?.latestVersion);
  const registryAddress = address(registry?.address);
  const chainId = registry?.chainId;
  if (data === null || indexId === null || creator === null || latestVersion === null || registryAddress === null) {
    return null;
  }
  if (typeof data.identifier !== "string" || typeof data.deprecated !== "boolean") return null;
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) return null;
  const { identifier, deprecated } = data;
  return { identifier, indexId, chainId, registry: registryAddress, creator, latestVersion, deprecated };
}

/** `GET /api/v1/indexes/{identifier}/versions/{version}`: what the registry stores. `null` if malformed. */
export function parseVersionResponse(body: unknown): StoredVersion | null {
  const data = record(record(body)?.data);
  const number = version(data?.version);
  const specHash = hash(data?.specHash);
  const specHex = data?.specBytes;
  if (number === null || specHash === null || typeof specHex !== "string" || !isHex(specHex)) return null;
  if (!Array.isArray(data?.constituents)) return null;
  const constituents: { token: string; weightBps: number }[] = [];
  for (const entry of data.constituents) {
    const constituent = record(entry);
    if (typeof constituent?.token !== "string" || typeof constituent.weightBps !== "number") return null;
    constituents.push({ token: constituent.token, weightBps: constituent.weightBps });
  }
  return { version: number, specHex, specHash, constituents };
}

/** An index of the registry as the list of the API describes it. */
export interface ListedIndex {
  readonly identifier: string;
  readonly creator: Address;
  readonly latestVersion: number;
  readonly deprecated: boolean;
  /** The name of the latest version, `null` when it fails verification. */
  readonly name: string | null;
}

/** One page of `GET /api/v1/indexes`, or `null` when the body is not one. */
export function parseIndexPage(
  body: unknown,
): { readonly indexes: readonly ListedIndex[]; readonly nextOffset: number | null; readonly chainId: number } | null {
  const envelope = record(body);
  const meta = record(envelope?.meta);
  const chainId = record(meta?.registry)?.chainId;
  const nextOffset = meta?.nextOffset;
  if (!Array.isArray(envelope?.data) || typeof chainId !== "number") return null;
  if (nextOffset !== null && (typeof nextOffset !== "number" || !Number.isSafeInteger(nextOffset))) return null;
  const indexes: ListedIndex[] = [];
  for (const entry of envelope.data) {
    const index = record(entry);
    const creator = address(index?.creator);
    const latestVersion = version(index?.latestVersion);
    const name = record(index?.latest)?.name;
    if (index === null || creator === null || latestVersion === null || typeof index.identifier !== "string")
      return null;
    if (typeof index.deprecated !== "boolean" || (name !== null && typeof name !== "string")) return null;
    indexes.push({
      identifier: index.identifier,
      creator,
      latestVersion,
      deprecated: index.deprecated,
      name: name ?? null,
    });
  }
  return { indexes, nextOffset, chainId };
}

/** The indexes an account created, in creation order. */
export function indexesOf(indexes: readonly ListedIndex[], account: Address): ListedIndex[] {
  return indexes.filter(({ creator }) => creator.toLowerCase() === account.toLowerCase());
}

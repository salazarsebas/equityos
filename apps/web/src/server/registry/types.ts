import "server-only";
import type { CheckResult, IndexSpec, SpecError } from "@equityos/core";
import type { Address, Hex } from "viem";

/** `IIndexRegistry.Composition`: how much of a version is mirrored in contract state. */
export type Composition = "rule_based" | "dynamic_weights" | "static";

/** Index-level state. It changes when a version is published or the index is deprecated. */
export interface IndexHead {
  readonly indexId: Hex;
  /** Lowercase address of the only account that can publish versions or deprecate the index. */
  readonly creator: Address;
  /** Number of versions published, at least 1. */
  readonly latestVersion: number;
  /** Timestamp of the block of version 1, Unix seconds. */
  readonly createdAt: bigint;
  /** Timestamp of the block of deprecation, Unix seconds. `null` while the index is active. */
  readonly deprecatedAt: bigint | null;
}

/** A constituent as stored in the registry. */
export interface StoredConstituent {
  /** Lowercase token address. */
  readonly token: Address;
  /** Stored weight in basis points. Zero for every constituent of a `dynamic_weights` version. */
  readonly weightBps: number;
}

/** What the registry stores for one version, exactly as read. None of it can change after publication. */
export interface PublishedVersion {
  readonly chainId: number;
  readonly registry: Address;
  readonly indexId: Hex;
  readonly version: number;
  readonly creator: Address;
  /** keccak256 of the spec bytes, computed by the registry at publication. */
  readonly specHash: Hex;
  /** Timestamp of the block of publication, Unix seconds. */
  readonly publishedAt: bigint;
  /** Number of the block of publication. */
  readonly publishedBlock: bigint;
  readonly composition: Composition;
  /** The stored spec, byte for byte. */
  readonly specBytes: Hex;
  /** The stored composition mirror, in the order the registry returns it. */
  readonly constituents: readonly StoredConstituent[];
}

/** Checks C1 to C5 of `@equityos/core` on the stored bytes, in order, and the schema violations found by C4. */
export interface VersionVerification {
  readonly checks: readonly CheckResult[];
  readonly specErrors: readonly SpecError[];
}

/**
 * One version with its verification report. The spec is exposed only when every check passes. A version that
 * fails a check carries `spec: null`: nothing parsed from bytes that are not known to be a valid, canonical
 * spec matching the stored composition may be displayed as the methodology or computed from.
 */
export type IndexVersionView = PublishedVersion & { readonly verification: VersionVerification } & (
    | { readonly conformant: true; readonly spec: IndexSpec }
    | { readonly conformant: false; readonly spec: null }
  );

/** An index with its latest version, as listed. */
export interface IndexSummary {
  /** Position in creation order, stable forever. */
  readonly position: number;
  /** Canonical URL identifier: `<slug>-<prefix>`, or the index id when the latest version is not conformant. */
  readonly identifier: string;
  readonly head: IndexHead;
  readonly latest: IndexVersionView;
}

/**
 * The registry has no code on the active chain. This is a state to render, distinct from a registry that is
 * deployed and holds no index.
 */
export interface RegistryNotDeployed {
  readonly status: "registry_not_deployed";
  readonly chainId: number;
  readonly registry: Address;
  /** `not_configured`: the deployment map has no deploy block. `no_code`: the address holds no code. */
  readonly reason: "not_configured" | "no_code";
}

/** Result of a read that needs the registry. */
export type RegistryRead<T> = ({ readonly status: "ok" } & T) | RegistryNotDeployed;

/** Result of a read that names one index or one version. */
export type RegistryLookup<T, Missing extends string> = RegistryRead<T> | { readonly status: Missing };

export interface PageRequest {
  /** Items to skip. Defaults to 0. */
  readonly offset?: number;
  /** Maximum items to return, 1 to `MAX_PAGE_SIZE`. Defaults to `DEFAULT_PAGE_SIZE`. */
  readonly limit?: number;
}

/** Largest page a single read returns. It bounds the size of one batched request and of its response. */
export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 20;

export interface IndexPage {
  /** Number of indexes in the registry. */
  readonly total: number;
  readonly offset: number;
  /** In creation order. */
  readonly indexes: readonly IndexSummary[];
}

export interface VersionPage {
  /** Number of versions of the index. */
  readonly total: number;
  readonly offset: number;
  /** In ascending version order. */
  readonly versions: readonly IndexVersionView[];
}

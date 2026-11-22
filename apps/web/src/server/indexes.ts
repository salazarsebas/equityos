import "server-only";
import type { Address } from "viem";
import type { AssetMarketData, IneligibilityCode, MarketSnapshot } from "./market";
import {
  type IndexSummary,
  type IndexVersionView,
  MAX_PAGE_SIZE,
  type RegistryNotDeployed,
  type RegistryReader,
  type StoredConstituent,
} from "./registry";

/** A constituent of a version next to what the market data layer knows about its token now. */
export interface CompositionRow {
  readonly token: Address;
  /** Target weight in basis points, as published. */
  readonly weightBps: number;
  /** The token's entry in the asset universe. `null` when the issuer's list does not hold the address. */
  readonly market: AssetMarketData | null;
}

/**
 * Joins the constituents of a verified version with the asset universe of a snapshot, in the published order.
 * A constituent the snapshot does not know is kept, with `market: null`: a token can leave the universe after
 * a version is published, and that is reported, never hidden.
 */
export function joinComposition(
  constituents: readonly StoredConstituent[],
  snapshot: MarketSnapshot,
): CompositionRow[] {
  return constituents.map(({ token, weightBps }) => ({ token, weightBps, market: snapshot.assets.get(token) ?? null }));
}

/**
 * What is true of a constituent now, as opposed to what was published. None of it is part of verification:
 * every value can change from one block to the next.
 */
export interface ConstituentStatus {
  /** Whether the token is index-eligible now. A token outside the asset universe is not. */
  readonly eligible: boolean;
  readonly ineligibleReasons: readonly IneligibilityCode[];
  /** Whether the issuer paused transfers. `null` when the token state could not be read. */
  readonly transfersPaused: boolean | null;
  /** Whether a usable reference price exists now. */
  readonly priced: boolean;
}

export function constituentStatus({ market }: CompositionRow): ConstituentStatus {
  if (market === null) {
    return { eligible: false, ineligibleReasons: ["not_listed"], transfersPaused: null, priced: false };
  }
  const { eligibility, token, referencePrice } = market;
  return {
    eligible: eligibility.eligible,
    ineligibleReasons: eligibility.eligible ? [] : eligibility.reasons,
    transfersPaused: token.status === "ok" ? token.state.transfersPaused : null,
    priced: referencePrice !== null && referencePrice.status !== "unavailable",
  };
}

/** One version of one index, with the most recent versions of the index for its history. */
export interface IndexProfile {
  readonly index: IndexSummary;
  readonly version: IndexVersionView;
  /**
   * The most recent versions, at most `MAX_PAGE_SIZE`, in ascending order. The first one is version 1 unless
   * the index has more versions than that.
   */
  readonly history: readonly IndexVersionView[];
}

export type IndexProfileLookup =
  | ({ readonly status: "ok" } & IndexProfile)
  | RegistryNotDeployed
  | { readonly status: "invalid_identifier" | "index_not_found" | "version_not_found" };

/**
 * Resolves an identifier and loads one version of the index with its recent history.
 *
 * @param version the version to load. Defaults to the latest one.
 */
export async function loadIndexProfile(
  reader: RegistryReader,
  identifier: string,
  version?: number,
): Promise<IndexProfileLookup> {
  const found = await reader.getIndex(identifier);
  if (found.status !== "ok") return found;
  const { index } = found;
  const { indexId, latestVersion } = index.head;
  const number = version ?? latestVersion;
  if (!Number.isSafeInteger(number) || number < 1 || number > latestVersion) return { status: "version_not_found" };
  const offset = Math.max(0, latestVersion - MAX_PAGE_SIZE);
  const [selected, recent] = await Promise.all([
    number === latestVersion ? { status: "ok" as const, version: index.latest } : reader.getVersion(indexId, number),
    reader.listVersions(indexId, { offset, limit: MAX_PAGE_SIZE }),
  ]);
  if (selected.status !== "ok") return selected;
  // The index was just resolved, so it exists: another answer means the registry changed under the read.
  if (recent.status !== "ok") return recent.status === "registry_not_deployed" ? recent : { status: "index_not_found" };
  return { status: "ok", index, version: selected.version, history: recent.versions };
}

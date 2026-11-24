import "server-only";
import { type MarketPhase, marketPhaseAt } from "@equityos/core";
import type { Address } from "viem";
import { executionAvailability } from "@/server/api/status";
import { getMarketData, type MarketData, type MarketSnapshot, marketDataMode } from "@/server/market";
import {
  getRegistryReader,
  getRegistryReplay,
  type IndexSummary,
  type RegistryReader,
  type RegistryReplay,
} from "@/server/registry";

/** Counts of the asset universe at one block, with where and when they were read. */
export type Universe =
  | {
      readonly status: "ok";
      /** Tokens in the issuer's asset list. */
      readonly listed: number;
      /** Listed tokens initialized onchain with a total supply above zero. */
      readonly minted: number;
      readonly eligible: number;
      readonly blockNumber: bigint;
      /** Timestamp of the block the token state was read at, Unix seconds. */
      readonly blockTimestamp: number;
      /** True when a source is not answering and the last copy read is shown. */
      readonly servedStale: boolean;
      /** Phase of the US equity market at the time the snapshot was evaluated for. */
      readonly phase: MarketPhase | "unknown";
      readonly observedAt: number;
      readonly replay: boolean;
    }
  | { readonly status: "unavailable" };

/** The index registry on the configured chain. */
export type Registry =
  | {
      readonly status: "deployed";
      readonly chainId: number;
      readonly address: Address;
      readonly total: number;
      /** The newest index, or `null` for a registry that holds none. Never `null` when `total` is above zero. */
      readonly newest: IndexSummary | null;
      /** Time of the read, Unix seconds: the recorded block in a replay, the clock otherwise. */
      readonly readAt: number;
      readonly replay: RegistryReplay | null;
    }
  | {
      readonly status: "not_deployed";
      readonly chainId: number;
      readonly address: Address;
      readonly reason: "not_configured" | "no_code";
      readonly readAt: number;
    }
  | { readonly status: "unavailable" };

/** Counts the universe of a market snapshot. */
export function summarizeUniverse(snapshot: MarketSnapshot, replay: boolean): Universe {
  let minted = 0;
  let eligible = 0;
  for (const { token, eligibility } of snapshot.assets.values()) {
    if (token.status === "ok" && token.state.totalSupply > 0n) minted += 1;
    if (eligibility.eligible) eligible += 1;
  }
  const { onchain } = snapshot;
  return {
    status: "ok",
    listed: snapshot.assets.size,
    minted,
    eligible,
    blockNumber: onchain.blockNumber,
    blockTimestamp: onchain.blockTimestamp,
    servedStale: snapshot.assetList.servedStale || onchain.servedStale,
    phase: marketPhaseAt(snapshot.observedAt),
    observedAt: snapshot.observedAt,
    replay,
  };
}

/**
 * The universe from the market data layer. A source that cannot be read gives `unavailable`: the page then
 * shows no number rather than a default.
 */
export async function loadUniverse(getMarket: () => MarketData = getMarketData): Promise<Universe> {
  try {
    return summarizeUniverse(await getMarket().getSnapshot(), marketDataMode() === "replay");
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * The registry state: whether it is deployed, how many indexes it holds and the newest one. A registry that holds
 * indexes but whose newest one cannot be read is `unavailable`, never a registry with no index.
 */
export async function loadRegistry(
  getReader: () => RegistryReader = getRegistryReader,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<Registry> {
  try {
    const reader = getReader();
    const replay = getRegistryReplay();
    const readAt = replay === null ? now() : replay.blockTimestamp;
    const count = await reader.listIndexes({ limit: 1 });
    if (count.status !== "ok") {
      return { status: "not_deployed", chainId: count.chainId, address: count.registry, reason: count.reason, readAt };
    }
    let newest: IndexSummary | null = null;
    if (count.total > 0) {
      const page = await reader.listIndexes({ offset: count.total - 1, limit: 1 });
      newest = page.status === "ok" ? (page.indexes[0] ?? null) : null;
      if (newest === null) return { status: "unavailable" };
    }
    return {
      status: "deployed",
      chainId: reader.chainId,
      address: reader.registry,
      total: count.total,
      newest,
      readAt,
      replay,
    };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * Whether this release can execute trades at all, for a visitor the jurisdiction gate lets through. It asks the
 * same function that answers `GET /api/v1/status`, so the page changes with the release, not with an edit.
 */
export function executionReleased(): boolean {
  return executionAvailability({ restricted: false, reason: "permitted_country", country: "ZZ" }).executionAvailable;
}

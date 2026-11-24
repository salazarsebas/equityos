import "server-only";
import {
  type Metric,
  METRIC_DEFINITIONS,
  MIN_NOTIONAL_USD_E8,
  type NetworkService,
  TIER_B_WINDOW_SECONDS,
  TOLERANCE_MARGIN_BPS,
} from "@/server/network";
import { HEADS_CACHE, type RegistryMode } from "@/server/registry";
import { notDeployed } from "./indexes";
import { isoTimestamp, ok, publicCache, route } from "./http";
import { parseQuery } from "./params";

export interface NetworkApiOptions {
  readonly network: () => NetworkService;
  readonly mode: () => RegistryMode;
  /** Clock in Unix seconds. */
  readonly now?: () => number;
}

/** Attestations listed in a response, newest first. The counts cover all of them. */
export const LISTED_ATTESTATIONS = 50;

function metric<T>({ id, value, chainId, fromBlock, toBlock, computedAt }: Metric<T>) {
  return { id, value, chainId, fromBlock, toBlock, computedAt: isoTimestamp(computedAt) };
}

/**
 * `GET /api/v1/network`: every network metric with its definition, its chain and the blocks it covers, the
 * thresholds of the tiers, the excluded accounts and the most recent classified attestations.
 */
export function networkHandler(options: NetworkApiOptions) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  return route(async (request: Request) => {
    parseQuery(request, []);
    const read = await options.network().read();
    if (read.status !== "ok") throw notDeployed(read);
    const excluded = new Set(read.exclusions.map(({ address }) => address));
    const data = {
      chainId: read.chainId,
      registry: read.registry,
      rebalanceLog: read.rebalanceLog,
      scan: { ...read.scan, usageComplete: read.usageComplete },
      thresholds: {
        minimumNotionalUsdE8: MIN_NOTIONAL_USD_E8,
        tierBWindowSeconds: Number(TIER_B_WINDOW_SECONDS),
        toleranceMarginBps: TOLERANCE_MARGIN_BPS,
      },
      metrics: Object.fromEntries(Object.entries(read.metrics).map(([key, value]) => [key, metric(value)])),
      attestations: read.classified
        .slice(-LISTED_ATTESTATIONS)
        .reverse()
        .map(({ event, tier, reason, valueUsdE8, linkedTransaction, tracking }) => ({
          transactionHash: event.transactionHash,
          blockNumber: event.blockNumber,
          blockTimestamp: isoTimestamp(Number(event.blockTimestamp)),
          account: event.account,
          indexId: event.indexId,
          version: event.version,
          tier,
          reason,
          valueUsdE8,
          linkedTransaction,
          tracking:
            tracking === null
              ? null
              : tracking.status === "not_assessed"
                ? { status: tracking.status, reason: tracking.reason, maxDriftBps: null, toleranceBps: null }
                : { ...tracking, reason: null },
          excluded: excluded.has(event.account),
        })),
      exclusions: read.exclusions,
      definitions: METRIC_DEFINITIONS,
    };
    // The metrics are read from the registry chain alone, so the mode of the response is the registry's.
    const mode = options.mode();
    const meta = {
      mode,
      asOf: isoTimestamp(now()),
      registry: { chainId: read.chainId, address: read.registry, mode },
    };
    return ok(data, meta, publicCache(HEADS_CACHE.ttlSeconds));
  });
}

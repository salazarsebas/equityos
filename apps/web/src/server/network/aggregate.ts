import "server-only";
import type { Address, Hex } from "viem";
import { countPerDay, type DailyCount, type EventScan, type RegistryEvent } from "../registry";
import type { TierResult, Tracking } from "./classify";
import { MIN_SERIES_DAYS, type MetricId, type Tier } from "./definitions";
import type { ExcludedAccount } from "./exclusions";

type Attestation = Extract<RegistryEvent, { type: "rebalance_recorded" }>;

/** An attestation with its tier and, for tier A, the drift of the account's holdings after it. */
export interface ClassifiedAttestation extends TierResult {
  readonly event: Attestation;
  /** `null` unless the attestation is tier A. */
  readonly tracking: Tracking | null;
}

/** A value with what it was computed from: its definition, its chain, its blocks and when. */
export interface Metric<T> {
  readonly id: MetricId;
  readonly value: T;
  readonly chainId: number;
  readonly fromBlock: bigint;
  /** Last block covered, `null` before the first block range is scanned. */
  readonly toBlock: bigint | null;
  /** Unix seconds. */
  readonly computedAt: number;
}

export interface TierCounts {
  readonly tierA: number;
  readonly tierB: number;
  readonly unmatched: number;
}

/** What the page and the API know about an index besides its id. */
export interface IndexLabel {
  readonly identifier: string;
  /** Name of the latest version when it is verified, `null` otherwise. */
  readonly name: string | null;
}

export interface IndexUsage {
  readonly indexId: Hex;
  readonly label: IndexLabel | null;
  readonly attestations: TierCounts;
  readonly accountsTierA: number;
}

export interface NetworkMetrics {
  readonly indexesPublished: Metric<number>;
  readonly versionsPublished: Metric<number>;
  readonly distinctCreators: Metric<number>;
  readonly indexesDeprecated: Metric<number>;
  readonly versionsPerDay: Metric<DailyCount[]>;
  readonly attestations: Metric<number>;
  readonly attestationsTierA: Metric<number>;
  readonly attestationsTierB: Metric<number>;
  readonly attestationsUnmatched: Metric<number>;
  readonly accountsTierA: Metric<number>;
  readonly accountsWithinTolerance: Metric<number>;
  readonly tierAPerDay: Metric<DailyCount[]>;
  readonly byIndex: Metric<IndexUsage[]>;
  /** USD scaled by 1e8. */
  readonly tierAReferenceValueUsdE8: Metric<bigint>;
  readonly excludedActivity: Metric<{ indexes: number; versions: number; attestations: TierCounts }>;
}

export interface MetricsInput {
  readonly chainId: number;
  readonly scan: EventScan;
  /** Classified attestations in event order: a prefix of the attestations of `scan` when not all are done. */
  readonly classified: readonly ClassifiedAttestation[];
  /** Last block whose attestations are all classified. */
  readonly usageToBlock: bigint | null;
  readonly exclusions: readonly ExcludedAccount[];
  readonly labels: ReadonlyMap<Hex, IndexLabel>;
  readonly computedAt: number;
}

function countTiers(attestations: readonly ClassifiedAttestation[]): TierCounts {
  const of = (tier: Tier) => attestations.filter((attestation) => attestation.tier === tier).length;
  return { tierA: of("a"), tierB: of("b"), unmatched: of("unmatched") };
}

function distinct(accounts: Iterable<Address>): number {
  return new Set(accounts).size;
}

function byIndex(attestations: readonly ClassifiedAttestation[], labels: ReadonlyMap<Hex, IndexLabel>): IndexUsage[] {
  const groups = new Map<Hex, ClassifiedAttestation[]>();
  for (const attestation of attestations) {
    const group = groups.get(attestation.event.indexId) ?? [];
    group.push(attestation);
    groups.set(attestation.event.indexId, group);
  }
  return [...groups.entries()]
    .map(([indexId, group]) => ({
      indexId,
      label: labels.get(indexId) ?? null,
      attestations: countTiers(group),
      accountsTierA: distinct(group.filter(({ tier }) => tier === "a").map(({ event }) => event.account)),
    }))
    .sort(
      (a, b) =>
        b.accountsTierA - a.accountsTierA ||
        b.attestations.tierA - a.attestations.tierA ||
        (a.indexId < b.indexId ? -1 : 1),
    );
}

/**
 * Every metric of the network page from the scanned events and the classified attestations. Activity of an
 * excluded account, and of the indexes it created, is counted in `excludedActivity` and nowhere else.
 */
export function buildNetworkMetrics(input: MetricsInput): NetworkMetrics {
  const { chainId, scan, computedAt } = input;
  const excluded = new Set(input.exclusions.map(({ address }) => address));
  const excludedIndexes = new Set(
    scan.events.flatMap((event) =>
      event.type === "index_created" && excluded.has(event.creator) ? event.indexId : [],
    ),
  );
  const counted: RegistryEvent[] = [];
  const setAside: RegistryEvent[] = [];
  for (const event of scan.events) {
    if (event.type === "rebalance_recorded") continue;
    (excludedIndexes.has(event.indexId) ? setAside : counted).push(event);
  }
  const attestations = input.classified.filter(({ event }) => !excluded.has(event.account));
  const excludedAttestations = input.classified.filter(({ event }) => excluded.has(event.account));
  const tierA = attestations.filter(({ tier }) => tier === "a");

  const registry = <T>(id: MetricId, value: T): Metric<T> => ({
    id,
    value,
    chainId,
    fromBlock: scan.fromBlock,
    toBlock: scan.scannedToBlock,
    computedAt,
  });
  const usage = <T>(id: MetricId, value: T): Metric<T> => ({ ...registry(id, value), toBlock: input.usageToBlock });
  const ofType = (events: readonly RegistryEvent[], type: RegistryEvent["type"]) =>
    events.filter((event) => event.type === type);
  const tiers = countTiers(attestations);

  return {
    indexesPublished: registry("registry.indexes_published", ofType(counted, "index_created").length),
    versionsPublished: registry("registry.versions_published", ofType(counted, "version_published").length),
    distinctCreators: registry(
      "registry.distinct_creators",
      distinct(counted.flatMap((event) => (event.type === "index_created" ? event.creator : []))),
    ),
    indexesDeprecated: registry("registry.indexes_deprecated", ofType(counted, "index_deprecated").length),
    versionsPerDay: registry("registry.versions_per_day", countPerDay(counted, "version_published")),
    attestations: usage("usage.attestations", attestations.length),
    attestationsTierA: usage("usage.attestations_tier_a", tiers.tierA),
    attestationsTierB: usage("usage.attestations_tier_b", tiers.tierB),
    attestationsUnmatched: usage("usage.attestations_unmatched", tiers.unmatched),
    accountsTierA: usage("usage.accounts_tier_a", distinct(tierA.map(({ event }) => event.account))),
    accountsWithinTolerance: usage(
      "usage.accounts_within_tolerance",
      distinct(tierA.flatMap(({ event, tracking }) => (tracking?.status === "within" ? event.account : []))),
    ),
    tierAPerDay: usage(
      "usage.tier_a_per_day",
      countPerDay(
        tierA.map(({ event }) => event),
        "rebalance_recorded",
      ),
    ),
    byIndex: usage("usage.by_index", byIndex(attestations, input.labels)),
    tierAReferenceValueUsdE8: usage(
      "volume.tier_a_reference_value",
      tierA.reduce((sum, { valueUsdE8 }) => sum + (valueUsdE8 ?? 0n), 0n),
    ),
    excludedActivity: usage("exclusions.activity", {
      indexes: ofType(setAside, "index_created").length,
      versions: ofType(setAside, "version_published").length,
      attestations: countTiers(excludedAttestations),
    }),
  };
}

/** Whether a daily series spans enough UTC days, first to last inclusive, to be drawn as a series. */
export function spansEnoughDays(series: readonly DailyCount[]): boolean {
  const first = series[0];
  const last = series.at(-1);
  if (first === undefined || last === undefined) return false;
  const days = (Date.parse(last.day) - Date.parse(first.day)) / 86_400_000 + 1;
  return days >= MIN_SERIES_DAYS;
}

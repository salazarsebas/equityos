import "server-only";

/**
 * Thresholds of the usage tiers. They are fixed in code so that anyone can rerun the classification and get the
 * same rows, and they change only with a documented change of the definitions.
 */

/** Minimum reference value of the constituent flows of a transaction: 1.00 USD, scaled by 1e8. */
export const MIN_NOTIONAL_USD_E8 = 100_000_000n;
/** Longest time, in seconds, from a transaction with flows to the attestation it can link to (tier B). */
export const TIER_B_WINDOW_SECONDS = 900n;
/** Added to the drift threshold of a version to give the replication tolerance, in basis points. */
export const TOLERANCE_MARGIN_BPS = 200;
/** UTC days a daily series must span before it is drawn: fewer days make a series that says nothing. */
export const MIN_SERIES_DAYS = 7;

export type MetricId =
  | "registry.indexes_published"
  | "registry.versions_published"
  | "registry.distinct_creators"
  | "registry.indexes_deprecated"
  | "registry.versions_per_day"
  | "usage.attestations"
  | "usage.attestations_tier_a"
  | "usage.attestations_tier_b"
  | "usage.attestations_unmatched"
  | "usage.accounts_tier_a"
  | "usage.accounts_within_tolerance"
  | "usage.tier_a_per_day"
  | "usage.by_index"
  | "volume.tier_a_reference_value"
  | "exclusions.activity";

export interface MetricDefinition {
  readonly id: MetricId;
  readonly title: string;
  /** What is counted or summed, exactly. */
  readonly definition: string;
  /** The chain data it is computed from. */
  readonly source: string;
}

const REGISTRY_LOGS = "IndexRegistry logs";
const ATTESTATION_EVIDENCE =
  "RebalanceRecorded logs of RebalanceLog, the receipts of their transactions and the Transfer logs of the constituent tokens";
const EXCLUDED = "Activity of excluded accounts is not counted.";

/** Every metric, in the order the page lists them. The API returns the same list. */
export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    id: "registry.indexes_published",
    title: "Published indexes",
    definition: `IndexCreated events. The registry writes version 1 in the same call, so every index has a published version. ${EXCLUDED}`,
    source: REGISTRY_LOGS,
  },
  {
    id: "registry.versions_published",
    title: "Index versions",
    definition: `VersionPublished events, version 1 included. ${EXCLUDED}`,
    source: REGISTRY_LOGS,
  },
  {
    id: "registry.distinct_creators",
    title: "Distinct creators",
    definition: `Distinct creator addresses of IndexCreated events. ${EXCLUDED}`,
    source: REGISTRY_LOGS,
  },
  {
    id: "registry.indexes_deprecated",
    title: "Deprecated indexes",
    definition: `IndexDeprecated events. Deprecation is final, so an index counts once at most. ${EXCLUDED}`,
    source: REGISTRY_LOGS,
  },
  {
    id: "registry.versions_per_day",
    title: "Versions published per day",
    definition: "VersionPublished events per UTC day of their block time. Days without one are absent.",
    source: REGISTRY_LOGS,
  },
  {
    id: "usage.attestations",
    title: "Attestations recorded",
    definition: `RebalanceRecorded events of every tier. An attestation is a claim by the account that sent it and proves no trade by itself. ${EXCLUDED}`,
    source: "RebalanceLog logs",
  },
  {
    id: "usage.attestations_tier_a",
    title: "Attestations with matching flows (tier A)",
    definition:
      "Attestations whose own transaction carries Transfer logs of the attested version's constituents to or from the attesting account, worth at least 1.00 USD at the reference prices of that block.",
    source: ATTESTATION_EVIDENCE,
  },
  {
    id: "usage.attestations_tier_b",
    title: "Linked attestations (tier B)",
    definition:
      "Not tier A, sent in a transaction from the attesting account itself, and preceded by at most 900 seconds by another transaction from that account whose constituent flows meet the tier A rule. An earlier transaction links one attestation at most. Never in a headline figure.",
    source: ATTESTATION_EVIDENCE,
  },
  {
    id: "usage.attestations_unmatched",
    title: "Unmatched attestations",
    definition:
      "Attestations that are neither tier A nor tier B: no constituent flows, flows below 1.00 USD, or flows that could not be valued. Shown for transparency, never in a headline figure.",
    source: ATTESTATION_EVIDENCE,
  },
  {
    id: "usage.accounts_tier_a",
    title: "Distinct accounts (tier A)",
    definition: "Distinct attesting accounts with at least one tier A attestation.",
    source: ATTESTATION_EVIDENCE,
  },
  {
    id: "usage.accounts_within_tolerance",
    title: "Accounts within tolerance",
    definition:
      "Distinct accounts with a tier A attestation after which, at the end of its block, the largest drift of their holdings from the target weights was at most the version's drift threshold plus 200 basis points. Holdings are valued at the reference prices of that block. Assessed for verified versions with static weights only.",
    source: `${ATTESTATION_EVIDENCE}, balances and Chainlink reference feeds read at the block`,
  },
  {
    id: "usage.tier_a_per_day",
    title: "Tier A attestations per day",
    definition: "Tier A attestations per UTC day of their block time. Days without one are absent.",
    source: ATTESTATION_EVIDENCE,
  },
  {
    id: "usage.by_index",
    title: "Attestations by index",
    definition:
      "Per attested index: attestations of each tier and distinct accounts with a tier A attestation, ordered by distinct accounts, then by tier A attestations.",
    source: ATTESTATION_EVIDENCE,
  },
  {
    id: "volume.tier_a_reference_value",
    title: "Reference value moved (tier A)",
    definition:
      "Sum over tier A attestations of every constituent Transfer to or from the attesting account in the same transaction, each valued at the latest answer of the token's Chainlink reference feed as read at that block, rounded down. Purchases and sales both count. A reference valuation of token movements: not traded value, and not a price any trade executed at.",
    source: `${ATTESTATION_EVIDENCE}, and Chainlink reference feeds read at the block`,
  },
  {
    id: "exclusions.activity",
    title: "Excluded activity",
    definition:
      "Indexes and versions created by excluded accounts, and attestations they recorded by tier. Counted here and in no other figure.",
    source: `${REGISTRY_LOGS} and ${ATTESTATION_EVIDENCE}`,
  },
];

export type Tier = "a" | "b" | "unmatched";

/**
 * Decoders of every response of API v1, one per schema of the OpenAPI document (`components.schemas`), with the
 * same names and the same properties. Amounts, prices, block numbers and round ids arrive as decimal strings and
 * are decoded to `bigint`; the scale stays in the field name (`priceE8` is USD scaled by 1e8). Counts, decimals,
 * versions, chain ids and weights in basis points are JSON integers and are decoded to `number`.
 *
 * `apps/web/test/api/sdk.test.ts` compares the shape of each decoder with the OpenAPI document.
 */

import { type CheckCode, validateSpec } from "@equityos/core";
import {
  array,
  boolean,
  constant,
  type Decoder,
  DecodeFailure,
  enumOf,
  hex,
  type Infer,
  integer,
  json,
  literal,
  nullable,
  object,
  refine,
  string,
  stringOf,
  uint,
  union,
} from "./decode.ts";

/** The statement every plan carries, as the API returns it. */
export const PLAN_STATEMENT =
  "Arithmetic toward the published target weights at reference prices. It contains no executable quote, no slippage and no gas, and it is not an instruction to trade.";

/** Error codes of API v1. A code is stable: branch on it, never on the message. */
export const API_ERROR_CODES = [
  "invalid_parameter",
  "invalid_address",
  "invalid_identifier",
  "asset_not_found",
  "index_not_found",
  "version_not_found",
  "registry_not_deployed",
  "version_not_conformant",
  "upstream_unavailable",
  "upstream_malformed",
  "service_misconfigured",
  "internal_error",
  "ineligible_token",
  "token_paused",
  "missing_feed",
  "stale_feed",
  "invalid_body",
  "execution_unavailable",
  "rate_limited",
  "provider_rate_limited",
  "deadline_exceeded",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const MARKET_FAILURES = [
  "upstream_failure",
  "malformed_response",
  "missing_configuration",
  "ineligible_token",
  "token_paused",
  "missing_feed",
  "stale_feed",
  "unknown",
] as const;

const INELIGIBILITY_REASONS = [
  "not_listed",
  "onchain_read_failed",
  "not_initialized",
  "decimals_mismatch",
  "not_minted",
  "missing_feed",
  "feed_mismatch",
] as const;

const CALCULATION_ISSUE_CODES = [
  "missing_price",
  "price_unavailable",
  "zero_price",
  "decimals_mismatch",
  "zero_deployable_value",
  "below_minimum_portfolio_value",
  "market_closed",
  "price_delayed",
  "projected_drift_increase",
  "uninvested_quote",
  "nothing_to_do",
] as const;

const address = hex;
const bytes32 = hex;
/** ISO 8601 instant in UTC with second precision, such as `2026-11-21T19:10:55Z`. */
const timestamp = string;

const marketPhase = enumOf(["regular", "extended", "closed", "unknown"]);
const mode = enumOf(["live", "replay"]);

const datasetProperties = {
  source: enumOf(["coinbase_api", "base_rpc"]),
  fetchedAt: timestamp(),
  ageSeconds: integer(),
  servedStale: boolean(),
  failure: nullable(enumOf(MARKET_FAILURES)),
};

export const dataset = object(datasetProperties);
export const onchainDataset = object({ ...datasetProperties, blockNumber: uint(), blockTimestamp: timestamp() });
export const datasets = object({ assetList: dataset, onchain: onchainDataset });

const snapshotMetaProperties = {
  asOf: timestamp(),
  marketPhase,
  referencePriceSource: constant("chainlink"),
  datasets,
};

export const snapshotMeta = object(snapshotMetaProperties);
export const assetListMeta = object({ ...snapshotMetaProperties, count: integer(), total: integer() });

export const pricePoint = object({ priceE8: uint(), updatedAt: timestamp(), roundId: uint() });

export const tokenState = object({
  status: enumOf(["ok", "not_initialized", "read_failed"]),
  decimals: nullable(integer()),
  totalSupply: nullable(uint()),
  multiplierWad: nullable(uint()),
  pendingMultiplier: nullable(object({ multiplierWad: uint(), effectiveAt: timestamp() })),
  transfersPaused: nullable(boolean()),
});

export const eligibility = object({ eligible: boolean(), reasons: array(enumOf(INELIGIBILITY_REASONS)) });

export const referencePrice = object({
  status: enumOf(["live", "delayed", "last_close", "unavailable"]),
  priceE8: nullable(uint()),
  updatedAt: nullable(timestamp()),
  roundId: nullable(uint()),
  unavailableReason: nullable(
    enumOf(["not_eligible", "feed_read_failed", "feed_mismatch", "invalid_round", "stale_feed"]),
  ),
  lastObserved: nullable(pricePoint),
  feedProxy: nullable(address()),
});

export const asset = object({
  address: address(),
  symbol: string(),
  name: string(),
  decimals: integer(),
  isin: nullable(string()),
  onchain: tokenState,
  eligibility,
  referencePrice,
});

export const registryRef = object({ chainId: integer(), address: address(), mode });
export const registryMeta = object({ asOf: timestamp(), registry: registryRef });
export const indexListMeta = object({
  asOf: timestamp(),
  registry: registryRef,
  total: integer(),
  offset: integer(),
  limit: integer(),
  count: integer(),
  nextOffset: nullable(integer()),
});
export const compositionMeta = object({ ...snapshotMetaProperties, registry: registryRef });

const checkId = enumOf(["C1", "C2", "C3", "C4", "C5"]);
const composition = enumOf(["rule_based", "dynamic_weights", "static"]);

export const verificationSummary = object({
  conformant: boolean(),
  failedCheck: nullable(object({ id: checkId, code: stringOf<CheckCode>() })),
});

export const versionSummary = object({
  version: integer(),
  name: nullable(string()),
  slug: nullable(string()),
  weighting: nullable(enumOf(["equal", "fixed"])),
  composition,
  constituentCount: integer(),
  specHash: bytes32(),
  publishedAt: timestamp(),
  publishedBlock: uint(),
  verification: verificationSummary,
});

const indexProperties = {
  indexId: bytes32(),
  identifier: string(),
  position: integer(),
  creator: address(),
  createdAt: timestamp(),
  latestVersion: integer(),
  deprecated: boolean(),
  deprecatedAt: nullable(timestamp()),
  latest: versionSummary,
};

export const indexSummary = object(indexProperties);
export const index = object({
  ...indexProperties,
  versions: array(
    object({
      version: integer(),
      publishedAt: timestamp(),
      publishedBlock: uint(),
      specHash: bytes32(),
      conformant: boolean(),
    }),
  ),
});

export const constituent = object({ token: address(), weightBps: integer() });

export const check = object({
  id: checkId,
  title: string(),
  status: enumOf(["pass", "fail", "skipped"]),
  code: stringOf<CheckCode>(),
  reason: string(),
});

/** The shape of the spec in the OpenAPI document. Decoding goes through `validateSpec` of `@equityos/core`. */
const specShape = object(
  {
    schema: literal("equityos.index/1"),
    calc: literal("equityos.calc/1"),
    chainId: integer(),
    name: string(),
    slug: string(),
    description: string(),
    universe: object({ type: literal("static"), tokens: array(address()) }),
    weighting: object({ type: enumOf(["equal", "fixed"]), weightsBps: array(integer()) }, ["weightsBps"]),
    constraints: object({ maxWeightBps: integer(), minWeightBps: integer() }, ["maxWeightBps", "minWeightBps"]),
    pricing: object({ source: literal("chainlink-aggregator-v3"), feeds: array(address()) }),
    rebalance: object({ trigger: literal("drift"), driftThresholdBps: integer(), minIntervalSeconds: integer() }),
    parent: object({
      chainId: integer(),
      registry: address(),
      indexId: bytes32(),
      version: integer(),
      specHash: bytes32(),
    }),
  },
  ["constraints", "parent"],
);

/** A published spec, decoded only if `validateSpec` accepts it: the API returns a spec only for a verified version. */
export const indexSpec = refine(specShape, (value, path) => {
  const result = validateSpec(value);
  if (!result.ok) {
    const first = result.errors[0];
    throw new DecodeFailure(`${path}${first?.path ?? ""}`, `a valid equityos.index/1 spec (${first?.code ?? ""})`);
  }
  return result.spec;
});

export const indexVersion = object({
  indexId: bytes32(),
  identifier: string(),
  version: integer(),
  latestVersion: integer(),
  isLatest: boolean(),
  creator: address(),
  chainId: integer(),
  registry: address(),
  specHash: bytes32(),
  publishedAt: timestamp(),
  publishedBlock: uint(),
  composition,
  specSize: integer(),
  specBytes: hex(),
  specText: nullable(string()),
  spec: nullable(indexSpec),
  constituents: array(constituent),
  verification: object({
    conformant: boolean(),
    checks: array(check),
    specErrors: array(object({ path: string(), code: string(), message: string() })),
  }),
});

export const indexComposition = object({
  indexId: bytes32(),
  identifier: string(),
  version: integer(),
  isLatest: boolean(),
  constituents: array(
    object({
      token: address(),
      symbol: nullable(string()),
      name: nullable(string()),
      targetWeightBps: integer(),
      eligibility,
      transfersPaused: nullable(boolean()),
      referencePrice,
    }),
  ),
});

const errorDetails = nullable(json());

export const registryStatus = object({
  chainId: integer(),
  address: address(),
  mode,
  deployed: nullable(boolean()),
  notDeployedReason: nullable(enumOf(["not_configured", "no_code"])),
  indexCount: nullable(integer()),
  error: nullable(object({ code: enumOf(API_ERROR_CODES), details: errorDetails })),
});

export const status = object({
  apiVersion: string(),
  chainId: integer(),
  marketPhase,
  executionAvailable: boolean(),
  executionUnavailableReason: nullable(enumOf(["restricted_jurisdiction", "jurisdiction_unknown", "not_released"])),
  marketData: object({
    mode,
    available: boolean(),
    referencePriceSource: constant("chainlink"),
    datasets: nullable(datasets),
    error: nullable(object({ code: enumOf(API_ERROR_CODES), details: errorDetails })),
  }),
  registry: registryStatus,
});

export const statusMeta = object({ asOf: timestamp() });

export const portfolioIndex = object({
  indexId: bytes32(),
  identifier: string(),
  name: string(),
  version: integer(),
  latestVersion: integer(),
  isLatest: boolean(),
  specHash: bytes32(),
  driftThresholdBps: integer(),
  minIntervalSeconds: integer(),
});

export const calculationIssue = object({
  code: enumOf(CALCULATION_ISSUE_CODES),
  severity: enumOf(["blocker", "warning"]),
  token: nullable(address()),
  minimumDeployableValueUsdE8: nullable(uint()),
  uninvestedQuote: nullable(uint()),
  currentMaxAbsDriftBps: nullable(integer()),
  projectedMaxAbsDriftBps: nullable(integer()),
});

export const portfolioPosition = object({
  token: address(),
  symbol: nullable(string()),
  name: nullable(string()),
  decimals: integer(),
  balance: uint(),
  targetWeightBps: integer(),
  currentWeightBps: nullable(integer()),
  driftBps: nullable(integer()),
  valueUsdE8: nullable(uint()),
  referencePrice,
});

export const outsideHolding = object({
  token: address(),
  symbol: nullable(string()),
  name: nullable(string()),
  decimals: integer(),
  balance: uint(),
  valueUsdE8: nullable(uint()),
  referencePrice,
});

export const portfolio = object({
  address: address(),
  index: portfolioIndex,
  constituents: array(portfolioPosition),
  totals: object({
    investedValueUsdE8: nullable(uint()),
    quoteBalance: uint(),
    quoteValueUsdE8: uint(),
    quotePriceE8: uint(),
    deployableValueUsdE8: nullable(uint()),
    cashShareBps: nullable(integer()),
  }),
  drift: nullable(
    object({
      maxAbsDriftBps: integer(),
      maxDriftToken: address(),
      turnoverBps: integer(),
      driftThresholdBps: integer(),
      thresholdReached: boolean(),
    }),
  ),
  outsideIndex: array(outsideHolding),
  issues: array(calculationIssue),
});

export const portfolioMeta = object({
  ...snapshotMetaProperties,
  registry: registryRef,
  balances: object({ chainId: integer(), blockNumber: uint(), blockTimestamp: timestamp(), mode }),
});

const side = enumOf(["sell", "buy"]);

export const planLeg = object({
  side,
  token: address(),
  symbol: nullable(string()),
  decimals: nullable(integer()),
  exit: boolean(),
  tokenQuantity: uint(),
  quoteAmount: uint(),
  valueUsdE8: uint(),
  priceE8: uint(),
});

export const skippedLeg = object({
  side,
  token: address(),
  symbol: nullable(string()),
  exit: boolean(),
  valueUsdE8: uint(),
  reason: enumOf(["below_minimum", "zero_quantity", "above_target_weight", "not_needed"]),
});

export const blockedPlan = object({
  status: literal("blocked"),
  blockers: array(calculationIssue),
  warnings: array(calculationIssue),
});

export const readyPlan = object({
  status: literal("ready"),
  warnings: array(calculationIssue),
  legs: array(planLeg),
  skipped: array(skippedLeg),
  candidate: enumOf(["uncapped", "capped"]),
  otherCandidateMaxAbsDriftBps: nullable(integer()),
  currentMaxAbsDriftBps: nullable(integer()),
  availableQuote: uint(),
  buyBudgetQuote: uint(),
  deployableValueUsdE8: uint(),
  projected: object({
    positions: array(
      object({
        token: address(),
        symbol: nullable(string()),
        balance: uint(),
        valueUsdE8: uint(),
        targetWeightBps: integer(),
        weightBps: nullable(integer()),
        driftBps: nullable(integer()),
      }),
    ),
    investedValueUsdE8: uint(),
    quoteBalance: uint(),
    maxAbsDriftBps: nullable(integer()),
  }),
});

export const portfolioPlan = object({
  address: address(),
  index: portfolioIndex,
  priceBasis: constant("reference"),
  executable: literal(false),
  statement: constant(PLAN_STATEMENT),
  mode: enumOf(["rebalance", "buy_only"]),
  depositUsdE8: uint(),
  reserveBps: integer(),
  minLegValueUsdE8: uint(),
  plan: union("status", { blocked: blockedPlan, ready: readyPlan }),
});

/** The statement every execution plan carries, as the API returns it. */
export const EXECUTION_STATEMENT =
  "Executable quotes from a third-party aggregator, checked against reference prices and the chain at one block. Each swap returns at least its minimum amount out or reverts; more than the minimum is not guaranteed. The plan must be quoted again after expiresAt, and it is not an instruction to trade.";

export const executionCheck = object({
  check: enumOf([
    "jurisdiction",
    "reference_plan",
    "reference_freshness",
    "quote",
    "transfers_not_paused",
    "policy_authorized",
    "multiplier_window",
    "price_deviation",
    "balance",
    "allowance",
    "simulation",
    "plan_expiry",
  ]),
  status: enumOf(["pass", "warn", "block", "not_simulated", "skipped"]),
  reason: string(),
  token: nullable(address()),
  leg: nullable(integer()),
  detail: nullable(string()),
});

export const executionLeg = object({
  side,
  token: address(),
  symbol: nullable(string()),
  decimals: integer(),
  tokenIn: address(),
  tokenOut: address(),
  amountIn: uint(),
  referencePriceE8: uint(),
  referenceStatus: enumOf(["live", "delayed", "last_close", "unavailable"]),
  referenceAmountOut: uint(),
  quote: nullable(
    object({
      provider: string(),
      router: address(),
      functionName: enumOf(["swap"]),
      quotedAmountOut: uint(),
      minAmountOut: uint(),
      deviationBps: integer(),
      minimumDeviationBps: integer(),
      deadline: timestamp(),
      gasEstimate: uint(),
      quotedAt: timestamp(),
      routeId: string(),
    }),
  ),
});

export const executionCall = object({
  kind: enumOf(["approve", "swap"]),
  to: address(),
  data: hex(),
  value: uint(),
  token: address(),
  leg: nullable(integer()),
  minAmountOut: nullable(uint()),
});

export const executionPlan = object({
  address: address(),
  index: portfolioIndex,
  chainId: integer(),
  priceBasis: constant("executable_quote"),
  statement: constant(EXECUTION_STATEMENT),
  mode: enumOf(["rebalance", "buy_only"]),
  reserveBps: integer(),
  minLegValueUsdE8: uint(),
  slippageBps: integer(),
  maxDeviationBps: integer(),
  allowUnsimulated: boolean(),
  provider: object({ name: string(), router: address() }),
  status: enumOf(["ready", "blocked"]),
  executable: boolean(),
  expiresAt: nullable(timestamp()),
  checkedAtBlock: nullable(object({ number: uint(), timestamp: timestamp() })),
  simulationMethod: nullable(enumOf(["eth_simulateV1", "eth_call"])),
  legs: array(executionLeg),
  checks: array(executionCheck),
  blockedBy: array(executionCheck),
  warnings: array(executionCheck),
  approvals: array(
    object({ token: address(), spender: address(), currentAllowance: uint(), amount: uint(), required: boolean() }),
  ),
  calls: nullable(array(executionCall)),
  totals: nullable(
    object({
      usdcBalance: uint(),
      minUsdcFromSells: uint(),
      maxUsdcForBuys: uint(),
      endBalances: array(object({ token: address(), before: uint(), after: uint() })),
    }),
  ),
  planHash: nullable(bytes32()),
});

/** Ids of the network metrics, as `definitions[].id` lists them. */
const METRIC_IDS = [
  "registry.indexes_published",
  "registry.versions_published",
  "registry.distinct_creators",
  "registry.indexes_deprecated",
  "registry.versions_per_day",
  "usage.attestations",
  "usage.attestations_tier_a",
  "usage.attestations_tier_b",
  "usage.attestations_unmatched",
  "usage.accounts_tier_a",
  "usage.accounts_within_tolerance",
  "usage.tier_a_per_day",
  "usage.by_index",
  "volume.tier_a_reference_value",
  "exclusions.activity",
] as const;

/** A network metric: its value, its definition id, its chain, the blocks it covers and when it was computed. */
function metric<T>(value: Decoder<T>) {
  return object({
    id: enumOf(METRIC_IDS),
    value,
    chainId: integer(),
    fromBlock: uint(),
    toBlock: nullable(uint()),
    computedAt: timestamp(),
  });
}

const tierCounts = object({ tierA: integer(), tierB: integer(), unmatched: integer() });
const dailyCounts = array(object({ day: string(), count: integer() }));

export const networkMetrics = object({
  indexesPublished: metric(integer()),
  versionsPublished: metric(integer()),
  distinctCreators: metric(integer()),
  indexesDeprecated: metric(integer()),
  versionsPerDay: metric(dailyCounts),
  attestations: metric(integer()),
  attestationsTierA: metric(integer()),
  attestationsTierB: metric(integer()),
  attestationsUnmatched: metric(integer()),
  accountsTierA: metric(integer()),
  accountsWithinTolerance: metric(integer()),
  tierAPerDay: metric(dailyCounts),
  byIndex: metric(
    array(
      object({
        indexId: bytes32(),
        label: nullable(object({ identifier: string(), name: nullable(string()) })),
        attestations: tierCounts,
        accountsTierA: integer(),
      }),
    ),
  ),
  /** USD scaled by 1e8, at reference prices. Not traded value. */
  tierAReferenceValueUsdE8: metric(uint()),
  excludedActivity: metric(object({ indexes: integer(), versions: integer(), attestations: tierCounts })),
});

export const attestation = object({
  transactionHash: bytes32(),
  blockNumber: uint(),
  blockTimestamp: timestamp(),
  account: address(),
  indexId: bytes32(),
  version: integer(),
  tier: enumOf(["a", "b", "unmatched"]),
  reason: nullable(enumOf(["no_constituent_flows", "below_minimum_notional", "price_unavailable"])),
  valueUsdE8: nullable(uint()),
  linkedTransaction: nullable(bytes32()),
  tracking: nullable(
    object({
      status: enumOf(["within", "outside", "not_assessed"]),
      reason: nullable(enumOf(["not_static", "not_verified", "not_valued"])),
      maxDriftBps: nullable(integer()),
      toleranceBps: nullable(integer()),
    }),
  ),
  excluded: boolean(),
});

export const network = object({
  chainId: integer(),
  registry: address(),
  rebalanceLog: address(),
  scan: object({
    fromBlock: uint(),
    scannedToBlock: nullable(uint()),
    targetBlock: uint(),
    complete: boolean(),
    usageComplete: boolean(),
  }),
  thresholds: object({ minimumNotionalUsdE8: uint(), tierBWindowSeconds: integer(), toleranceMarginBps: integer() }),
  metrics: networkMetrics,
  attestations: array(attestation),
  exclusions: array(object({ address: address(), label: string() })),
  definitions: array(object({ id: string(), title: string(), definition: string(), source: string() })),
});

export const errorBody = object({
  error: object({ code: enumOf(API_ERROR_CODES), message: string(), details: errorDetails }),
});

export type Dataset = Infer<typeof dataset>;
export type OnchainDataset = Infer<typeof onchainDataset>;
export type Datasets = Infer<typeof datasets>;
export type SnapshotMeta = Infer<typeof snapshotMeta>;
export type AssetListMeta = Infer<typeof assetListMeta>;
export type PricePoint = Infer<typeof pricePoint>;
export type TokenState = Infer<typeof tokenState>;
export type Eligibility = Infer<typeof eligibility>;
export type ReferencePrice = Infer<typeof referencePrice>;
export type Asset = Infer<typeof asset>;
export type RegistryRef = Infer<typeof registryRef>;
export type RegistryMeta = Infer<typeof registryMeta>;
export type IndexListMeta = Infer<typeof indexListMeta>;
export type CompositionMeta = Infer<typeof compositionMeta>;
export type VerificationSummary = Infer<typeof verificationSummary>;
export type VersionSummary = Infer<typeof versionSummary>;
export type IndexSummary = Infer<typeof indexSummary>;
export type Index = Infer<typeof index>;
export type Constituent = Infer<typeof constituent>;
export type Check = Infer<typeof check>;
export type IndexVersion = Infer<typeof indexVersion>;
export type IndexComposition = Infer<typeof indexComposition>;
export type RegistryStatus = Infer<typeof registryStatus>;
export type Status = Infer<typeof status>;
export type StatusMeta = Infer<typeof statusMeta>;
export type PortfolioIndex = Infer<typeof portfolioIndex>;
export type CalculationIssue = Infer<typeof calculationIssue>;
export type PortfolioPosition = Infer<typeof portfolioPosition>;
export type OutsideHolding = Infer<typeof outsideHolding>;
export type Portfolio = Infer<typeof portfolio>;
export type PortfolioMeta = Infer<typeof portfolioMeta>;
export type PlanLeg = Infer<typeof planLeg>;
export type SkippedLeg = Infer<typeof skippedLeg>;
export type BlockedPlan = Infer<typeof blockedPlan>;
export type ReadyPlan = Infer<typeof readyPlan>;
export type PortfolioPlan = Infer<typeof portfolioPlan>;
export type ExecutionCheck = Infer<typeof executionCheck>;
export type ExecutionLeg = Infer<typeof executionLeg>;
export type ExecutionCall = Infer<typeof executionCall>;
export type ExecutionPlan = Infer<typeof executionPlan>;
export type NetworkMetrics = Infer<typeof networkMetrics>;
export type Attestation = Infer<typeof attestation>;
export type Network = Infer<typeof network>;

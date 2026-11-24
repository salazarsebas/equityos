import "server-only";
import {
  type CalculationIssue,
  type CalculationIssueCode,
  computeDrift,
  DEFAULT_MIN_LEG_VALUE_USD_E8,
  DEFAULT_RESERVE_BPS,
  type Holding,
  MAX_RESERVE_BPS,
  type PlanMode,
  type PortfolioInput,
  planRebalance,
  type ReferencePrice,
  type TargetConstituent,
  valuePortfolio,
} from "@equityos/core";
import type { Address } from "viem";
import type { Cached } from "@/server/cache";
import { combinedMode } from "@/server/data-mode";
import {
  type AssetMarketData,
  BALANCE_CACHE,
  BASE_CHAIN_ID,
  type BalanceRead,
  MalformedResponseError,
  type MarketData,
  type MarketDataMode,
  type MarketSnapshot,
  ONCHAIN_CACHE,
  UpstreamError,
  USDC_ADDRESS,
} from "@/server/market";
import type { IndexSummary, IndexVersionView, RegistryMode, RegistryReader } from "@/server/registry";
import { snapshotMeta, toApiReferencePrice } from "./assets";
import { ApiError } from "./errors";
import { isoTimestamp, NO_STORE, ok, publicCache, route } from "./http";
import { parseVersion, registryMeta, requireConformant, requireProfile } from "./indexes";
import {
  amountParameter,
  choiceParameter,
  integerParameter,
  parseAddress,
  parseQuery,
  requiredParameter,
} from "./params";

export interface PortfolioApiOptions {
  readonly registry: () => RegistryReader;
  readonly mode: () => RegistryMode;
  readonly marketData: () => MarketData;
  /** `replay` means the balances are the constructed ones of the recording, not a read of any chain. */
  readonly marketMode: () => MarketDataMode;
  /** Clock in Unix seconds, for `meta.registry`. */
  readonly now?: () => number;
}

/**
 * Every finding of the calculation, by code. Typed as a record of `CalculationIssueCode`, so a code added to
 * `@equityos/core` does not compile until it is listed here and documented.
 */
const ISSUE_CODES: Record<CalculationIssueCode, true> = {
  missing_price: true,
  price_unavailable: true,
  zero_price: true,
  decimals_mismatch: true,
  zero_deployable_value: true,
  below_minimum_portfolio_value: true,
  market_closed: true,
  price_delayed: true,
  projected_drift_increase: true,
  uninvested_quote: true,
  nothing_to_do: true,
};
export const CALCULATION_ISSUE_CODES = Object.keys(ISSUE_CODES) as CalculationIssueCode[];

/** The fixed statement every plan carries. It is the same in the response, the documentation and the page. */
export const PLAN_STATEMENT =
  "Arithmetic toward the published target weights at reference prices. It contains no executable quote, no slippage and no gas, and it is not an instruction to trade.";

/** Largest deposit accepted: 1,000,000,000 USD scaled by 1e8. */
export const MAX_DEPOSIT_USD_E8 = 10n ** 17n;
/** Largest minimum leg value accepted: 1,000,000 USD scaled by 1e8. */
export const MAX_MIN_LEG_VALUE_USD_E8 = 10n ** 14n;

/** Everything a comparison is computed from: one conformant version, one market snapshot, one balance read. */
export interface Comparison {
  readonly address: Address;
  readonly index: IndexSummary;
  readonly view: Extract<IndexVersionView, { conformant: true }>;
  readonly snapshot: MarketSnapshot;
  readonly balances: Cached<BalanceRead>;
  /** The asset list entry of each constituent and of each held eligible token. */
  readonly entries: ReadonlyMap<Address, AssetMarketData>;
  readonly input: PortfolioInput;
}

/** A usable reference price as core reads it, or the stated absence of one, whose amount is never read. */
function corePrice(token: Address, entry: AssetMarketData): ReferencePrice {
  const price = entry.referencePrice;
  if (price === null || price.status === "unavailable") return { token, priceE8: 0n, status: "unavailable" };
  return { token, priceE8: price.priceE8, status: price.status };
}

async function loadComparisonFromQuery(options: PortfolioApiOptions, query: URLSearchParams): Promise<Comparison> {
  const address = parseAddress(requiredParameter(query, "address"));
  const identifier = requiredParameter(query, "index");
  const requested = query.get("version");
  return loadComparison(options, address, identifier, requested === null ? undefined : parseVersion(requested));
}

/**
 * Loads the comparison of `address` with a version of an index: the version, the market snapshot and the
 * balances of the address.
 *
 * @throws {ApiError} for an unknown index or version, a version that is not conformant, or a constituent
 *   that is not in the asset list.
 * @throws {UpstreamError} if the balances could not be read now: an older read is never used in their place.
 * @throws {MalformedResponseError} if the balance read has no answer for USDC or for a constituent.
 */
export async function loadComparison(
  options: PortfolioApiOptions,
  address: Address,
  identifier: string,
  version: number | undefined,
): Promise<Comparison> {
  const { index, version: view } = await requireProfile(options, identifier, version);
  requireConformant(view, "target weights to compare with");
  const snapshot = await options.marketData().getSnapshot();
  const constituents: TargetConstituent[] = [];
  const entries = new Map<Address, AssetMarketData>();
  for (const { token, weightBps } of view.constituents) {
    const entry = snapshot.assets.get(token);
    // Without the asset list entry there are no decimals to value a balance with, and no reference price.
    if (entry === undefined) {
      throw new ApiError(409, "ineligible_token", "A constituent of the version is not in the asset list.", {
        token,
        reasons: ["not_listed"],
      });
    }
    entries.set(token, entry);
    constituents.push({ token, weightBps, decimals: entry.asset.decimals });
  }
  const balances = await options.marketData().getBalances(address);
  // Balances move with every transfer: an older read is never presented as the current one. `BALANCE_CACHE` has
  // no stale window, so this holds for any service that keeps to it, and is checked here for any that does not.
  if (balances.servedStale) {
    throw new UpstreamError("base_rpc", `the balance read of ${address} failed and only an older read exists`, {
      cause: balances.error,
    });
  }
  const quoteBalance = balances.value.balances.get(USDC_ADDRESS);
  if (quoteBalance === undefined || quoteBalance === null) {
    throw new MalformedResponseError("base_rpc", `balanceOf(${address}) of USDC`, "did not answer a uint256");
  }
  // The balance read and the snapshot each read the asset list, which can change between the two after a refresh.
  // A constituent the balance read does not hold has an unknown balance, never a zero one: valuing it at zero would
  // make a plan propose buying a position the address may already hold.
  for (const { token } of constituents) {
    if (!balances.value.balances.has(token)) {
      throw new MalformedResponseError("base_rpc", `balanceOf(${address}) of ${token}`, "was not part of the read");
    }
  }
  const holdings: Holding[] = [];
  for (const [token, balance] of balances.value.balances) {
    const entry = snapshot.assets.get(token);
    if (entry === undefined) continue;
    const constituent = entries.has(token);
    if (balance === null) {
      if (constituent) throw new MalformedResponseError("base_rpc", `balanceOf(${address}) of ${token}`, "reverted");
      continue;
    }
    // Only index-eligible tokens outside the index are reported. A constituent is always counted.
    if (!constituent && (!entry.eligibility.eligible || balance === 0n)) continue;
    entries.set(token, entry);
    // Holdings carry the decimals the token reports onchain, so that a disagreement with the list is a finding.
    const decimals = entry.token.status === "ok" ? entry.token.state.decimals : entry.asset.decimals;
    holdings.push({ token, balance, decimals });
  }
  const prices = [...entries].map(([token, entry]) => corePrice(token, entry));
  return {
    address,
    index,
    view,
    snapshot,
    balances,
    entries,
    input: { constituents, holdings, prices, quoteBalance },
  };
}

/** Index facts every portfolio response carries. */
export function indexRef({ index, view }: Comparison) {
  return {
    indexId: index.head.indexId,
    identifier: index.identifier,
    name: view.spec.name,
    version: view.version,
    latestVersion: index.head.latestVersion,
    isLatest: view.version === index.head.latestVersion,
    specHash: view.specHash,
    driftThresholdBps: view.spec.rebalance.driftThresholdBps,
    minIntervalSeconds: view.spec.rebalance.minIntervalSeconds,
  };
}

/** A finding with every key present: the fields of the other codes are `null`. */
function apiIssue(issue: CalculationIssue) {
  return {
    code: issue.code,
    severity: issue.severity,
    token: issue.token,
    minimumDeployableValueUsdE8: "minimumDeployableValueUsdE8" in issue ? issue.minimumDeployableValueUsdE8 : null,
    uninvestedQuote: "uninvestedQuote" in issue ? issue.uninvestedQuote : null,
    currentMaxAbsDriftBps: "currentMaxAbsDriftBps" in issue ? issue.currentMaxAbsDriftBps : null,
    projectedMaxAbsDriftBps: "projectedMaxAbsDriftBps" in issue ? issue.projectedMaxAbsDriftBps : null,
  };
}

/**
 * A condition of a constituent's token that the reference arithmetic does not model, reported next to it.
 * `transfers_paused`: the issuer paused transfers of the token, so no leg in it can be executed while the pause
 * lasts. The execution plan blocks such a leg with its `transfers_not_paused` check.
 */
export interface TransferWarning {
  readonly code: "transfers_paused";
  readonly token: Address;
  readonly symbol: string | null;
}

/** Every constituent whose transfers are paused at the block of the snapshot, in the order of the version. */
export function transferWarnings(comparison: Comparison): TransferWarning[] {
  const warnings: TransferWarning[] = [];
  for (const { token } of comparison.view.constituents) {
    const state = comparison.entries.get(token)?.token;
    if (state?.status === "ok" && state.state.transfersPaused) {
      warnings.push({ code: "transfers_paused", token, symbol: tokenLabel(comparison, token).symbol });
    }
  }
  return warnings;
}

export function tokenLabel(comparison: Comparison, token: Address) {
  const entry = comparison.entries.get(token);
  return { symbol: entry?.asset.symbol ?? null, name: entry?.asset.name ?? null };
}

/**
 * The sources of a comparison. The index comes from the registry chain; balances and reference prices come
 * from Base mainnet, and the two blocks are given apart. `mode` is `replay` when the registry or the market
 * data is replayed.
 */
export function comparisonMeta(options: PortfolioApiOptions, { snapshot, balances }: Comparison) {
  const { blockNumber, blockTimestamp } = balances.value;
  const { registry } = registryMeta(options);
  const marketMode = options.marketMode();
  return {
    ...snapshotMeta(snapshot, combinedMode(marketMode, registry.mode)),
    registry,
    balances: {
      chainId: BASE_CHAIN_ID,
      blockNumber: blockNumber.toString(),
      blockTimestamp: isoTimestamp(blockTimestamp),
      mode: marketMode,
    },
  };
}

/**
 * Cache lifetime: what is left of the shorter of the two TTLs. The URL carries the address, and the in-process
 * balance cache is keyed by it, so a cached answer is only ever the answer for that address. A response with any
 * input served past its TTL (the asset list, the onchain read or the balances) is not cacheable.
 */
export function comparisonCache({ snapshot, balances }: Comparison): string {
  if (snapshot.assetList.servedStale || snapshot.onchain.servedStale || balances.servedStale) return NO_STORE;
  const now = snapshot.observedAt;
  const left = Math.min(
    ONCHAIN_CACHE.ttlSeconds - (now - snapshot.onchain.fetchedAt),
    BALANCE_CACHE.ttlSeconds - (now - balances.fetchedAt),
  );
  return publicCache(left);
}

const COMPARISON_PARAMETERS = ["address", "index", "version"] as const;

/**
 * `GET /api/v1/portfolio`: the holdings of an address on Base mainnet compared with one published version of
 * an index, at reference prices. Nothing is stored: the comparison is computed on every request.
 */
export function portfolioHandler(options: PortfolioApiOptions) {
  return route(async (request: Request) => {
    const comparison = await loadComparisonFromQuery(options, parseQuery(request, COMPARISON_PARAMETERS));
    const valuation = valuePortfolio(comparison.input);
    const drift = computeDrift(valuation.positions, comparison.view.spec.rebalance.driftThresholdBps);
    const driftOf = new Map(drift?.constituents.map((entry) => [entry.token, entry.driftBps]));
    const reference = (token: Address) =>
      toApiReferencePrice(token, comparison.entries.get(token)?.referencePrice ?? null);
    const data = {
      address: comparison.address,
      index: indexRef(comparison),
      constituents: valuation.positions.map((position) => ({
        token: position.token,
        ...tokenLabel(comparison, position.token),
        decimals: position.decimals,
        balance: position.balance,
        targetWeightBps: position.targetWeightBps,
        currentWeightBps: position.weightBps,
        driftBps: driftOf.get(position.token) ?? null,
        valueUsdE8: position.valueUsdE8,
        referencePrice: reference(position.token),
      })),
      totals: {
        investedValueUsdE8: valuation.investedValueUsdE8,
        quoteBalance: valuation.quoteBalance,
        quoteValueUsdE8: valuation.quoteValueUsdE8,
        quotePriceE8: valuation.quotePriceE8,
        deployableValueUsdE8: valuation.deployableValueUsdE8,
        cashShareBps: valuation.cashShareBps,
      },
      drift:
        drift === null
          ? null
          : {
              maxAbsDriftBps: drift.maxAbsDriftBps,
              maxDriftToken: drift.maxDriftToken,
              turnoverBps: drift.turnoverBps,
              driftThresholdBps: drift.driftThresholdBps,
              thresholdReached: drift.thresholdReached,
            },
      outsideIndex: valuation.outsideIndex.map((holding) => ({
        token: holding.token,
        ...tokenLabel(comparison, holding.token),
        decimals: holding.decimals,
        balance: holding.balance,
        valueUsdE8: holding.valueUsdE8,
        referencePrice: reference(holding.token),
      })),
      issues: valuation.issues.map(apiIssue),
      transferWarnings: transferWarnings(comparison),
    };
    return ok(data, comparisonMeta(options, comparison), comparisonCache(comparison));
  });
}

const PLAN_MODES: readonly PlanMode[] = ["rebalance", "buy_only"];

/**
 * `GET /api/v1/portfolio/plan`: the rebalance plan of `@equityos/core` for the same comparison. It is sized at
 * reference prices and is not a quote: see `PLAN_STATEMENT`.
 */
export function portfolioPlanHandler(options: PortfolioApiOptions) {
  return route(async (request: Request) => {
    const query = parseQuery(request, [
      ...COMPARISON_PARAMETERS,
      "mode",
      "depositUsdE8",
      "reserveBps",
      "minLegValueUsdE8",
    ]);
    const mode = choiceParameter(query, "mode", PLAN_MODES);
    if (mode === undefined) {
      throw new ApiError(400, "invalid_parameter", 'Query parameter "mode" is required.', {
        parameter: "mode",
        accepted: PLAN_MODES,
      });
    }
    const depositUsdE8 = amountParameter(query, "depositUsdE8", MAX_DEPOSIT_USD_E8) ?? 0n;
    const reserveBps = integerParameter(query, "reserveBps", 0, MAX_RESERVE_BPS) ?? DEFAULT_RESERVE_BPS;
    const minLegValueUsdE8 =
      amountParameter(query, "minLegValueUsdE8", MAX_MIN_LEG_VALUE_USD_E8) ?? DEFAULT_MIN_LEG_VALUE_USD_E8;
    const comparison = await loadComparisonFromQuery(options, query);
    const result = planRebalance({ ...comparison.input, mode, depositUsdE8, reserveBps, minLegValueUsdE8 });
    const label = (token: Address) => tokenLabel(comparison, token).symbol;
    const decimalsOf = new Map(comparison.input.constituents.map(({ token, decimals }) => [token, decimals]));
    const plan =
      result.status === "blocked"
        ? { status: "blocked", blockers: result.blockers.map(apiIssue), warnings: result.warnings.map(apiIssue) }
        : {
            status: "ready",
            warnings: result.warnings.map(apiIssue),
            legs: result.legs.map((leg) => ({
              side: leg.side,
              token: leg.token,
              symbol: label(leg.token),
              decimals: decimalsOf.get(leg.token) ?? null,
              exit: leg.exit,
              tokenQuantity: leg.tokenQuantity,
              quoteAmount: leg.quoteAmount,
              valueUsdE8: leg.valueUsdE8,
              priceE8: leg.priceE8,
            })),
            skipped: result.skipped.map((leg) => ({
              side: leg.side,
              token: leg.token,
              symbol: label(leg.token),
              exit: leg.exit,
              valueUsdE8: leg.valueUsdE8,
              reason: leg.reason,
            })),
            candidate: result.candidate,
            otherCandidateMaxAbsDriftBps: result.otherCandidateMaxAbsDriftBps,
            currentMaxAbsDriftBps: result.currentMaxAbsDriftBps,
            availableQuote: result.availableQuote,
            buyBudgetQuote: result.buyBudgetQuote,
            deployableValueUsdE8: result.deployableValueUsdE8,
            projected: {
              positions: result.projected.positions.map((position) => ({
                token: position.token,
                symbol: label(position.token),
                balance: position.balance,
                valueUsdE8: position.valueUsdE8,
                targetWeightBps: position.targetWeightBps,
                weightBps: position.weightBps,
                driftBps: position.driftBps,
              })),
              investedValueUsdE8: result.projected.investedValueUsdE8,
              quoteBalance: result.projected.quoteBalance,
              maxAbsDriftBps: result.projected.maxAbsDriftBps,
            },
          };
    const data = {
      address: comparison.address,
      index: indexRef(comparison),
      priceBasis: "reference",
      executable: false,
      statement: PLAN_STATEMENT,
      mode,
      depositUsdE8,
      reserveBps,
      minLegValueUsdE8,
      plan,
      transferWarnings: transferWarnings(comparison),
    };
    return ok(data, comparisonMeta(options, comparison), comparisonCache(comparison));
  });
}

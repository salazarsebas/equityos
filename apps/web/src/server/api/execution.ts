import "server-only";
import {
  DEFAULT_MIN_LEG_VALUE_USD_E8,
  DEFAULT_RESERVE_BPS,
  MAX_RESERVE_BPS,
  type PlanMode,
  type PriceStatus,
  planRebalance,
} from "@equityos/core";
import type { Address } from "viem";
import {
  buildExecutionPlan,
  DEFAULT_MAX_DEVIATION_BPS,
  DEFAULT_SLIPPAGE_BPS,
  EXECUTION_CHAIN_ID,
  type ExecutionClient,
  type ExecutionLeg,
  type ExecutionPlan,
  KYBERSWAP_ROUTER,
  MAX_DEVIATION_BPS,
  MAX_SLIPPAGE_BPS,
  type QuoteProvider,
  type ReferenceOutcome,
} from "@/server/execution";
import { classifyJurisdiction, type JurisdictionEnvironment } from "@/server/jurisdiction";
import { ApiError } from "./errors";
import { isoTimestamp, NO_STORE, ok, route } from "./http";
import { parseAddress } from "./params";
import {
  comparisonMeta,
  indexRef,
  loadComparison,
  MAX_MIN_LEG_VALUE_USD_E8,
  type PortfolioApiOptions,
  tokenLabel,
} from "./portfolio";

/** The fixed statement every execution plan carries. */
export const EXECUTION_STATEMENT =
  "Executable quotes from a third-party aggregator, checked against reference prices and the chain at one block. Each swap returns at least its minimum amount out or reverts; more than the minimum is not guaranteed. The plan must be quoted again after expiresAt, and it is not an instruction to trade.";

/** Largest request body accepted, in bytes. */
export const MAX_BODY_BYTES = 4_096;

export interface ExecutionApiOptions extends PortfolioApiOptions {
  readonly provider: () => QuoteProvider;
  readonly executionClient: () => ExecutionClient;
  /** Environment of the jurisdiction gate. Defaults to `process.env`. */
  readonly env?: JurisdictionEnvironment;
}

interface ExecutionRequest {
  readonly address: Address;
  readonly index: string;
  readonly version: number | undefined;
  readonly mode: PlanMode;
  readonly reserveBps: number;
  readonly minLegValueUsdE8: bigint;
  readonly slippageBps: number;
  readonly maxDeviationBps: number;
  readonly allowUnsimulated: boolean;
}

const BODY_FIELDS = [
  "address",
  "index",
  "version",
  "mode",
  "reserveBps",
  "minLegValueUsdE8",
  "slippageBps",
  "maxDeviationBps",
  "allowUnsimulated",
] as const;
const PLAN_MODES: readonly PlanMode[] = ["rebalance", "buy_only"];

function invalidBody(message: string): ApiError {
  return new ApiError(400, "invalid_body", message);
}

function invalidField(parameter: string, message: string): ApiError {
  return new ApiError(400, "invalid_parameter", message, { parameter });
}

/** The body as text, refusing more than `MAX_BODY_BYTES` without reading further. */
async function readBody(request: Request): Promise<string> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) throw invalidBody("The body must be JSON, sent as application/json.");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader !== undefined) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw invalidBody(`The body is larger than ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

function integerField(body: Record<string, unknown>, name: string, min: number, max: number, fallback?: number) {
  const value = body[name];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw invalidField(name, `"${name}" must be an integer from ${min} to ${max}.`);
  }
  return value;
}

/**
 * Parses the body strictly: a JSON object with known fields only, each of its documented type and bounds.
 *
 * @throws {ApiError} 400 `invalid_body`, `invalid_parameter` or `invalid_address`
 */
export async function parseExecutionRequest(request: Request): Promise<ExecutionRequest> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(request));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalidBody("The body is not valid UTF-8 JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalidBody("The body is not an object.");
  const fields: Record<string, unknown> = { ...body };
  const unknown = Object.keys(fields).find((name) => !(BODY_FIELDS as readonly string[]).includes(name));
  if (unknown !== undefined) throw invalidField(unknown, `Unknown field "${unknown}".`);
  if (typeof fields.address !== "string") throw invalidField("address", '"address" is required.');
  if (typeof fields.index !== "string" || fields.index === "") throw invalidField("index", '"index" is required.');
  const mode = PLAN_MODES.find((choice) => choice === fields.mode);
  if (mode === undefined) throw invalidField("mode", '"mode" must be "rebalance" or "buy_only".');
  const minLeg = fields.minLegValueUsdE8;
  if (minLeg !== undefined && (typeof minLeg !== "string" || !/^(0|[1-9][0-9]{0,29})$/.test(minLeg))) {
    throw invalidField("minLegValueUsdE8", '"minLegValueUsdE8" must be an integer in decimal digits.');
  }
  const minLegValueUsdE8 = minLeg === undefined ? DEFAULT_MIN_LEG_VALUE_USD_E8 : BigInt(minLeg);
  if (minLegValueUsdE8 > MAX_MIN_LEG_VALUE_USD_E8) {
    throw invalidField("minLegValueUsdE8", `"minLegValueUsdE8" must be at most ${MAX_MIN_LEG_VALUE_USD_E8}.`);
  }
  const allowUnsimulated = fields.allowUnsimulated ?? false;
  if (typeof allowUnsimulated !== "boolean") throw invalidField("allowUnsimulated", '"allowUnsimulated" is a boolean.');
  return {
    address: parseAddress(fields.address),
    index: fields.index,
    version: fields.version === undefined ? undefined : integerField(fields, "version", 1, 2 ** 32 - 1),
    mode,
    reserveBps: integerField(fields, "reserveBps", 0, MAX_RESERVE_BPS, DEFAULT_RESERVE_BPS),
    minLegValueUsdE8,
    slippageBps: integerField(fields, "slippageBps", 0, MAX_SLIPPAGE_BPS, DEFAULT_SLIPPAGE_BPS),
    maxDeviationBps: integerField(fields, "maxDeviationBps", 0, MAX_DEVIATION_BPS, DEFAULT_MAX_DEVIATION_BPS),
    allowUnsimulated,
  };
}

function serializePlan(plan: ExecutionPlan, symbol: (token: Address) => string | null) {
  return {
    status: plan.status,
    executable: plan.executable,
    expiresAt: plan.expiresAt === null ? null : isoTimestamp(plan.expiresAt),
    checkedAtBlock:
      plan.checkedAtBlock === null
        ? null
        : { number: plan.checkedAtBlock.number, timestamp: isoTimestamp(plan.checkedAtBlock.timestamp) },
    simulationMethod: plan.simulationMethod,
    legs: plan.legs.map((leg) => ({
      side: leg.side,
      token: leg.token,
      symbol: symbol(leg.token),
      decimals: leg.decimals,
      tokenIn: leg.tokenIn,
      tokenOut: leg.tokenOut,
      amountIn: leg.amountIn,
      referencePriceE8: leg.priceE8,
      referenceStatus: leg.priceStatus,
      referenceAmountOut: leg.side === "sell" ? leg.quoteAmount : leg.tokenQuantity,
      quote:
        leg.quoted === null
          ? null
          : {
              provider: leg.quoted.quote.provider,
              router: leg.quoted.quote.router,
              functionName: leg.quoted.quote.functionName,
              quotedAmountOut: leg.quoted.quote.quotedAmountOut,
              minAmountOut: leg.quoted.quote.minAmountOut,
              deviationBps: leg.quoted.deviationBps,
              gasEstimate: leg.quoted.quote.gasEstimate,
              quotedAt: isoTimestamp(leg.quoted.quotedAt),
              routeId: leg.quoted.quote.routeId,
            },
    })),
    checks: plan.checks,
    blockedBy: plan.blockedBy,
    approvals: plan.approvals,
    calls: plan.calls,
    totals: plan.totals,
    planHash: plan.planHash,
  };
}

/**
 * `POST /api/v1/portfolio/execution-plan`: the reference-price plan of `GET /portfolio/plan`, quoted for
 * execution on Base mainnet and checked. Either `blocked` with the checks that failed, or `ready` with the
 * ordered calls to make and a hash that binds them. Nothing is signed or sent, and nothing is cached.
 */
export function executionPlanHandler(options: ExecutionApiOptions) {
  return route(async (request: Request) => {
    const body = await parseExecutionRequest(request);
    if (options.marketMode() === "replay") {
      throw new ApiError(409, "execution_unavailable", "Execution plans are not built from replayed market data.", {
        reason: "market_data_replay",
      });
    }
    const jurisdiction = classifyJurisdiction(request.headers, options.env);
    const comparison = await loadComparison(options, body.address, body.index, body.version);
    const result = planRebalance({
      ...comparison.input,
      mode: body.mode,
      reserveBps: body.reserveBps,
      minLegValueUsdE8: body.minLegValueUsdE8,
    });
    const decimalsOf = new Map(comparison.input.constituents.map(({ token, decimals }) => [token, decimals]));
    const statusOf = (token: Address): PriceStatus =>
      comparison.entries.get(token)?.referencePrice?.status ?? "unavailable";
    const reference: ReferenceOutcome =
      result.status === "blocked"
        ? { status: "blocked", codes: result.blockers.map(({ code }) => code) }
        : {
            status: "ready",
            legs: result.legs.map((leg): ExecutionLeg => {
              // Every leg trades a constituent, and every constituent carries its decimals.
              const decimals = decimalsOf.get(leg.token);
              if (decimals === undefined) throw new Error(`leg token ${leg.token} is not a constituent`);
              return { ...leg, decimals, priceStatus: statusOf(leg.token) };
            }),
          };
    const plan = await buildExecutionPlan(
      { provider: options.provider(), client: options.executionClient(), now: options.now ?? systemClock },
      {
        account: body.address,
        reference,
        jurisdiction,
        slippageBps: body.slippageBps,
        maxDeviationBps: body.maxDeviationBps,
        allowUnsimulated: body.allowUnsimulated,
      },
    );
    const data = {
      address: body.address,
      index: indexRef(comparison),
      chainId: EXECUTION_CHAIN_ID,
      priceBasis: "executable_quote",
      statement: EXECUTION_STATEMENT,
      mode: body.mode,
      reserveBps: body.reserveBps,
      minLegValueUsdE8: body.minLegValueUsdE8,
      slippageBps: body.slippageBps,
      maxDeviationBps: body.maxDeviationBps,
      allowUnsimulated: body.allowUnsimulated,
      provider: { name: options.provider().name, router: KYBERSWAP_ROUTER },
      ...serializePlan(plan, (token) => tokenLabel(comparison, token).symbol),
    };
    // Never stored: it depends on who asks and from where, and it expires within a minute.
    return ok(data, comparisonMeta(options, comparison), NO_STORE);
  });
}

function systemClock(): number {
  return Math.floor(Date.now() / 1000);
}

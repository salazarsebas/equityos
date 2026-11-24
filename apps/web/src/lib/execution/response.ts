/**
 * The answer of `POST /api/v1/portfolio/execution-plan` as the browser receives it, parsed strictly into typed
 * values. Pure and browser-safe. Nothing in the answer is trusted: this module only checks its shape and turns
 * decimal strings into `bigint` and timestamps into Unix seconds. Whether the calls may be sent is decided by
 * `verify.ts` and `request.ts`, never by a field of the answer.
 */
import { type Address, type Hex, isHex } from "viem";

export type CheckStatus = "pass" | "warn" | "block" | "not_simulated" | "skipped";

/** One check of the plan, as the server reported it. */
export interface PlanCheck {
  readonly check: string;
  readonly status: CheckStatus;
  readonly reason: string;
  readonly token: Address | null;
  readonly leg: number | null;
  readonly detail: string | null;
}

export interface PlanQuote {
  readonly router: Address;
  readonly quotedAmountOut: bigint;
  readonly minAmountOut: bigint;
  readonly deviationBps: number;
  readonly minimumDeviationBps: number;
  /** Unix seconds. */
  readonly deadline: number;
  readonly gasEstimate: bigint;
  readonly routeId: string;
  readonly provider: string;
}

export interface PlanLeg {
  readonly side: "sell" | "buy";
  readonly token: Address;
  readonly symbol: string | null;
  readonly decimals: number;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly referencePriceE8: bigint;
  readonly referenceStatus: string;
  readonly referenceAmountOut: bigint;
  readonly quote: PlanQuote | null;
}

export interface PlanCall {
  readonly kind: "approve" | "swap";
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly token: Address;
  readonly leg: number | null;
  readonly minAmountOut: bigint | null;
}

export interface PlanApproval {
  readonly token: Address;
  readonly spender: Address;
  readonly currentAllowance: bigint;
  readonly amount: bigint;
  readonly required: boolean;
}

export interface PlanTotals {
  readonly usdcBalance: bigint;
  readonly minUsdcFromSells: bigint;
  readonly maxUsdcForBuys: bigint;
  readonly endBalances: readonly { readonly token: Address; readonly before: bigint; readonly after: bigint }[];
}

/** The parts of an execution plan answer the client shows, verifies and sends. */
export interface ExecutionPlanView {
  readonly address: Address;
  readonly index: {
    readonly indexId: Hex;
    readonly identifier: string;
    readonly name: string;
    readonly version: number;
  };
  readonly chainId: number;
  readonly statement: string;
  readonly mode: "rebalance" | "buy_only";
  readonly slippageBps: number;
  readonly providerRouter: Address;
  readonly status: "ready" | "blocked";
  readonly executable: boolean;
  /** Unix seconds, `null` for a blocked plan. */
  readonly expiresAt: number | null;
  readonly checkedAtBlock: { readonly number: bigint; readonly timestamp: number } | null;
  readonly legs: readonly PlanLeg[];
  readonly checks: readonly PlanCheck[];
  readonly blockedBy: readonly PlanCheck[];
  readonly warnings: readonly PlanCheck[];
  readonly approvals: readonly PlanApproval[];
  readonly calls: readonly PlanCall[] | null;
  readonly totals: PlanTotals | null;
  readonly planHash: Hex | null;
  /** The registry the index was read from: an attestation names a version of this registry only. */
  readonly registry: { readonly chainId: number; readonly address: Address };
}

/** The answer does not have the documented shape. `path` names the first field that does not. */
export class PlanShapeError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`the execution plan answer is malformed at ${path}`);
    this.name = "PlanShapeError";
    this.path = path;
  }
}

type Json = Record<string, unknown>;

function record(value: unknown, path: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PlanShapeError(path);
  return value as Json;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new PlanShapeError(path);
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") throw new PlanShapeError(path);
  return value;
}

function nullable<T>(value: unknown, read: (value: unknown) => T): T | null {
  return value === null ? null : read(value);
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new PlanShapeError(path);
  }
  return value;
}

/** A non-negative integer in decimal digits, without a sign or leading zeros, at most 78 digits (uint256). */
function amount(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new PlanShapeError(path);
  const parsed = BigInt(value);
  if (parsed >= 2n ** 256n) throw new PlanShapeError(path);
  return parsed;
}

function address(value: unknown, path: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new PlanShapeError(path);
  return value.toLowerCase() as Address;
}

function hex(value: unknown, path: string, bytes?: number): Hex {
  if (typeof value !== "string" || !isHex(value, { strict: true }) || value.length % 2 !== 0) {
    throw new PlanShapeError(path);
  }
  if (bytes !== undefined && value.length !== 2 + bytes * 2) throw new PlanShapeError(path);
  return value.toLowerCase() as Hex;
}

/** An instant as the API writes it, `YYYY-MM-DDTHH:MM:SSZ`, in Unix seconds. */
function instant(value: unknown, path: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new PlanShapeError(path);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new PlanShapeError(path);
  return milliseconds / 1000;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], path: string): T {
  const found = choices.find((choice) => choice === value);
  if (found === undefined) throw new PlanShapeError(path);
  return found;
}

const CHECK_STATUSES: readonly CheckStatus[] = ["pass", "warn", "block", "not_simulated", "skipped"];

function check(value: unknown, path: string): PlanCheck {
  const entry = record(value, path);
  return {
    check: text(entry.check, `${path}.check`),
    status: oneOf(entry.status, CHECK_STATUSES, `${path}.status`),
    reason: text(entry.reason, `${path}.reason`),
    token: nullable(entry.token, (token) => address(token, `${path}.token`)),
    leg: nullable(entry.leg, (leg) => integer(leg, `${path}.leg`, 0, 1_000)),
    detail: nullable(entry.detail, (detail) => text(detail, `${path}.detail`)),
  };
}

function quote(value: unknown, path: string): PlanQuote {
  const entry = record(value, path);
  return {
    provider: text(entry.provider, `${path}.provider`),
    router: address(entry.router, `${path}.router`),
    quotedAmountOut: amount(entry.quotedAmountOut, `${path}.quotedAmountOut`),
    minAmountOut: amount(entry.minAmountOut, `${path}.minAmountOut`),
    deviationBps: integer(entry.deviationBps, `${path}.deviationBps`, -1_000_000, 1_000_000),
    minimumDeviationBps: integer(entry.minimumDeviationBps, `${path}.minimumDeviationBps`, -1_000_000, 1_000_000),
    deadline: instant(entry.deadline, `${path}.deadline`),
    gasEstimate: amount(entry.gasEstimate, `${path}.gasEstimate`),
    routeId: text(entry.routeId, `${path}.routeId`),
  };
}

function leg(value: unknown, path: string): PlanLeg {
  const entry = record(value, path);
  return {
    side: oneOf(entry.side, ["sell", "buy"] as const, `${path}.side`),
    token: address(entry.token, `${path}.token`),
    symbol: nullable(entry.symbol, (symbol) => text(symbol, `${path}.symbol`)),
    decimals: integer(entry.decimals, `${path}.decimals`, 0, 36),
    tokenIn: address(entry.tokenIn, `${path}.tokenIn`),
    tokenOut: address(entry.tokenOut, `${path}.tokenOut`),
    amountIn: amount(entry.amountIn, `${path}.amountIn`),
    referencePriceE8: amount(entry.referencePriceE8, `${path}.referencePriceE8`),
    referenceStatus: text(entry.referenceStatus, `${path}.referenceStatus`),
    referenceAmountOut: amount(entry.referenceAmountOut, `${path}.referenceAmountOut`),
    quote: nullable(entry.quote, (inner) => quote(inner, `${path}.quote`)),
  };
}

function call(value: unknown, path: string): PlanCall {
  const entry = record(value, path);
  return {
    kind: oneOf(entry.kind, ["approve", "swap"] as const, `${path}.kind`),
    to: address(entry.to, `${path}.to`),
    data: hex(entry.data, `${path}.data`),
    value: amount(entry.value, `${path}.value`),
    token: address(entry.token, `${path}.token`),
    leg: nullable(entry.leg, (index) => integer(index, `${path}.leg`, 0, 1_000)),
    minAmountOut: nullable(entry.minAmountOut, (minimum) => amount(minimum, `${path}.minAmountOut`)),
  };
}

function approval(value: unknown, path: string): PlanApproval {
  const entry = record(value, path);
  if (typeof entry.required !== "boolean") throw new PlanShapeError(`${path}.required`);
  return {
    token: address(entry.token, `${path}.token`),
    spender: address(entry.spender, `${path}.spender`),
    currentAllowance: amount(entry.currentAllowance, `${path}.currentAllowance`),
    amount: amount(entry.amount, `${path}.amount`),
    required: entry.required,
  };
}

function totals(value: unknown, path: string): PlanTotals {
  const entry = record(value, path);
  return {
    usdcBalance: amount(entry.usdcBalance, `${path}.usdcBalance`),
    minUsdcFromSells: amount(entry.minUsdcFromSells, `${path}.minUsdcFromSells`),
    maxUsdcForBuys: amount(entry.maxUsdcForBuys, `${path}.maxUsdcForBuys`),
    endBalances: array(entry.endBalances, `${path}.endBalances`).map((item, index) => {
      const balance = record(item, `${path}.endBalances[${index}]`);
      const at = `${path}.endBalances[${index}]`;
      // A negative `after` is refused as malformed: a plan never spends more than the account holds.
      return {
        token: address(balance.token, `${at}.token`),
        before: amount(balance.before, `${at}.before`),
        after: amount(balance.after, `${at}.after`),
      };
    }),
  };
}

/**
 * Parses the JSON body of a successful answer.
 *
 * @throws {PlanShapeError} if any field is missing, of another type or out of its range
 */
export function parseExecutionPlan(body: unknown): ExecutionPlanView {
  const root = record(body, "$");
  const data = record(root.data, "data");
  const meta = record(root.meta, "meta");
  const registry = record(meta.registry, "meta.registry");
  const index = record(data.index, "data.index");
  const provider = record(data.provider, "data.provider");
  const status = oneOf(data.status, ["ready", "blocked"] as const, "data.status");
  if (typeof data.executable !== "boolean") throw new PlanShapeError("data.executable");
  const block = nullable(data.checkedAtBlock, (value) => record(value, "data.checkedAtBlock"));
  return {
    address: address(data.address, "data.address"),
    index: {
      indexId: hex(index.indexId, "data.index.indexId", 32),
      identifier: text(index.identifier, "data.index.identifier"),
      name: text(index.name, "data.index.name"),
      version: integer(index.version, "data.index.version", 1, 2 ** 32 - 1),
    },
    chainId: integer(data.chainId, "data.chainId", 1, Number.MAX_SAFE_INTEGER),
    statement: text(data.statement, "data.statement"),
    mode: oneOf(data.mode, ["rebalance", "buy_only"] as const, "data.mode"),
    slippageBps: integer(data.slippageBps, "data.slippageBps", 0, 10_000),
    providerRouter: address(provider.router, "data.provider.router"),
    status,
    executable: data.executable,
    expiresAt: nullable(data.expiresAt, (value) => instant(value, "data.expiresAt")),
    checkedAtBlock:
      block === null
        ? null
        : {
            number: amount(block.number, "data.checkedAtBlock.number"),
            timestamp: instant(block.timestamp, "data.checkedAtBlock.timestamp"),
          },
    legs: array(data.legs, "data.legs").map((item, position) => leg(item, `data.legs[${position}]`)),
    checks: array(data.checks, "data.checks").map((item, position) => check(item, `data.checks[${position}]`)),
    blockedBy: array(data.blockedBy, "data.blockedBy").map((item, position) =>
      check(item, `data.blockedBy[${position}]`),
    ),
    warnings: array(data.warnings, "data.warnings").map((item, position) => check(item, `data.warnings[${position}]`)),
    approvals: array(data.approvals, "data.approvals").map((item, position) =>
      approval(item, `data.approvals[${position}]`),
    ),
    calls: nullable(data.calls, (value) =>
      array(value, "data.calls").map((item, position) => call(item, `data.calls[${position}]`)),
    ),
    totals: nullable(data.totals, (value) => totals(value, "data.totals")),
    planHash: nullable(data.planHash, (value) => hex(value, "data.planHash", 32)),
    registry: {
      chainId: integer(registry.chainId, "meta.registry.chainId", 1, Number.MAX_SAFE_INTEGER),
      address: address(registry.address, "meta.registry.address"),
    },
  };
}

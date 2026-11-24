import "server-only";
import {
  type Address,
  decodeErrorResult,
  decodeFunctionResult,
  type Hex,
  isHex,
  type PublicClient,
  parseAbi,
  toHex,
} from "viem";
import type { MarketClient } from "@/server/market/onchain";

/** The market data client, plus raw JSON-RPC requests for `eth_simulateV1` and `eth_call`. */
export type ExecutionClient = MarketClient & Pick<PublicClient, "request">;

/** One call of the plan, in execution order. */
export interface PlannedCall {
  readonly kind: "approve" | "swap";
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  /** Approve: the token approved. Swap: the token sold. */
  readonly token: Address;
  /** Index of the leg a swap executes, `null` for an approval. */
  readonly leg: number | null;
  /** Swap only: the minimum amount out the router enforces. */
  readonly minAmountOut: bigint | null;
}

/**
 * - `eth_simulateV1`: the whole sequence was executed in order on one simulated block, each call on the state
 *   the previous ones left.
 * - `eth_call`: calls were executed one by one on the state of the block. Their sequence was not simulated.
 */
export type SimulationMethod = "eth_simulateV1" | "eth_call";

export type CallOutcome =
  | { readonly status: "success"; readonly returnAmount: bigint | null }
  | { readonly status: "reverted"; readonly error: string }
  | { readonly status: "not_simulated" };

export interface SimulationOutcome {
  readonly method: SimulationMethod;
  readonly calls: readonly CallOutcome[];
}

/** Errors a reverted call is decoded with: those of the B20 transfer path. Anything else is reported raw. */
const revertAbi = parseAbi([
  "error ContractPaused(uint8 feature)",
  "error InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error InvalidReceiver(address receiver)",
  "error PolicyForbids(bytes32 policyScope, uint64 policyId)",
]);
const swapResultAbi = parseAbi(["function swap() returns (uint256 returnAmount, uint256 gasUsed)"]);

/** Name of the error in revert data: a B20 error, `Error` or `Panic`, else `unknown`. Never its text. */
function errorName(data: unknown): string {
  if (typeof data !== "string" || !isHex(data) || data.length < 10) return "unknown";
  try {
    return decodeErrorResult({ abi: revertAbi, data }).errorName;
  } catch {
    return "unknown";
  }
}

function successOf(call: PlannedCall, data: Hex): CallOutcome {
  if (call.kind !== "swap") return { status: "success", returnAmount: null };
  try {
    const [returnAmount] = decodeFunctionResult({ abi: swapResultAbi, functionName: "swap", data });
    return { status: "success", returnAmount };
  } catch {
    return { status: "reverted", error: "undecodable_return" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The outcome of each call from an `eth_simulateV1` answer, or `null` when the answer is not of that shape. */
function parseSimulation(answer: unknown, calls: readonly PlannedCall[]): CallOutcome[] | null {
  const block = Array.isArray(answer) && answer.length === 1 ? answer[0] : null;
  const results = isRecord(block) && Array.isArray(block.calls) ? block.calls : null;
  if (results === null || results.length !== calls.length) return null;
  const outcomes: CallOutcome[] = [];
  for (const [index, entry] of results.entries()) {
    const call = calls[index];
    if (!isRecord(entry) || call === undefined || !isHex(entry.returnData)) return null;
    if (entry.status === "0x1") outcomes.push(successOf(call, entry.returnData));
    else if (entry.status === "0x0") {
      const data = isRecord(entry.error) && isHex(entry.error.data) ? entry.error.data : entry.returnData;
      outcomes.push({ status: "reverted", error: errorName(data) });
    } else return null;
  }
  return outcomes;
}

/** Revert data carried by a failed `eth_call`, at the depth viem and the nodes put it. */
function revertData(error: unknown): Hex | null {
  let cause = error;
  for (let depth = 0; isRecord(cause) && depth < 6; depth += 1) {
    const { data } = cause;
    if (typeof data === "string" && isHex(data)) return data;
    if (isRecord(data) && typeof data.data === "string" && isHex(data.data)) return data.data;
    cause = cause.cause;
  }
  return null;
}

/**
 * The JSON-RPC error code an endpoint answered with, or `null` when the request did not get an answer. viem
 * gives `-1` to a failure it cannot attribute to the endpoint, which is not an answer.
 */
function rpcErrorCode(error: unknown): number | null {
  let cause = error;
  for (let depth = 0; isRecord(cause) && depth < 6; depth += 1) {
    if (typeof cause.code === "number" && cause.code !== -1) return cause.code;
    cause = cause.cause;
  }
  return null;
}

/** Whether a failed `eth_call` is an execution revert, as opposed to a failure of the endpoint. */
function isRevert(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; isRecord(cause) && depth < 6; depth += 1) {
    if (cause.code === 3 || (typeof cause.details === "string" && /revert/i.test(cause.details))) return true;
    cause = cause.cause;
  }
  return revertData(error) !== null;
}

/**
 * Simulates the calls from `account` at `blockNumber`, read-only.
 *
 * The whole sequence is executed with `eth_simulateV1` when the endpoint serves it, with validation off so
 * that gas price and nonce do not matter. A transport failure of that request is retried once. When the
 * endpoint answers that it does not serve it, or the request fails twice, each call is executed alone with `eth_call`, and only the
 * calls whose index is in `simulableAlone` (their approval and their input balance are already in place) are:
 * the others are `not_simulated`. Allowances are not overridden: the tokens are precompiles whose storage
 * layout is not published, so a state override would not be one the chain applies.
 */
export async function simulateSequence(
  client: ExecutionClient,
  account: Address,
  blockNumber: bigint,
  calls: readonly PlannedCall[],
  simulableAlone: ReadonlySet<number>,
): Promise<SimulationOutcome> {
  const block = toHex(blockNumber);
  const request = (call: PlannedCall) => ({ from: account, to: call.to, data: call.data, value: toHex(call.value) });
  const simulate = () =>
    client.request({
      method: "eth_simulateV1",
      params: [{ blockStateCalls: [{ calls: calls.map(request) }], validation: false, traceTransfers: false }, block],
    });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const outcomes = parseSimulation(await simulate(), calls);
      if (outcomes !== null) return { method: "eth_simulateV1", calls: outcomes };
      break;
    } catch (error) {
      // An answer of the endpoint (a JSON-RPC error: not served, not supported) is final. A transport failure
      // is retried once.
      if (rpcErrorCode(error) !== null) break;
    }
  }
  const outcomes: CallOutcome[] = [];
  for (const [index, call] of calls.entries()) {
    if (!simulableAlone.has(index)) {
      outcomes.push({ status: "not_simulated" });
      continue;
    }
    try {
      const data = await client.request({ method: "eth_call", params: [request(call), block] });
      outcomes.push(isHex(data) ? successOf(call, data) : { status: "not_simulated" });
    } catch (error) {
      outcomes.push(
        isRevert(error) ? { status: "reverted", error: errorName(revertData(error)) } : { status: "not_simulated" },
      );
    }
  }
  return { method: "eth_call", calls: outcomes };
}

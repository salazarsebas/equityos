import { type Abi, decodeErrorResult, type Hex, isHex } from "viem";
import { walletErrorSignature } from "@/lib/wallet/errors";

/**
 * Why a simulation or a transaction did not go through.
 *
 * - `user_rejected`: the user declined in the wallet.
 * - `contract_error`: the contract reverted with a custom error of its ABI, decoded by name and arguments.
 * - `revert`: the contract reverted with a plain reason, a panic, or data no error of the ABI matches.
 * - `insufficient_funds`: the account cannot pay for the transaction.
 * - `wallet_busy`: the wallet already has a request waiting for the user.
 * - `chain_mismatch`: the wallet is on another chain than the one the transaction is for.
 * - `unknown`: none of the above. The raw text of a wallet or node error is never shown to a user.
 */
export type TxFailure =
  | { readonly kind: "user_rejected" }
  | { readonly kind: "contract_error"; readonly name: string; readonly args: readonly unknown[] }
  | { readonly kind: "revert"; readonly reason: string | null }
  | { readonly kind: "insufficient_funds" }
  | { readonly kind: "wallet_busy" }
  | { readonly kind: "chain_mismatch" }
  | { readonly kind: "unknown" };

function revertDataOf(value: unknown): Hex | null {
  return typeof value === "string" && isHex(value) && value.length >= 10 ? value : null;
}

/**
 * The revert data of a failed call. Libraries wrap the JSON-RPC error several causes deep, and nodes put the
 * data either directly under `data` or one level below it.
 */
export function findRevertData(error: unknown): Hex | null {
  let cause = error;
  for (let depth = 0; typeof cause === "object" && cause !== null && depth < 8; depth += 1) {
    const raw = "raw" in cause ? revertDataOf(cause.raw) : null;
    if (raw !== null) return raw;
    if ("data" in cause) {
      const { data } = cause;
      const direct = revertDataOf(data);
      if (direct !== null) return direct;
      const nested = typeof data === "object" && data !== null && "data" in data ? revertDataOf(data.data) : null;
      if (nested !== null) return nested;
    }
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return null;
}

function messagesOf(error: unknown): string {
  const parts: string[] = [];
  let cause = error;
  for (let depth = 0; typeof cause === "object" && cause !== null && depth < 8; depth += 1) {
    if ("message" in cause && typeof cause.message === "string") parts.push(cause.message);
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return parts.join("\n");
}

/** Decodes revert data with the ABI. `Error(string)` and `Panic(uint256)` are understood without being in it. */
export function decodeRevertData(abi: Abi, data: Hex): TxFailure {
  try {
    const { errorName, args } = decodeErrorResult({ abi, data });
    if (errorName === "Error") return { kind: "revert", reason: typeof args?.[0] === "string" ? args[0] : null };
    if (errorName === "Panic") return { kind: "revert", reason: `panic ${String(args?.[0])}` };
    return { kind: "contract_error", name: errorName, args: args ?? [] };
  } catch {
    return { kind: "revert", reason: null };
  }
}

/**
 * Classifies an error thrown by a simulation, a gas estimate or a send. The revert data is decoded here with
 * the given ABI and never taken from a decoding a library made against another one.
 */
export function classifyTxError(abi: Abi, error: unknown): TxFailure {
  const { codes, names } = walletErrorSignature(error);
  if (codes.has(4001) || codes.has(5000) || names.has("UserRejectedRequestError")) return { kind: "user_rejected" };
  const data = findRevertData(error);
  if (data !== null) return decodeRevertData(abi, data);
  if (codes.has(-32002)) return { kind: "wallet_busy" };
  if (names.has("ChainMismatchError") || names.has("ConnectorChainMismatchError")) return { kind: "chain_mismatch" };
  if (names.has("InsufficientFundsError") || /insufficient funds/i.test(messagesOf(error))) {
    return { kind: "insufficient_funds" };
  }
  if (names.has("ContractFunctionRevertedError") || names.has("ExecutionRevertedError")) {
    return { kind: "revert", reason: null };
  }
  return { kind: "unknown" };
}

/** A sentence for a failure that no contract-specific message covers. States what happened and what is true now. */
export function txFailureMessage(failure: TxFailure): string {
  switch (failure.kind) {
    case "user_rejected":
      return "You declined the request in the wallet. Nothing was sent.";
    case "contract_error":
      return `The contract would reject this call with ${failure.name}. Nothing was sent.`;
    case "revert":
      return failure.reason === null
        ? "The contract would reject this call. Nothing was sent."
        : `The contract would reject this call: ${failure.reason}. Nothing was sent.`;
    case "insufficient_funds":
      return "The account does not hold enough ETH to pay for this transaction. Nothing was sent.";
    case "wallet_busy":
      return "The wallet already has a request waiting. Open the wallet and answer it. Nothing was sent.";
    case "chain_mismatch":
      return "The wallet is on another network than this transaction is for. Nothing was sent.";
    case "unknown":
      return "The wallet or the network did not accept the request. Nothing was sent.";
  }
}

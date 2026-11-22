import { isMethodUnsupported, walletErrorSignature } from "./errors";

/**
 * Whether a wallet can execute several calls as one batch, decided from its answer to `wallet_getCapabilities`
 * (EIP-5792). Pure: the hook `useWalletCapabilities` feeds it the answer or the error.
 *
 * - `atomic`: the wallet states that it executes a batch atomically. One confirmation for several steps.
 * - `sequential`: the wallet answered and does not batch, or does not implement the method. One confirmation
 *   per step.
 * - `unknown`: there is no usable answer. Support is never assumed: callers treat it as `sequential` at most.
 */
export type BatchingMode = "atomic" | "sequential" | "unknown";

/**
 * What the decision rests on.
 * - `atomic_supported`: `atomic.status` is `supported`.
 * - `atomic_ready`: `atomic.status` is `ready`. The wallet batches once the user approves an account upgrade,
 *   which it proposes itself when a batch is sent.
 * - `legacy_atomic_batch`: `atomicBatch.supported` is `true`, the name of the capability before the EIP was
 *   final, which some wallets still report.
 * - `atomic_unsupported`: the wallet reports the capability as unsupported.
 * - `not_reported`: the wallet answered without an atomic capability for the chain. The EIP defines this as no
 *   batching support.
 * - `method_unsupported`: the wallet does not implement `wallet_getCapabilities`.
 * - `pending`: no answer yet.
 * - `request_failed`: the request failed for another reason, such as a locked or disconnected wallet.
 * - `malformed`: the answer does not have the shape the EIP defines.
 */
export type BatchingReason =
  | "atomic_supported"
  | "atomic_ready"
  | "legacy_atomic_batch"
  | "atomic_unsupported"
  | "not_reported"
  | "method_unsupported"
  | "pending"
  | "request_failed"
  | "malformed";

export interface Batching {
  readonly mode: BatchingMode;
  readonly reason: BatchingReason;
}

export const BATCHING_PENDING: Batching = { mode: "unknown", reason: "pending" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Capabilities of one chain in an answer keyed by chain id. Wallets key by hex string, viem rekeys by number,
 * and the id `0x0` holds capabilities that apply to every chain, which the entry of the chain overrides.
 */
function chainCapabilities(payload: Record<string, unknown>, chainId: number): Record<string, unknown> | "malformed" {
  const merged: Record<string, unknown> = {};
  for (const id of [0, chainId]) {
    for (const [key, value] of Object.entries(payload)) {
      if (!/^(0x[0-9a-f]+|[0-9]+)$/i.test(key) || Number(key) !== id) continue;
      if (!isRecord(value)) return "malformed";
      Object.assign(merged, value);
    }
  }
  return merged;
}

/**
 * Decides the batching mode on one chain from a `wallet_getCapabilities` answer.
 *
 * @param payload the answer, keyed by chain id, as the wallet returned it or as viem rekeyed it
 * @param chainId the chain the account is connected on
 */
export function classifyCapabilities(payload: unknown, chainId: number): Batching {
  if (!isRecord(payload)) return { mode: "unknown", reason: "malformed" };
  const capabilities = chainCapabilities(payload, chainId);
  if (capabilities === "malformed") return { mode: "unknown", reason: "malformed" };

  const { atomic, atomicBatch } = capabilities;
  if (atomic !== undefined) {
    // The EIP names the property `status`. The Coinbase Wallet SDK reference documents the same three values
    // under `supported`, so a status string is read from either.
    const status = isRecord(atomic) ? (atomic.status ?? atomic.supported) : undefined;
    if (status === "supported") return { mode: "atomic", reason: "atomic_supported" };
    if (status === "ready") return { mode: "atomic", reason: "atomic_ready" };
    if (status === "unsupported") return { mode: "sequential", reason: "atomic_unsupported" };
    return { mode: "unknown", reason: "malformed" };
  }
  if (atomicBatch !== undefined) {
    const supported = isRecord(atomicBatch) ? atomicBatch.supported : undefined;
    if (supported === true) return { mode: "atomic", reason: "legacy_atomic_batch" };
    if (supported === false) return { mode: "sequential", reason: "atomic_unsupported" };
    return { mode: "unknown", reason: "malformed" };
  }
  return { mode: "sequential", reason: "not_reported" };
}

/**
 * Decides the batching mode from a failed `wallet_getCapabilities` request. A wallet that does not implement the
 * method cannot batch, so that is `sequential`. Any other failure says nothing about the wallet: `unknown`.
 */
export function classifyCapabilitiesError(error: unknown): Batching {
  return isMethodUnsupported(walletErrorSignature(error))
    ? { mode: "sequential", reason: "method_unsupported" }
    : { mode: "unknown", reason: "request_failed" };
}

/** What a batching decision means for a person: how many confirmations an action with several steps asks for. */
export function describeBatching({ mode, reason }: Batching): { readonly label: string; readonly meaning: string } {
  if (reason === "atomic_ready") {
    return {
      label: "One confirmation, after an account upgrade",
      meaning:
        "This wallet can send several steps as one batch once you approve the account upgrade it proposes. Until then it asks you to confirm each step.",
    };
  }
  if (mode === "atomic") {
    return {
      label: "One confirmation",
      meaning:
        "This wallet sends several steps as one batch, so an action with several steps asks you to confirm once, and all of its steps succeed or none does.",
    };
  }
  if (mode === "sequential") {
    return {
      label: "One confirmation per step",
      meaning: "This wallet does not batch, so an action with several steps asks you to confirm each step in turn.",
    };
  }
  if (reason === "pending") {
    return { label: "Checking", meaning: "Asking the wallet whether it can send several steps as one batch." };
  }
  return {
    label: "Not determined",
    meaning:
      "The wallet did not say whether it can batch. It is treated as not batching: each step is confirmed in turn.",
  };
}

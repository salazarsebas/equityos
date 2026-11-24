/**
 * The single decision whether a click may send an execution plan, and exactly what. Pure: the component calls
 * the wallet with the request returned here and nothing else, so every safeguard below is a safeguard of the
 * send. The click handler exists only when the decision is `ok`.
 */
import { type Address, type Hex, isAddressEqual } from "viem";
import type { Batching } from "@/lib/wallet/capabilities";
import { withSuffix } from "./builder-code";
import type { ExecutionSnapshot } from "./snapshot";
import type { VerificationFailure, VerifiedCall } from "./verify";

/** The acknowledgement of each warning, bound to the plan it was given for. Void for any other plan. */
export interface Acknowledgements {
  readonly planHash: Hex;
  readonly keys: ReadonlySet<string>;
}

/** What one call of the request does, for the review and the progress list. */
export type ExecutionStep =
  | { readonly kind: "approve"; readonly call: number }
  | { readonly kind: "swap"; readonly call: number }
  | { readonly kind: "attestation" };

/** One call as the wallet receives it. */
export interface SentCall {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

/** The exact arguments of wagmi `sendCalls`. `forceAtomic: true` is sent as `atomicRequired: true`. */
export interface AtomicSendCalls {
  readonly account: Address;
  readonly chainId: number;
  readonly calls: readonly SentCall[];
  readonly forceAtomic: true;
  /** ERC-8021 Builder Code: the wallet appends it to the transaction it builds. Optional for the wallet. */
  readonly capabilities?: { readonly dataSuffix: { readonly value: Hex; readonly optional: true } };
}

/** The exact arguments of one wagmi `sendTransaction`. */
export interface SequentialTransaction {
  readonly account: Address;
  readonly chainId: number;
  readonly to: Address;
  /** The verified calldata, with the Builder Code suffix appended when one is configured. */
  readonly data: Hex;
  readonly value: bigint;
}

export type ExecutionRequest =
  | {
      readonly mode: "atomic";
      readonly sendCalls: AtomicSendCalls;
      /** One entry per call of `sendCalls.calls`, in order. The attestation, when included, is last. */
      readonly steps: readonly ExecutionStep[];
      readonly expiresAt: number;
    }
  | {
      readonly mode: "sequential";
      readonly account: Address;
      readonly chainId: number;
      /** Approvals and swaps, sent one at a time in this order, each after the previous one confirmed. */
      readonly transactions: readonly SequentialTransaction[];
      readonly steps: readonly ExecutionStep[];
      /** Offered after every transaction confirmed, never required. `null` when it is omitted. */
      readonly attestation: SequentialTransaction | null;
      readonly expiresAt: number;
    };

export type ExecutionRefusal =
  | { readonly reason: "no_plan" }
  | { readonly reason: "execution_unavailable" }
  | { readonly reason: "busy" }
  | { readonly reason: "verification_failed"; readonly failures: readonly VerificationFailure[] }
  | { readonly reason: "hash_mismatch" }
  | { readonly reason: "wrong_account" }
  | { readonly reason: "wrong_network"; readonly walletChainId: number | null; readonly chainId: number }
  | { readonly reason: "chain_time_unknown" }
  | { readonly reason: "expired"; readonly expiresAt: number; readonly chainTime: number }
  | { readonly reason: "warnings_not_acknowledged"; readonly missing: readonly string[] };

export type ExecutionDecision =
  | { readonly ok: true; readonly request: ExecutionRequest }
  | { readonly ok: false; readonly refusal: ExecutionRefusal };

/** What is true of the page around the plan: the availability gate and whether something is in flight. */
export interface ExecutionGate {
  readonly executionAvailable: boolean;
  /** A request is with the wallet or the chain, or one was already sent from this snapshot. */
  readonly busy: boolean;
}

function stepOf(call: VerifiedCall, index: number): ExecutionStep {
  return call.kind === "approve" ? { kind: "approve", call: index } : { kind: "swap", call: index };
}

/**
 * Refusals that hold at every send of a plan: the account, the network and the expiry by chain time. Also run
 * again before each transaction of the sequential path, since the wallet or the chain may have moved between
 * two confirmations.
 *
 * @param chainTime timestamp of the latest block of the plan's chain, Unix seconds, read at the moment of the
 *   decision; `null` when it could not be read. The device clock is never used.
 */
export function sendPreconditions(
  target: { readonly account: Address; readonly chainId: number; readonly expiresAt: number },
  account: Address | null,
  walletChainId: number | null,
  chainTime: number | null,
): ExecutionRefusal | null {
  if (account === null || !isAddressEqual(account, target.account)) return { reason: "wrong_account" };
  if (walletChainId !== target.chainId) return { reason: "wrong_network", walletChainId, chainId: target.chainId };
  if (chainTime === null) return { reason: "chain_time_unknown" };
  if (chainTime >= target.expiresAt) return { reason: "expired", expiresAt: target.expiresAt, chainTime };
  return null;
}

/**
 * Decides whether a click may send the plan of `snapshot`, and returns the exact request when it may.
 *
 * Atomic wallets get one `sendCalls` with every call in order and `atomicRequired`, the attestation last when it
 * is included, so the swaps and the attestation land together or not at all. Every other wallet, an `unknown`
 * one included, gets the ordered list of transactions to send one at a time, and the attestation separately.
 *
 * @param now timestamp of the latest block of the plan's chain, read at the click; `null` if unread
 */
export function buildExecutionRequest(
  snapshot: ExecutionSnapshot | null,
  account: Address | null,
  walletChainId: number | null,
  capabilities: Batching,
  acknowledgements: Acknowledgements | null,
  now: number | null,
  gate: ExecutionGate,
): ExecutionDecision {
  const refuse = (refusal: ExecutionRefusal): ExecutionDecision => ({ ok: false, refusal });
  if (snapshot === null) return refuse({ reason: "no_plan" });
  if (!gate.executionAvailable) return refuse({ reason: "execution_unavailable" });
  if (gate.busy) return refuse({ reason: "busy" });
  const { verification, plan } = snapshot;
  if (!verification.ok) return refuse({ reason: "verification_failed", failures: verification.failures });
  if (!verification.hashMatches || plan.planHash === null) return refuse({ reason: "hash_mismatch" });
  const target = { account: snapshot.account, chainId: plan.chainId, expiresAt: verification.expiresAt };
  const precondition = sendPreconditions(target, account, walletChainId, now);
  if (precondition !== null) return refuse(precondition);
  const acknowledged = acknowledgements?.planHash === plan.planHash ? acknowledgements.keys : new Set<string>();
  const missing = snapshot.warningKeys.filter((key) => !acknowledged.has(key));
  if (missing.length > 0) return refuse({ reason: "warnings_not_acknowledged", missing });

  const { suffix, attestation } = snapshot;
  const calls = verification.calls.map(({ to, data, value }) => ({ to, data, value }));
  const steps = verification.calls.map(stepOf);
  if (capabilities.mode === "atomic") {
    const withAttestation =
      attestation.status === "included"
        ? [...calls, { to: attestation.call.to, data: attestation.call.data, value: attestation.call.value }]
        : calls;
    return {
      ok: true,
      request: {
        mode: "atomic",
        sendCalls: {
          account: target.account,
          chainId: target.chainId,
          calls: withAttestation,
          forceAtomic: true,
          ...(suffix === null ? {} : { capabilities: { dataSuffix: { value: suffix, optional: true } } }),
        },
        steps: attestation.status === "included" ? [...steps, { kind: "attestation" }] : steps,
        expiresAt: target.expiresAt,
      },
    };
  }
  const transaction = (call: SentCall): SequentialTransaction => ({
    account: target.account,
    chainId: target.chainId,
    to: call.to,
    data: withSuffix(call.data, suffix),
    value: call.value,
  });
  return {
    ok: true,
    request: {
      mode: "sequential",
      account: target.account,
      chainId: target.chainId,
      transactions: calls.map(transaction),
      steps,
      attestation: attestation.status === "included" ? transaction(attestation.call) : null,
      expiresAt: target.expiresAt,
    },
  };
}

export type AttestationRefusal =
  | { readonly reason: "not_included" }
  | { readonly reason: "swaps_not_confirmed" }
  | { readonly reason: "busy" }
  | { readonly reason: "wrong_account" }
  | { readonly reason: "wrong_network"; readonly walletChainId: number | null; readonly chainId: number };

/**
 * Whether the optional attestation of the sequential path may be sent now: only once every transaction of the
 * plan confirmed, from the same account on the same chain. It has no expiry: it names a version and moves
 * nothing, so it does not depend on the quotes.
 */
export function buildAttestationRequest(
  request: ExecutionRequest,
  confirmed: number,
  account: Address | null,
  walletChainId: number | null,
  busy: boolean,
):
  | { readonly ok: true; readonly transaction: SequentialTransaction }
  | { readonly ok: false; readonly refusal: AttestationRefusal } {
  if (request.mode !== "sequential" || request.attestation === null) {
    return { ok: false, refusal: { reason: "not_included" } };
  }
  if (confirmed !== request.transactions.length) return { ok: false, refusal: { reason: "swaps_not_confirmed" } };
  if (busy) return { ok: false, refusal: { reason: "busy" } };
  if (account === null || !isAddressEqual(account, request.account)) {
    return { ok: false, refusal: { reason: "wrong_account" } };
  }
  if (walletChainId !== request.chainId) {
    return { ok: false, refusal: { reason: "wrong_network", walletChainId, chainId: request.chainId } };
  }
  return { ok: true, transaction: request.attestation };
}

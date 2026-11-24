import { indexRegistryAbi } from "@equityos/contracts-abi";
import { type Address, type Hex, isAddressEqual } from "viem";
import type { TxState } from "@/lib/tx/machine";
import type { ChecklistItem } from "./preflight";
import type { NetworkPolicy, PublishPlan } from "./publish";

/**
 * Identity of a plan: everything that changes what the transaction does. An acknowledgement is given for one
 * plan and is void for any other, so editing the draft, changing the salt or switching account withdraws it.
 */
export function publishPlanKey(plan: PublishPlan): string {
  return [plan.chainId, plan.registry.toLowerCase(), plan.creator.toLowerCase(), plan.salt, plan.specHash].join(":");
}

/** The acknowledgement of a real transaction on a network that requires it, bound to the plan it was given for. */
export type Acknowledgement = { readonly planKey: string } | null;

/**
 * Transaction states after which an acknowledgement no longer holds: the attempt ended without publishing, and a
 * new attempt is a new decision.
 */
const ACKNOWLEDGEMENT_ENDS: readonly TxState<unknown>["status"][] = [
  "rejected",
  "failed",
  "reverted",
  "replaced",
  "dropped",
];

export function acknowledgementEnds(state: TxState<unknown>): boolean {
  return ACKNOWLEDGEMENT_ENDS.includes(state.status);
}

/** The exact arguments of `writeContract`. The component passes them through without adding or changing any. */
export interface PublishWriteRequest {
  /** wagmi refuses to send when the wallet reports another chain than this one. */
  readonly chainId: number;
  readonly account: Address;
  readonly address: Address;
  readonly abi: typeof indexRegistryAbi;
  readonly functionName: "createIndex";
  readonly args: readonly [Hex, Hex, readonly Address[], readonly number[]];
}

export type PublishRefusal =
  | { readonly reason: "no_plan" }
  | { readonly reason: "not_available" }
  | { readonly reason: "registry_mismatch" }
  | { readonly reason: "busy" }
  | { readonly reason: "wrong_network"; readonly walletChainId: number | null }
  | { readonly reason: "checks_incomplete"; readonly items: readonly ChecklistItem["id"][] }
  | { readonly reason: "acknowledgement_missing" };

export type PublishDecision =
  /** `plan` is the plan the request was built from, for checking the result of the transaction. */
  | { readonly ok: true; readonly request: PublishWriteRequest; readonly plan: PublishPlan }
  | { readonly ok: false; readonly refusal: PublishRefusal };

export interface PublishDecisionInput {
  readonly plan: PublishPlan | null;
  readonly policy: NetworkPolicy;
  readonly acknowledgement: Acknowledgement;
  /** Chain the wallet reports now. */
  readonly walletChainId: number | null;
  readonly checklist: readonly ChecklistItem[];
  /** A transaction is with the wallet or the chain, or one was already mined. */
  readonly busy: boolean;
}

/**
 * The single decision whether a click may send, and what. It returns the `createIndex` request built from the
 * plan the review displays, or the first reason it may not be sent. The component calls `writeContract` with the
 * request and nothing else, so every safeguard here is a safeguard of the send.
 */
export function buildPublishRequest(input: PublishDecisionInput): PublishDecision {
  const { plan, policy, acknowledgement, walletChainId, checklist, busy } = input;
  const refuse = (refusal: PublishRefusal): PublishDecision => ({ ok: false, refusal });
  if (plan === null) return refuse({ reason: "no_plan" });
  if (policy.status !== "available") return refuse({ reason: "not_available" });
  if (!isAddressEqual(policy.deployment.registry, plan.registry)) return refuse({ reason: "registry_mismatch" });
  if (busy) return refuse({ reason: "busy" });
  if (walletChainId !== plan.chainId) return refuse({ reason: "wrong_network", walletChainId });
  const incomplete = checklist.filter(({ state }) => state !== "done").map(({ id }) => id);
  if (checklist.length === 0 || incomplete.length > 0)
    return refuse({ reason: "checks_incomplete", items: incomplete });
  if (policy.requiresAcknowledgement && acknowledgement?.planKey !== publishPlanKey(plan)) {
    return refuse({ reason: "acknowledgement_missing" });
  }
  return {
    ok: true,
    plan,
    request: {
      chainId: plan.chainId,
      account: plan.creator,
      address: plan.registry,
      abi: indexRegistryAbi,
      functionName: plan.functionName,
      args: plan.args,
    },
  };
}

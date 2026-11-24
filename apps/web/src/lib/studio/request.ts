import { indexRegistryAbi } from "@equityos/contracts-abi";
import { type Address, type Hex, isAddressEqual } from "viem";
import type { TxState } from "@/lib/tx/machine";
import type { ChecklistItem, OnchainIndex } from "./preflight";
import type { NetworkPolicy, StudioPlan, VersionPlan } from "./publish";

/**
 * Identity of a plan: everything that changes what the transaction does. An acknowledgement is given for one
 * plan and is void for any other, so editing the draft, changing the salt or switching account withdraws it.
 */
export function publishPlanKey(plan: StudioPlan): string {
  const target = plan.functionName === "createIndex" ? [plan.salt] : [plan.indexId, plan.version];
  return [
    plan.functionName,
    plan.chainId,
    plan.registry.toLowerCase(),
    plan.creator.toLowerCase(),
    ...target,
    plan.specHash,
  ].join(":");
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

interface WriteTarget {
  /** wagmi refuses to send when the wallet reports another chain than this one. */
  readonly chainId: number;
  readonly account: Address;
  readonly address: Address;
  readonly abi: typeof indexRegistryAbi;
}

/** The exact arguments of `writeContract`. The component passes them through without adding or changing any. */
export type PublishWriteRequest =
  | (WriteTarget & {
      readonly functionName: "createIndex";
      readonly args: readonly [Hex, Hex, readonly Address[], readonly number[]];
    })
  | (WriteTarget & {
      readonly functionName: "publishVersion";
      readonly args: readonly [Hex, number, Hex, readonly Address[], readonly number[]];
    });

export type PublishRefusal =
  | { readonly reason: "no_plan" }
  | { readonly reason: "not_available" }
  | { readonly reason: "registry_mismatch" }
  | { readonly reason: "busy" }
  | { readonly reason: "wrong_network"; readonly walletChainId: number | null }
  | { readonly reason: "checks_incomplete"; readonly items: readonly ChecklistItem["id"][] }
  | { readonly reason: "acknowledgement_missing" }
  /** A new version whose bytes are the latest version's: it would publish nothing new. */
  | { readonly reason: "unchanged" }
  /** A new version from an account that is not the creator of the index. */
  | { readonly reason: "not_creator"; readonly creator: Address }
  | { readonly reason: "deprecated" }
  /** Another version was published since the draft was loaded: `expectedVersion` would revert. */
  | { readonly reason: "version_moved"; readonly latestVersion: number }
  /** The index could not be read again at the click, so the version cannot be confirmed. */
  | { readonly reason: "index_unreadable" };

export type PublishDecision =
  /** `plan` is the plan the request was built from, for checking the result of the transaction. */
  | { readonly ok: true; readonly request: PublishWriteRequest; readonly plan: StudioPlan }
  | { readonly ok: false; readonly refusal: PublishRefusal };

export interface PublishDecisionInput {
  readonly plan: StudioPlan | null;
  readonly policy: NetworkPolicy;
  readonly acknowledgement: Acknowledgement;
  /** Chain the wallet reports now. */
  readonly walletChainId: number | null;
  readonly checklist: readonly ChecklistItem[];
  /** A transaction is with the wallet or the chain, or one was already mined. */
  readonly busy: boolean;
  /** A new version: the index as the registry holds it, read last. `null` while unread, and for a new index. */
  readonly index: OnchainIndex | null;
}

/** Why a `publishVersion` plan may not be sent against the index as the registry holds it, or `null`. */
function versionRefusal(plan: StudioPlan, index: OnchainIndex | null): PublishRefusal | null {
  if (plan.functionName !== "publishVersion") return null;
  if (plan.specHex.toLowerCase() === plan.baseSpecHex.toLowerCase()) return { reason: "unchanged" };
  if (index === null) return { reason: "checks_incomplete", items: ["creator", "active", "version"] };
  if (!isAddressEqual(index.creator, plan.creator)) return { reason: "not_creator", creator: index.creator };
  if (index.deprecated) return { reason: "deprecated" };
  if (index.latestVersion + 1 !== plan.version) return { reason: "version_moved", latestVersion: index.latestVersion };
  return null;
}

/** The `writeContract` arguments of a plan, for the function the plan names and nothing else. */
function writeRequest(plan: StudioPlan): PublishWriteRequest {
  const target = { chainId: plan.chainId, account: plan.creator, address: plan.registry, abi: indexRegistryAbi };
  return plan.functionName === "createIndex"
    ? { ...target, functionName: plan.functionName, args: plan.args }
    : { ...target, functionName: plan.functionName, args: plan.args };
}

/**
 * The single decision whether a click may send, and what. It returns the `createIndex` or `publishVersion`
 * request built from the plan the review displays, or the first reason it may not be sent. The component calls
 * `writeContract` with the request and nothing else, so every safeguard here is a safeguard of the send.
 */
export function buildPublishRequest(input: PublishDecisionInput): PublishDecision {
  const { plan, policy, acknowledgement, walletChainId, checklist, busy, index } = input;
  const refuse = (refusal: PublishRefusal): PublishDecision => ({ ok: false, refusal });
  if (plan === null) return refuse({ reason: "no_plan" });
  if (policy.status !== "available") return refuse({ reason: "not_available" });
  if (!isAddressEqual(policy.deployment.registry, plan.registry)) return refuse({ reason: "registry_mismatch" });
  if (busy) return refuse({ reason: "busy" });
  if (walletChainId !== plan.chainId) return refuse({ reason: "wrong_network", walletChainId });
  const refusal = versionRefusal(plan, index);
  if (refusal !== null) return refuse(refusal);
  const incomplete = checklist.filter(({ state }) => state !== "done").map(({ id }) => id);
  if (checklist.length === 0 || incomplete.length > 0)
    return refuse({ reason: "checks_incomplete", items: incomplete });
  if (policy.requiresAcknowledgement && acknowledgement?.planKey !== publishPlanKey(plan)) {
    return refuse({ reason: "acknowledgement_missing" });
  }
  return { ok: true, plan, request: writeRequest(plan) };
}

/**
 * The decision made at the click. For a new version the index is read from the registry again first, so the
 * expected version, the creator and the deprecation are the ones of the moment of sending and not of the
 * moment the review was drawn. A read that fails refuses: nothing is sent on a version that was not confirmed.
 */
export async function decideAtClick(
  input: PublishDecisionInput,
  readIndex: (plan: VersionPlan) => Promise<OnchainIndex>,
): Promise<PublishDecision> {
  const { plan } = input;
  if (plan?.functionName !== "publishVersion") return buildPublishRequest(input);
  let index: OnchainIndex;
  try {
    index = await readIndex(plan);
  } catch {
    return { ok: false, refusal: { reason: "index_unreadable" } };
  }
  return buildPublishRequest({ ...input, index });
}

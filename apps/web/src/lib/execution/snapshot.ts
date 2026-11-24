import type { Address, Hex } from "viem";
import { type AttestationPlan, planAttestation } from "./attestation";
import type { ExecutionNetwork } from "./networks";
import type { ExecutionPlanView, PlanCheck } from "./response";
import { type PlanVerification, verifyExecutionPlan } from "./verify";

/**
 * What the review shows and what a click may send, taken once when the plan arrives: the answer, its
 * verification for the account it was requested for, the attestation decision and the Builder Code suffix.
 * Nothing that changes later reaches it. It is frozen, so no code path can edit a call after it was verified.
 */
export interface ExecutionSnapshot {
  readonly plan: ExecutionPlanView;
  /** The account the plan was requested and verified for. */
  readonly account: Address;
  readonly network: ExecutionNetwork | null;
  readonly verification: PlanVerification;
  readonly attestation: AttestationPlan;
  /** The ERC-8021 suffix appended at sending, or `null` when no Builder Code is configured. */
  readonly suffix: Hex | null;
  /** One key per warning of the plan, each acknowledged on its own. */
  readonly warningKeys: readonly string[];
}

/** The key of a warning: its check, reason, token and leg. An acknowledgement names this key. */
export function warningKey(warning: PlanCheck): string {
  return [warning.check, warning.reason, warning.token ?? "-", warning.leg ?? "-"].join(":");
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

export interface SnapshotInput {
  readonly plan: ExecutionPlanView;
  readonly account: Address;
  readonly network: ExecutionNetwork | null;
  /** Constituents of the compared index version. */
  readonly constituents: readonly Address[];
  /** Code read at the `RebalanceLog` address of the plan's chain; see `planAttestation`. */
  readonly logCode: Hex | undefined | null;
  readonly suffix: Hex | null;
}

/** Verifies the plan and freezes everything a later click needs. */
export function takeExecutionSnapshot(input: SnapshotInput): ExecutionSnapshot {
  const { plan, account, network, constituents, logCode, suffix } = input;
  const verification = verifyExecutionPlan(plan, { account, network, constituents });
  const attestation: AttestationPlan =
    network === null
      ? { status: "omitted", reason: "not_deployed" }
      : planAttestation({ network, registry: plan.registry, index: plan.index, code: logCode });
  return deepFreeze({
    plan,
    account,
    network,
    verification,
    attestation,
    suffix,
    warningKeys: [...new Set(plan.warnings.map(warningKey))],
  });
}

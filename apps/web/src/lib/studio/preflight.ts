import { MAX_SPEC_BYTES } from "@equityos/core";
import type { Address, Hex } from "viem";
import { formatCount, formatTokenQuantity, shortenAddress } from "@/lib/format";
import type { TxFailure } from "@/lib/tx/errors";
import type { ValidDraft } from "./evaluate";
import { type NetworkPolicy, type PublishPlan, predictIdentifier } from "./publish";

/** The reads and dry runs made on the target chain before the publish button is enabled. */
export interface RegistryReads {
  /** Code at the registry address. */
  code(): Promise<Hex | undefined>;
  /** `computeIndexId(creator, salt)` on the registry, by `eth_call`. */
  computeIndexId(creator: Address, salt: Hex): Promise<Hex>;
  /** Every index id of the registry, in creation order. */
  indexIds(): Promise<readonly Hex[]>;
  /** Simulates the call from the creator. Rejects when the contract would revert. */
  simulate(plan: PublishPlan): Promise<void>;
  estimateGas(plan: PublishPlan): Promise<bigint>;
  /** Current maximum fee per gas, in wei. */
  maxFeePerGas(): Promise<bigint>;
  /** ETH balance of the account, in wei. */
  balance(account: Address): Promise<bigint>;
  /**
   * The L1 data fee of the transaction in wei, from the `GasPriceOracle` predeploy of an OP Stack chain such as
   * Base. `null` on a chain that charges none, such as a local node.
   */
  l1DataFee(plan: PublishPlan): Promise<bigint | null>;
}

/**
 * The balance must cover this multiple of the estimated fee. The estimate is read before signing and fees move
 * until the transaction is included, so an exact cover is not a safe one.
 */
export const BALANCE_MARGIN = 2n;

export type Preflight =
  /** There is no contract at the registry address on this chain. */
  | { readonly status: "no_code" }
  /** The registry derives another id than the one predicted locally. Nothing may be sent. */
  | { readonly status: "id_mismatch"; readonly onchainIndexId: Hex }
  | { readonly status: "simulation_failed"; readonly identifier: string; readonly failure: TxFailure }
  | {
      readonly status: "ready";
      /** Canonical identifier the index gets, given the indexes that exist now. */
      readonly identifier: string;
      readonly gas: bigint;
      readonly maxFeePerGasWei: bigint;
      /** Upper bound of the execution fee: `gas * maxFeePerGasWei`, in wei. */
      readonly feeWei: bigint;
      /** L1 data fee in wei, `null` on a chain that charges none. */
      readonly l1FeeWei: bigint | null;
      /** Execution fee plus L1 data fee, in wei. */
      readonly totalFeeWei: bigint;
      readonly balanceWei: bigint;
    };

/**
 * Checks a plan against the chain, in the order in which each result makes the next one meaningful: the
 * registry exists, it derives the predicted index id, the call simulates, and only then gas and fee.
 */
export async function runPreflight(
  reads: RegistryReads,
  plan: PublishPlan,
  classify: (error: unknown) => TxFailure,
): Promise<Preflight> {
  const code = await reads.code();
  if (code === undefined || code === "0x") return { status: "no_code" };
  const onchainIndexId = await reads.computeIndexId(plan.creator, plan.salt);
  if (onchainIndexId.toLowerCase() !== plan.indexId.toLowerCase()) return { status: "id_mismatch", onchainIndexId };
  const identifier = predictIdentifier(await reads.indexIds(), plan.indexId, plan.slug);
  try {
    await reads.simulate(plan);
  } catch (error) {
    return { status: "simulation_failed", identifier, failure: classify(error) };
  }
  const [gas, maxFeePerGasWei, balanceWei, l1FeeWei] = await Promise.all([
    reads.estimateGas(plan),
    reads.maxFeePerGas(),
    reads.balance(plan.creator),
    reads.l1DataFee(plan),
  ]);
  const feeWei = gas * maxFeePerGasWei;
  const totalFeeWei = feeWei + (l1FeeWei ?? 0n);
  return { status: "ready", identifier, gas, maxFeePerGasWei, feeWei, l1FeeWei, totalFeeWei, balanceWei };
}

/** `checking`: the reads are running. `failed`: the chain could not be read. `null`: nothing to check yet. */
export type PreflightState = Preflight | "checking" | "failed" | null;

export interface ChecklistItem {
  readonly id: "spec" | "hash" | "wallet" | "network" | "registry" | "index_id" | "simulation" | "fee" | "balance";
  readonly label: string;
  /** `todo` is for the user to do, `blocked` cannot be fixed from here, `checking` is being read. */
  readonly state: "done" | "todo" | "blocked" | "checking" | "waiting";
  readonly detail: string;
}

/** Whether the registry is on the chain: the deployment map first, then the code at the address. */
export type RegistryPresence = "not_deployed" | "checking" | "deployed" | "no_code" | "unreadable";

export interface ChecklistInput {
  readonly valid: ValidDraft | null;
  readonly issueCount: number;
  readonly networkName: string;
  readonly chainId: number;
  readonly policy: NetworkPolicy;
  readonly presence: RegistryPresence;
  readonly account: Address | null;
  readonly walletChainId: number | null;
  readonly preflight: PreflightState;
}

const eth = (wei: bigint) => `${formatTokenQuantity(wei, 18)} ETH`;

/**
 * The preconditions of a publication with their real state. Each item is derived from a value that was read
 * or computed, never assumed: an item that has not been checked is `waiting` or `checking`, not `done`.
 */
export function publishChecklist(input: ChecklistInput): ChecklistItem[] {
  const { valid, issueCount, networkName, chainId, policy, presence, account, walletChainId, preflight } = input;
  const items: ChecklistItem[] = [];
  const add = (id: ChecklistItem["id"], state: ChecklistItem["state"], label: string, detail: string) =>
    items.push({ id, state, label, detail });

  if (valid === null) {
    add("spec", "todo", "Valid spec", `${issueCount} ${issueCount === 1 ? "issue" : "issues"} to fix in the editor`);
    add("hash", "waiting", "Spec hash", "Exists once the spec is valid");
  } else {
    const size = `${formatCount(BigInt(valid.specBytes.length))} of ${formatCount(BigInt(MAX_SPEC_BYTES))} bytes`;
    add("spec", "done", "Valid spec", `Validated in this browser, ${size}`);
    add("hash", "done", "Spec hash", valid.specHash);
  }
  if (account === null) add("wallet", "todo", "Wallet", "Connect the wallet that will be the creator");
  else add("wallet", "done", "Wallet", `Connected. Creator ${shortenAddress(account)}`);
  if (account === null) add("network", "waiting", "Wallet network", "Needs a connected wallet");
  else if (walletChainId === chainId)
    add("network", "done", "Wallet network", `On ${networkName}, chain id ${chainId}`);
  else add("network", "todo", "Wallet network", `On chain ${walletChainId ?? "unknown"}. Switch to ${networkName}`);

  const registryLabel = `Registry on ${networkName}`;
  const pending = (id: ChecklistItem["id"], label: string) => {
    if (preflight === "checking") add(id, "checking", label, "Reading the chain");
    else if (preflight === "failed") add(id, "blocked", label, `${networkName} could not be read`);
    else add(id, "waiting", label, account === null ? "Needs a connected wallet" : "Needs the steps above");
  };
  const settled = preflight !== null && preflight !== "checking" && preflight !== "failed" ? preflight : null;

  const noCode = presence === "no_code" || settled?.status === "no_code";
  if (policy.status === "not_deployed") add("registry", "blocked", registryLabel, "No deployment is recorded for it");
  else if (noCode) add("registry", "blocked", registryLabel, "No contract code at the registry address");
  else if (presence === "unreadable") add("registry", "blocked", registryLabel, `${networkName} could not be read`);
  else if (presence !== "deployed") add("registry", "checking", registryLabel, "Reading the chain");
  else add("registry", "done", registryLabel, `Code found at ${shortenAddress(policy.deployment.registry)}`);

  const live = policy.status === "available" && settled !== null && settled.status !== "no_code" ? settled : null;
  const idLabel = "Index id";
  if (live === null) pending("index_id", idLabel);
  else if (live.status === "id_mismatch")
    add("index_id", "blocked", idLabel, "The registry derives another id than this browser");
  else add("index_id", "done", idLabel, "computeIndexId on the registry returned the predicted id");

  const simulationLabel = "Simulation";
  if (live === null || live.status === "id_mismatch") pending("simulation", simulationLabel);
  else if (live.status === "simulation_failed") add("simulation", "blocked", simulationLabel, "The call would revert");
  else add("simulation", "done", simulationLabel, "createIndex succeeded against the current state");

  if (live === null || live.status !== "ready") {
    pending("fee", "Gas and fee");
    pending("balance", "ETH balance");
    return items;
  }
  const l1 =
    live.l1FeeWei === null
      ? "no L1 data fee on this chain"
      : `L1 data fee ${eth(live.l1FeeWei)}, total ${eth(live.totalFeeWei)}`;
  add("fee", "done", "Gas and fee", `${formatCount(live.gas)} gas, execution fee at most ${eth(live.feeWei)}, ${l1}`);
  const required = live.totalFeeWei * BALANCE_MARGIN;
  const covered = live.balanceWei >= required;
  add(
    "balance",
    covered ? "done" : "blocked",
    "ETH balance",
    `${eth(live.balanceWei)}, ${covered ? "at least" : "less than"} ${BALANCE_MARGIN} times the estimated fee (${eth(required)})`,
  );
  return items;
}

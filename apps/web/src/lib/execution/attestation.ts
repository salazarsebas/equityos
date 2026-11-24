import { rebalanceLogAbi } from "@equityos/contracts-abi";
import { type Address, encodeFunctionData, type Hex } from "viem";
import type { ExecutionNetwork } from "./networks";

/**
 * The attestation of a rebalance: `RebalanceLog.recordRebalance(indexId, version)`, which emits
 * `RebalanceRecorded(msg.sender, indexId, version)`. It moves no token and writes no storage. It is a claim by
 * the account that it rebalanced toward that version; its meaning comes from the token transfers of the same
 * transaction or account, which a reader of the event must match.
 */
export interface AttestationCall {
  readonly to: Address;
  readonly data: Hex;
  readonly value: 0n;
  readonly indexId: Hex;
  readonly version: number;
}

/**
 * Why there is no attestation call.
 * - `not_deployed`: the deployment map records no `RebalanceLog` on the plan's chain.
 * - `registry_elsewhere`: the index was read from a registry on another chain, or at another address than the
 *   one the log validates against. The log there would revert, or name a different index with the same id.
 * - `no_code`: the map records a deployment, but there is no code at the address on this chain.
 * - `unreadable`: the code at the address could not be read.
 */
export type AttestationOmission = "not_deployed" | "registry_elsewhere" | "no_code" | "unreadable";

export type AttestationPlan =
  | { readonly status: "included"; readonly call: AttestationCall }
  | { readonly status: "omitted"; readonly reason: AttestationOmission };

/** Whether `RebalanceLog` is checked for code. `null` while the map records no deployment, so nothing is read. */
export function rebalanceLogToRead(network: ExecutionNetwork | null): Address | null {
  return network?.rebalanceLog?.address ?? null;
}

/**
 * Decides the attestation call of a plan. It is built only when the log is deployed on the execution chain
 * (by the deployment map, and by code at the address), and validates against the very registry the index was
 * read from: same chain, same address.
 *
 * @param code the code read at the log address, `undefined` or `"0x"` when there is none, `null` when the read
 *   failed or was not made
 */
export function planAttestation(input: {
  readonly network: ExecutionNetwork;
  readonly registry: { readonly chainId: number; readonly address: Address };
  readonly index: { readonly indexId: Hex; readonly version: number };
  readonly code: Hex | undefined | null;
}): AttestationPlan {
  const { network, registry, index, code } = input;
  const log = network.rebalanceLog;
  if (log === null) return { status: "omitted", reason: "not_deployed" };
  if (registry.chainId !== network.chainId || registry.address.toLowerCase() !== log.registry.toLowerCase()) {
    return { status: "omitted", reason: "registry_elsewhere" };
  }
  if (code === null) return { status: "omitted", reason: "unreadable" };
  if (code === undefined || code === "0x") return { status: "omitted", reason: "no_code" };
  return {
    status: "included",
    call: {
      to: log.address,
      data: encodeFunctionData({
        abi: rebalanceLogAbi,
        functionName: "recordRebalance",
        args: [index.indexId, index.version],
      }),
      value: 0n,
      indexId: index.indexId,
      version: index.version,
    },
  };
}

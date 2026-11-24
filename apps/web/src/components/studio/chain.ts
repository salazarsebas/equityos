"use client";

import { indexRegistryAbi } from "@equityos/contracts-abi";
import { useQuery } from "@tanstack/react-query";
import { type Address, encodeFunctionData, type Hex } from "viem";
import { estimateL1Fee } from "viem/op-stack";
import { type Config, useConfig } from "wagmi";
import { getPublicClient } from "wagmi/actions";
import { classifyTxError } from "@/lib/tx/errors";
import { type PreflightState, type RegistryPresence, type RegistryReads, runPreflight } from "@/lib/studio/preflight";
import type { NetworkPolicy, OnchainVersion, StudioPlan } from "@/lib/studio/publish";
import { publishPlanKey } from "@/lib/studio/request";

/** Index ids requested at once when the directory of a registry is read. */
const ID_BATCH = 50;

export interface RegistryChain extends RegistryReads {
  /** One version as the registry stores it, with the creator of its index. */
  version(indexId: Hex, version: number): Promise<OnchainVersion>;
}

/**
 * The reads the Studio makes on the target chain, through the endpoint configured for that chain. They never
 * go through the wallet, so they work on any network the wallet happens to be on.
 *
 * @throws {Error} if the chain is not one the app is configured for
 */
export function registryChain(config: Config, chainId: number, registry: Address): RegistryChain {
  const client = getPublicClient(config, { chainId });
  if (client === undefined) throw new Error(`chain ${chainId} is not configured`);
  const contract = { address: registry, abi: indexRegistryAbi } as const;
  const from = (plan: StudioPlan) => ({ ...contract, account: plan.creator });
  const data = (plan: StudioPlan) =>
    plan.functionName === "createIndex"
      ? encodeFunctionData({ abi: indexRegistryAbi, functionName: plan.functionName, args: plan.args })
      : encodeFunctionData({ abi: indexRegistryAbi, functionName: plan.functionName, args: plan.args });
  return {
    code: () => client.getCode({ address: registry }),
    computeIndexId: (creator, salt) =>
      client.readContract({ ...contract, functionName: "computeIndexId", args: [creator, salt] }),
    async indexIds() {
      const count = Number(await client.readContract({ ...contract, functionName: "indexCount" }));
      const ids: Hex[] = [];
      for (let start = 0; start < count; start += ID_BATCH) {
        const positions = Array.from({ length: Math.min(ID_BATCH, count - start) }, (_, i) => BigInt(start + i));
        const batch = positions.map((position) =>
          client.readContract({ ...contract, functionName: "indexIdAt", args: [position] }),
        );
        ids.push(...(await Promise.all(batch)));
      }
      return ids;
    },
    async index(indexId) {
      const index = await client.readContract({ ...contract, functionName: "getIndex", args: [indexId] });
      return { creator: index.creator, latestVersion: index.latestVersion, deprecated: index.deprecatedAt !== 0n };
    },
    async versionHash(indexId, version) {
      const info = await client.readContract({ ...contract, functionName: "getVersion", args: [indexId, version] });
      return info.specHash;
    },
    async simulate(plan) {
      if (plan.functionName === "createIndex") {
        await client.simulateContract({ ...from(plan), functionName: plan.functionName, args: plan.args });
      } else {
        await client.simulateContract({ ...from(plan), functionName: plan.functionName, args: plan.args });
      }
    },
    estimateGas: (plan) =>
      plan.functionName === "createIndex"
        ? client.estimateContractGas({ ...from(plan), functionName: plan.functionName, args: plan.args })
        : client.estimateContractGas({ ...from(plan), functionName: plan.functionName, args: plan.args }),
    async maxFeePerGas() {
      const fees = await client.estimateFeesPerGas();
      return fees.maxFeePerGas;
    },
    balance: (account) => client.getBalance({ address: account }),
    // One eth_call to the GasPriceOracle predeploy, on the chains that have one (Base and Base Sepolia).
    async l1DataFee(plan) {
      if (client.chain?.contracts?.gasPriceOracle === undefined) return null;
      return estimateL1Fee(client, { account: plan.creator, to: plan.registry, data: data(plan) });
    },
    async version(indexId, version) {
      const args = [indexId, version] as const;
      const [index, info, spec, constituents] = await Promise.all([
        client.readContract({ ...contract, functionName: "getIndex", args: [indexId] }),
        client.readContract({ ...contract, functionName: "getVersion", args }),
        client.readContract({ ...contract, functionName: "specOf", args }),
        client.readContract({ ...contract, functionName: "constituentsOf", args }),
      ]);
      return { creator: index.creator, specHash: info.specHash, spec, constituents };
    },
  };
}

/** Reads the code at the registry address when the deployment map records a deployment. Needs no wallet. */
export function useRegistryPresence(chainId: number, policy: NetworkPolicy): RegistryPresence {
  const config = useConfig();
  const registry = policy.status === "available" ? policy.deployment.registry : null;
  const query = useQuery({
    queryKey: ["studio", "registry-code", chainId, registry],
    queryFn: async () => {
      if (registry === null) return "not_deployed" as const;
      const code = await registryChain(config, chainId, registry).code();
      return code === undefined || code === "0x" ? ("no_code" as const) : ("deployed" as const);
    },
    enabled: registry !== null,
    retry: false,
    staleTime: 10_000,
  });
  if (registry === null) return "not_deployed";
  if (query.isSuccess) return query.data;
  return query.isError ? "unreadable" : "checking";
}

/**
 * Checks a plan against the chain: the registry, the index id, a simulation, gas, fee and balance. It runs
 * when the plan changes and when `refetch` is called, never on a timer, and it sends nothing.
 */
export function usePreflight(plan: StudioPlan | null, enabled: boolean) {
  const config = useConfig();
  const query = useQuery({
    queryKey: ["studio", "preflight", plan === null ? null : publishPlanKey(plan)],
    queryFn: () => {
      if (plan === null) throw new Error("no plan to check");
      const reads = registryChain(config, plan.chainId, plan.registry);
      return runPreflight(reads, plan, (error) => classifyTxError(indexRegistryAbi, error));
    },
    enabled: enabled && plan !== null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
  // While the checks are paused, during a transaction, the last result stays on screen.
  const state: PreflightState =
    plan === null
      ? null
      : query.isFetching
        ? "checking"
        : query.isSuccess
          ? query.data
          : query.isError
            ? "failed"
            : enabled
              ? "checking"
              : null;
  return { state, checkedAt: query.dataUpdatedAt, refetch: () => void query.refetch() };
}

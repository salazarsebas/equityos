import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The contracts whose ABI this package exports, and where each one is written. */
export const ABI_SOURCES = [
  { contract: "IndexRegistry", exportName: "indexRegistryAbi", module: "index-registry.ts" },
  { contract: "RebalanceLog", exportName: "rebalanceLogAbi", module: "rebalance-log.ts" },
] as const;

export type ContractName = (typeof ABI_SOURCES)[number]["contract"];

function artifactPath(contract: ContractName): string {
  return fileURLToPath(new URL(`../../../contracts/out/${contract}.sol/${contract}.json`, import.meta.url));
}

/** True when `forge build` has produced the artifact of every contract. */
export function artifactsExist(): boolean {
  return ABI_SOURCES.every(({ contract }) => existsSync(artifactPath(contract)));
}

/** The `abi` member of the Foundry artifact of a contract. */
export function artifactAbi(contract: ContractName): unknown {
  const artifact: unknown = JSON.parse(readFileSync(artifactPath(contract), "utf8"));
  if (typeof artifact !== "object" || artifact === null || !("abi" in artifact) || !Array.isArray(artifact.abi)) {
    throw new Error(`the artifact of ${contract} has no abi`);
  }
  return artifact.abi;
}

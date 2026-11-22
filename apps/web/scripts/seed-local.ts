/**
 * Publishes the example indexes to the IndexRegistry of a local Anvil node.
 *
 *   bun run seed:local
 *
 * Transactions are signed by Anvil for its first unlocked development account: no private key is read,
 * stored or created. The script sends nothing unless the endpoint reports chain id 31337. It can be run
 * again: an index or a version that is already published is skipped.
 */
import { indexRegistryAbi } from "@equityos/contracts-abi";
import {
  type Address,
  bytesToHex,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  type Hex,
  http,
  keccak256,
} from "viem";
import { anvil } from "viem/chains";
import {
  createRegistryClient,
  createRegistryReader,
  LOCAL_CHAIN_ID,
  resolveRegistryConfig,
} from "../src/server/registry";
import { buildSeedIndexes } from "./seed/indexes";

/** The endpoint is not a local development chain. Nothing was sent. */
export class SeedRefusedError extends Error {
  readonly chainId: number;

  constructor(chainId: number) {
    super(`refusing to seed chain ${chainId}: only a local chain with id ${LOCAL_CHAIN_ID} is seeded`);
    this.name = "SeedRefusedError";
    this.chainId = chainId;
  }
}

export interface SeededIndex {
  readonly indexId: Hex;
  /** Canonical identifier as resolved by the registry reader. */
  readonly identifier: string;
  readonly name: string;
  /** Spec hash of each version, version 1 first. */
  readonly specHashes: readonly Hex[];
  /** Versions this run published. The others were already there. */
  readonly published: readonly number[];
}

/**
 * Publishes the example indexes that are missing and returns all of them.
 *
 * @throws {SeedRefusedError} if the endpoint is not chain 31337, before any transaction is sent.
 */
export async function seedLocal(rpcUrl: string): Promise<SeededIndex[]> {
  const transport = http(rpcUrl);
  const client = createPublicClient({ chain: anvil, transport });
  const chainId = await client.getChainId();
  if (chainId !== LOCAL_CHAIN_ID) throw new SeedRefusedError(chainId);

  const config = resolveRegistryConfig({ EQUITYOS_CHAIN_ID: String(LOCAL_CHAIN_ID) });
  const registry: Address = config.deployment.registry;
  const code = await client.getCode({ address: registry });
  if (code === undefined || code === "0x") {
    throw new Error(`no IndexRegistry at ${registry}: run "bun run contracts:deploy:local" first`);
  }
  const wallet = createWalletClient({ chain: anvil, transport });
  const [creator] = await wallet.getAddresses();
  if (creator === undefined) throw new Error("the node exposes no unlocked account");

  const seeded: { indexId: Hex; published: number[] }[] = [];
  for (const seed of buildSeedIndexes(chainId)) {
    const indexId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [creator, seed.salt]));
    const exists = await client.readContract({
      address: registry,
      abi: indexRegistryAbi,
      functionName: "exists",
      args: [indexId],
    });
    const latestVersion = exists
      ? (
          await client.readContract({
            address: registry,
            abi: indexRegistryAbi,
            functionName: "getIndex",
            args: [indexId],
          })
        ).latestVersion
      : 0;
    const published: number[] = [];
    for (const [i, version] of seed.versions.entries()) {
      const number = i + 1;
      if (number <= latestVersion) continue;
      const spec = bytesToHex(version.specBytes);
      const hash =
        number === 1
          ? await wallet.writeContract({
              account: creator,
              address: registry,
              abi: indexRegistryAbi,
              functionName: "createIndex",
              args: [seed.salt, spec, version.tokens, version.weightsBps],
            })
          : await wallet.writeContract({
              account: creator,
              address: registry,
              abi: indexRegistryAbi,
              functionName: "publishVersion",
              args: [indexId, number, spec, version.tokens, version.weightsBps],
            });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
      published.push(number);
    }
    seeded.push({ indexId, published });
  }

  // Read back through the reader the application uses, so the output is what the application will resolve.
  const reader = createRegistryReader({ config, client: createRegistryClient(rpcUrl) });
  const results: SeededIndex[] = [];
  for (const { indexId, published } of seeded) {
    const [index, versions] = await Promise.all([reader.getIndex(indexId), reader.listVersions(indexId)]);
    if (index.status !== "ok" || versions.status !== "ok") {
      throw new Error(`index ${indexId} could not be read back: ${index.status}, ${versions.status}`);
    }
    const { latest, identifier } = index.index;
    results.push({
      indexId,
      identifier,
      name: latest.conformant ? latest.spec.name : "(not conformant)",
      specHashes: versions.versions.map(({ specHash }) => specHash),
      published,
    });
  }
  return results;
}

if (import.meta.main) {
  const rpcUrl = process.env.EQUITYOS_RPC_URL?.trim() || "http://127.0.0.1:8545";
  try {
    for (const index of await seedLocal(rpcUrl)) {
      console.log(index.name);
      console.log(`  index id:    ${index.indexId}`);
      console.log(`  identifier:  ${index.identifier}`);
      index.specHashes.forEach((hash, i) => {
        const note = index.published.includes(i + 1) ? "published" : "already published";
        console.log(`  version ${i + 1}:   ${hash} (${note})`);
      });
    }
  } catch (error) {
    console.error(`seed-local: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

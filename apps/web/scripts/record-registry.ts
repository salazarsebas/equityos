/**
 * Records every read call of the IndexRegistry of a local Anvil node at its latest block, and every request the
 * network metrics make there, in the format the registry replay serves (`REGISTRY_REPLAY_DIR`, see
 * `src/server/registry/replay.ts`).
 *
 *   bun run record:registry <directory>
 *
 * It only reads, and only from a chain that reports id 31337: a recording is test data and must never be
 * taken from, or mistaken for, a live network.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { indexRegistryAbi } from "@equityos/contracts-abi";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  type Hex,
  http,
  isHex,
} from "viem";
import { multicall3Abi } from "../src/server/market/abis";
import { createNetworkService } from "../src/server/network";
import { createRegistryReader, LOCAL_CHAIN_ID, resolveRegistryConfig } from "../src/server/registry";
import { MULTICALL3_ADDRESS } from "../src/server/registry/config";
import { replayConfig } from "../src/server/registry/replay";

const abi = indexRegistryAbi;

/** Answered by the replay itself, so never recorded. */
const UNRECORDED = new Set(["eth_chainId", "eth_blockNumber", "eth_getCode"]);

/**
 * Computes the network metrics against the node with the configuration the replay uses, and returns every
 * request they made with its result. A local node has no Multicall3, so a batched read is answered here by
 * running each of its calls at the block it names, as Multicall3 would.
 */
async function recordNetworkRequests(rpcUrl: string): Promise<{ method: string; params: unknown; result: unknown }[]> {
  const node = http(rpcUrl)({});
  const requests: { method: string; params: unknown; result: unknown }[] = [];
  async function answer(method: string, params: unknown): Promise<unknown> {
    const [request, blockTag] = Array.isArray(params) ? params : [];
    const field = (key: string): unknown =>
      typeof request === "object" && request !== null ? Reflect.get(request, key) : undefined;
    const to = field("to");
    const data = field("data");
    const batched = typeof to === "string" && to.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase();
    if (method !== "eth_call" || !batched || !isHex(data)) return node.request({ method, params });
    const decoded = decodeFunctionData({ abi: multicall3Abi, data });
    if (decoded.functionName !== "aggregate3") throw new Error(`unexpected ${decoded.functionName} call`);
    const result: { success: boolean; returnData: Hex }[] = [];
    for (const { target, callData } of decoded.args[0]) {
      const returnData: unknown = await node
        .request({ method: "eth_call", params: [{ to: target, data: callData }, blockTag] })
        .catch(() => null);
      result.push(isHex(returnData) ? { success: true, returnData } : { success: false, returnData: "0x" });
    }
    return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result });
  }
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        const result = await answer(method, params);
        if (!UNRECORDED.has(method)) requests.push({ method, params: params ?? null, result });
        return result;
      },
    }),
  });
  const config = replayConfig(LOCAL_CHAIN_ID);
  const reader = createRegistryReader({ config, client });
  const service = createNetworkService({
    reader,
    config,
    client: () => client,
    exclusions: [],
    now: () => Math.floor(Date.now() / 1000),
  });
  const read = await service.read();
  if (read.status !== "ok" || !read.scan.complete || !read.usageComplete) {
    throw new Error("the network metrics did not cover the whole chain in one read");
  }
  return requests;
}

export async function recordRegistry(rpcUrl: string): Promise<Record<string, unknown>> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  if (chainId !== LOCAL_CHAIN_ID) throw new Error(`refusing to record chain ${chainId}: only ${LOCAL_CHAIN_ID}`);
  const { registry } = resolveRegistryConfig({ EQUITYOS_CHAIN_ID: String(LOCAL_CHAIN_ID) }).deployment;
  const block = await client.getBlock();
  const code = await client.getCode({ address: registry, blockNumber: block.number });
  if (code === undefined || code === "0x") throw new Error(`no IndexRegistry at ${registry}`);

  const calls: { callData: Hex; returnData: Hex }[] = [];
  async function call(callData: Hex): Promise<Hex> {
    const { data } = await client.call({ to: registry, data: callData, blockNumber: block.number });
    if (data === undefined) throw new Error(`the registry returned nothing for ${callData.slice(0, 10)}`);
    calls.push({ callData, returnData: data });
    return data;
  }

  const count = decodeFunctionResult({
    abi,
    functionName: "indexCount",
    data: await call(encodeFunctionData({ abi, functionName: "indexCount" })),
  });
  for (let position = 0n; position < count; position += 1n) {
    const indexId = decodeFunctionResult({
      abi,
      functionName: "indexIdAt",
      data: await call(encodeFunctionData({ abi, functionName: "indexIdAt", args: [position] })),
    });
    const { latestVersion } = decodeFunctionResult({
      abi,
      functionName: "getIndex",
      data: await call(encodeFunctionData({ abi, functionName: "getIndex", args: [indexId] })),
    });
    for (let version = 1; version <= latestVersion; version += 1) {
      for (const functionName of ["getVersion", "specOf", "constituentsOf"] as const) {
        await call(encodeFunctionData({ abi, functionName, args: [indexId, version] }));
      }
    }
  }
  return {
    source: `IndexRegistry ${registry} on a local Anvil node (chain ${chainId}), after "bun run contracts:deploy:local"${
      count === 0n ? ", before any index is published" : ' and "bun run seed:local"'
    }. Example data, not a live network.`,
    chainId,
    blockNumber: block.number.toString(),
    blockTimestamp: Number(block.timestamp),
    calls,
    requests: await recordNetworkRequests(rpcUrl),
  };
}

if (import.meta.main) {
  const directory = process.argv[2];
  const rpcUrl = process.env.EQUITYOS_RPC_URL?.trim() || "http://127.0.0.1:8545";
  try {
    if (directory === undefined) throw new Error("usage: record-registry <directory>");
    const recording = await recordRegistry(rpcUrl);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "registry.json"), `${JSON.stringify(recording, null, 2)}\n`);
    console.log(`recorded block ${String(recording.blockNumber)} to ${join(directory, "registry.json")}`);
  } catch (error) {
    console.error(`record-registry: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEPLOYMENTS, isSupportedChainId } from "@equityos/contracts-abi";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
  numberToHex,
  parseAbi,
} from "viem";
import type { RegistryClient } from "./chain";
import { MULTICALL3_ADDRESS, type RegistryConfig } from "./config";
import { RegistryConfigurationError } from "./errors";

/**
 * Replay of a recording: every read call of one IndexRegistry at one block of a local chain, written by
 * `scripts/record-registry.ts` in the format of `apps/web/test/fixtures/registry`. It lets the browser tests
 * run the real pages and routes with no chain. A replayed registry is the state of a past block of a
 * development chain, never the current state of a live network, so every surface that shows it must say so:
 * see `registryMode`.
 */
export const REGISTRY_REPLAY_VARIABLE = "REGISTRY_REPLAY_DIR";
const FILE = "registry.json";

const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) view returns (Result[] returnData)",
]);

export interface RegistryReplay {
  readonly config: RegistryConfig;
  readonly client: RegistryClient;
  /** Number and timestamp (Unix seconds) of the recorded block. */
  readonly blockNumber: bigint;
  readonly blockTimestamp: number;
}

function invalid(problem: string): RegistryConfigurationError {
  return new RegistryConfigurationError(REGISTRY_REPLAY_VARIABLE, `holds an unusable ${FILE}: ${problem}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

/**
 * Loads the recording in `directory` as a reader configuration and a client that answers from it and from
 * nothing else: a call that was not recorded is an error, which the reader reports as an upstream failure.
 *
 * @throws {RegistryConfigurationError} if the file is missing or does not have the recorded shape.
 */
export function loadRegistryReplay(directory: string): RegistryReplay {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(directory, FILE), "utf8"));
  } catch {
    throw invalid("it cannot be read as JSON");
  }
  const { chainId, blockNumber, blockTimestamp, calls } = isRecord(parsed) ? parsed : {};
  if (typeof chainId !== "number" || !isSupportedChainId(chainId)) throw invalid("chainId is not a supported chain");
  if (typeof blockNumber !== "string" || !/^\d+$/.test(blockNumber)) throw invalid("blockNumber is not an integer");
  if (typeof blockTimestamp !== "number" || !Number.isSafeInteger(blockTimestamp)) {
    throw invalid("blockTimestamp is not an integer");
  }
  if (!Array.isArray(calls)) throw invalid("calls is not an array");
  const recorded = new Map<string, Hex>();
  for (const call of calls as readonly unknown[]) {
    const { callData, returnData } = isRecord(call) ? call : {};
    if (!isHex(callData) || !isHex(returnData)) throw invalid("a call does not have callData and returnData");
    recorded.set(callData.toLowerCase(), returnData);
  }
  const deployment = { ...DEPLOYMENTS[chainId], deployBlock: 0n };
  const registry = deployment.registry.toLowerCase();
  const answer = (to: string, data: Hex): Hex => {
    const returnData = to.toLowerCase() === registry ? recorded.get(data.toLowerCase()) : undefined;
    if (returnData === undefined) throw new Error(`call to ${to} was not recorded: ${data.slice(0, 10)}`);
    return returnData;
  };
  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    if (method === "eth_chainId") return numberToHex(chainId);
    if (method === "eth_blockNumber") return numberToHex(BigInt(blockNumber));
    // A recording is only made of a chain that has the registry.
    if (method === "eth_getCode") return "0x00";
    const call: unknown = Array.isArray(params) ? params[0] : undefined;
    const { to, data } = isRecord(call) ? call : {};
    if (method !== "eth_call" || typeof to !== "string" || !isHex(data)) {
      throw new Error(`the recording has no answer for ${method}`);
    }
    if (to.toLowerCase() !== MULTICALL3_ADDRESS.toLowerCase()) return answer(to, data);
    const { args } = decodeFunctionData({ abi: multicall3Abi, data });
    const result = args[0].map(({ target, callData }) => ({ success: true, returnData: answer(target, callData) }));
    return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result });
  };
  return {
    // Batched reads go to the Multicall3 address, which the client above answers call by call.
    config: { chainId, deployment, multicall: MULTICALL3_ADDRESS, logChunkBlocks: 2_000n, confirmations: 0n },
    client: createPublicClient({ transport: custom({ request }, { retryCount: 0 }) }),
    blockNumber: BigInt(blockNumber),
    blockTimestamp,
  };
}

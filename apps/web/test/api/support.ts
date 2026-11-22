import { type Address, createPublicClient, encodeAbiParameters, encodeFunctionData, type Hex } from "viem";
import { b20AssetAbi, multicall3Abi } from "../../src/server/market/abis";
import { createMarketData, type MarketData } from "../../src/server/market/index";
import { MULTICALL3_ADDRESS } from "../../src/server/market/onchain";
import { createRegistryReader, type RegistryReader } from "../../src/server/registry/reader";
import { loadRegistryReplay } from "../../src/server/registry/replay";
import { fixtureFetch, fixtureTransport, onchainFixture } from "../market/support";
import { type FakeChain, testConfig } from "../registry/support";

/** Saturday 2026-11-21 19:10:55 UTC: the time of the recorded block. The market is closed. */
export const RECORDED_AT = onchainFixture.blockTimestamp;

type Answer = { success: boolean; returnData: Hex };

export interface FixtureServiceOptions {
  /** Replaces the recorded answer of one call. */
  readonly override?: (call: { target: Address; callData: Hex }) => Answer | undefined;
  /** Replaces the body of every asset list response. */
  readonly apiBody?: unknown;
}

/**
 * A market data service fed by the recorded API pages and the recorded block, with a clock and two switches
 * that take a source down. No network access is made.
 */
export function fixtureService(start: number = RECORDED_AT, options: FixtureServiceOptions = {}) {
  const clock = { now: start };
  const outage = { api: false, rpc: false };
  const api = fixtureFetch();
  const rpc = fixtureTransport(onchainFixture, {
    ...(options.override ? { override: options.override } : {}),
    failEthCall: () => outage.rpc,
  });
  const serve = (...args: Parameters<typeof fetch>): Promise<Response> => {
    if (outage.api) return Promise.resolve(new Response("", { status: 503 }));
    if (options.apiBody !== undefined) return Promise.resolve(Response.json(options.apiBody));
    return api.fetch(...args);
  };
  const marketData: MarketData = createMarketData({
    fetch: Object.assign(serve, { preconnect: fetch.preconnect }),
    sleep: async () => {},
    client: createPublicClient({ transport: rpc.transport }),
    now: () => clock.now,
  });
  return { marketData: () => marketData, clock, outage };
}

/** Makes the endpoint answer as a chain other than Base mainnet, which the layer reports as a misconfiguration. */
export function wrongChain(call: { target: Address; callData: Hex }): Answer | undefined {
  const isChainId =
    call.target.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase() &&
    call.callData === encodeFunctionData({ abi: multicall3Abi, functionName: "getChainId" });
  return isChainId ? { success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [1n]) } : undefined;
}

/** Makes `totalSupply()` of one token answer with `supply`. */
export function supplyOf(token: Address, supply: bigint) {
  const callData = encodeFunctionData({ abi: b20AssetAbi, functionName: "totalSupply" });
  return (call: { target: Address; callData: Hex }): Answer | undefined =>
    call.target.toLowerCase() === token && call.callData === callData
      ? { success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [supply]) }
      : undefined;
}

export function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://equityos.test${path}`, { headers });
}

/** A reader of the recorded registry in `test/fixtures/<directory>`: the local chain after the seed. */
export function recordedRegistry(directory = "registry"): RegistryReader {
  const { config, client } = loadRegistryReplay(new URL(`../fixtures/${directory}`, import.meta.url).pathname);
  return createRegistryReader({ config, client });
}

/** A reader of an in-memory chain the test controls. */
export function fakeRegistry(chain: FakeChain): RegistryReader {
  return createRegistryReader({ config: testConfig(), client: chain.client(), now: () => 1_000 });
}

export function identifierContext(identifier: string): { params: Promise<{ identifier: string }> } {
  return { params: Promise.resolve({ identifier }) };
}

export function versionContext(
  identifier: string,
  version: string,
): { params: Promise<{ identifier: string; version: string }> } {
  return { params: Promise.resolve({ identifier, version }) };
}

export function addressContext(address: string): { params: Promise<{ address: string }> } {
  return { params: Promise.resolve({ address }) };
}

/** The parsed body of a response. Typed loosely on purpose: assertions pick the fields they check. */
export async function body(response: Response): Promise<{
  data?: unknown;
  meta?: Record<string, unknown>;
  error?: { code: string; message: string; details: Record<string, unknown> | null };
}> {
  return JSON.parse(await response.text());
}

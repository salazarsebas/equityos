import { readFileSync } from "node:fs";
import { type Address, custom, decodeFunctionData, encodeFunctionResult, type Hex, type Transport } from "viem";
import { multicall3Abi } from "../../src/server/market/abis";
import { MULTICALL3_ADDRESS } from "../../src/server/market/onchain";

/** One call made through Multicall3 and what the chain answered. */
export interface RecordedCall {
  readonly target: Address;
  readonly callData: Hex;
  readonly success: boolean;
  readonly returnData: Hex;
}

/** Calls recorded from Base mainnet at one block. */
export interface OnchainFixture {
  readonly blockNumber: string;
  readonly blockTimestamp: number;
  readonly calls: readonly RecordedCall[];
}

/** Pages of the asset list API, trimmed to a selection of tokens. */
export interface AssetListFixture {
  readonly pages: readonly { readonly tokens: readonly Record<string, unknown>[]; readonly next_page_token?: string }[];
}

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/market/${name}`, import.meta.url), "utf8"));
}

// The fixtures are files written by the recorder in the shape of the interfaces above.
export const assetListFixture = readJson("asset-list.json") as AssetListFixture;
export const onchainFixture = readJson("onchain.json") as OnchainFixture;

export function callKey(target: string, callData: string): string {
  return `${target.toLowerCase()}:${callData.toLowerCase()}`;
}

/** Decodes the calls of an `aggregate3` request. */
export function decodeAggregate3(data: Hex): readonly { target: Address; callData: Hex }[] {
  const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data });
  if (functionName !== "aggregate3") throw new Error(`unexpected multicall function ${functionName}`);
  return args[0];
}

export function encodeAggregate3Result(results: readonly { success: boolean; returnData: Hex }[]): Hex {
  return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
}

export interface FixtureTransportOptions {
  /** Replaces the recorded answer of a call. Return `undefined` to keep the recording. */
  readonly override?: (call: { target: Address; callData: Hex }) => { success: boolean; returnData: Hex } | undefined;
  /** Makes the n-th `eth_call` (1-based) fail at the transport level. */
  readonly failEthCall?: (attempt: number) => boolean;
}

/**
 * A viem transport that answers `eth_getBlockByNumber` and Multicall3 `eth_call` requests from the recorded
 * fixture. Any other request, and any call that was not recorded, is an error: the tests make no network access.
 */
export function fixtureTransport(
  fixture: OnchainFixture,
  options: FixtureTransportOptions = {},
): { transport: Transport; requests: string[] } {
  const recorded = new Map(fixture.calls.map((call) => [callKey(call.target, call.callData), call]));
  const blockNumber: Hex = `0x${BigInt(fixture.blockNumber).toString(16)}`;
  const requests: string[] = [];
  let ethCalls = 0;
  const transport = custom(
    {
      async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
        requests.push(method);
        if (method === "eth_getBlockByNumber") {
          return { number: blockNumber, timestamp: `0x${fixture.blockTimestamp.toString(16)}`, transactions: [] };
        }
        if (method !== "eth_call" || !Array.isArray(params)) throw new Error(`unexpected RPC method ${method}`);
        ethCalls += 1;
        if (options.failEthCall?.(ethCalls)) throw new Error("simulated transport failure");
        const [request, block] = params as [{ to: Address; data: Hex }, string];
        if (request.to.toLowerCase() !== MULTICALL3_ADDRESS.toLowerCase()) throw new Error("call is not a multicall");
        if (block !== blockNumber) throw new Error(`call is not pinned to the recorded block: ${block}`);
        return encodeAggregate3Result(
          decodeAggregate3(request.data).map((call) => {
            const answer = options.override?.(call) ?? recorded.get(callKey(call.target, call.callData));
            if (answer === undefined) throw new Error(`call was not recorded: ${callKey(call.target, call.callData)}`);
            return { success: answer.success, returnData: answer.returnData };
          }),
        );
      },
    },
    { retryCount: 0 },
  );
  return { transport, requests };
}

/** A `fetch` that serves the recorded asset list pages by page token and counts the requests. */
export function fixtureFetch(pages: AssetListFixture["pages"] = assetListFixture.pages): {
  fetch: typeof fetch;
  urls: URL[];
} {
  const urls: URL[] = [];
  const serve = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    urls.push(url);
    const token = url.searchParams.get("page_token");
    const index = token === null ? 0 : pages.findIndex((page) => page.next_page_token === token) + 1;
    const page = pages[index];
    if (page === undefined || (token !== null && index === 0)) return Response.json({ code: 3 }, { status: 400 });
    return Response.json(page);
  };
  return { fetch: Object.assign(serve, { preconnect: fetch.preconnect }), urls };
}

/** Lowercase addresses of fixture tokens, named by the symbol they carried when recorded. */
export const TOKENS = {
  APP: "0xb20000000000000000000006f910a0e7bbd3c168",
  NVDA: "0xb20000000000000000000078ee7ce2fe4908108c",
  SNDK: "0xb200000000000000000000397293cb8cda9a10c5",
  RKT: "0xb200000000000000000000000d3176ee4af1102d",
} as const satisfies Record<string, Address>;

/** Lowercase addresses of every token in the asset list fixture, in list order. */
export const FIXTURE_TOKENS: readonly Address[] = assetListFixture.pages.flatMap((page) =>
  page.tokens.map((token): Address => `0x${String(token.contract_address).slice(2).toLowerCase()}`),
);

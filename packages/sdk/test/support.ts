import { readFileSync } from "node:fs";
import type { Fetch, FetchRequestInit, Hex, PublicClientLike } from "../src/index.ts";

/** One recorded example response of the API, as `apps/web/src/server/api/examples.json` holds it. */
export interface RecordedExample {
  readonly name: string;
  readonly operationId: string;
  readonly path: string;
  readonly status: number;
  readonly body: unknown;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

/**
 * Responses of API v1 recorded by the web app from its test fixtures. The web app keeps the file equal to what
 * its handlers produce and valid against the OpenAPI document.
 */
export const EXAMPLES = (readJson("../../../apps/web/src/server/api/examples.json") as { examples: RecordedExample[] })
  .examples;

export function example(name: string): RecordedExample {
  const found = EXAMPLES.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no recorded example ${name}`);
  return found;
}

export interface FetchCall {
  readonly url: string;
  readonly init: FetchRequestInit;
}

/** A fetch that answers from a function of the URL, and records every request. */
export function mockFetch(answer: (url: string, init: FetchRequestInit) => Response | Promise<Response>): {
  readonly fetch: Fetch;
  readonly calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return answer(url, init);
    },
  };
}

/** A fetch that answers every request with the recorded example, whatever the URL. */
export function exampleFetch(name: string): ReturnType<typeof mockFetch> {
  const { status, body } = example(name);
  return mockFetch(() => Response.json(body, { status }));
}

/** The registry of a local chain after the seed, as recorded by `apps/web/scripts/record-registry.ts`. */
export interface RegistryRecording {
  readonly chainId: number;
  readonly blockNumber: string;
  readonly calls: readonly { readonly callData: Hex; readonly returnData: Hex }[];
}

export const REGISTRY_RECORDING = readJson(
  "../../../apps/web/test/fixtures/registry/registry.json",
) as RegistryRecording;

const INDEX_ID_AT = "0x8e8afd1a";
const GET_INDEX = "0x8527831b";
const EXISTS = "0x38a699a4";

/** The index ids of the recording, in creation order. */
export const RECORDED_INDEX_IDS: readonly Hex[] = REGISTRY_RECORDING.calls
  .filter(({ callData }) => callData.startsWith(INDEX_ID_AT))
  .map(({ returnData }) => returnData);

/**
 * A chain client that answers the registry reads from the recording, at the recorded block. `exists` is not
 * recorded: it answers true for an index whose `getIndex` is. Any other call fails, as an endpoint would.
 */
export function recordedClient(overrides: Partial<PublicClientLike> = {}): PublicClientLike {
  const answers = new Map(REGISTRY_RECORDING.calls.map(({ callData, returnData }) => [callData, returnData]));
  return {
    getChainId: async () => REGISTRY_RECORDING.chainId,
    getBlockNumber: async () => BigInt(REGISTRY_RECORDING.blockNumber),
    getCode: async () => "0x6080",
    call: async ({ data }) => {
      if (data.startsWith(EXISTS)) {
        const known = answers.has(`${GET_INDEX}${data.slice(10)}`);
        return { data: `0x${(known ? 1n : 0n).toString(16).padStart(64, "0")}` };
      }
      const returnData = answers.get(data);
      if (returnData === undefined) throw new Error(`call not recorded: ${data}`);
      return { data: returnData };
    },
    ...overrides,
  };
}

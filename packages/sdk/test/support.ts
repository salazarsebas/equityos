import { readFileSync } from "node:fs";
import type { Fetch, FetchRequestInit } from "../src/index.ts";

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

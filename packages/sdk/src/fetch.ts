/**
 * The part of the Fetch API this package uses, stated structurally so that the package needs neither the DOM
 * library nor Node.js types. The global `fetch` of browsers, Node.js 18 and later, Bun and Deno satisfies it.
 */

export interface FetchRequestInit {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface FetchResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type Fetch = (url: string, init: FetchRequestInit) => Promise<FetchResponse>;

/** The global `fetch`, called through `globalThis` so that browsers do not reject a detached call. */
export function globalFetch(): Fetch {
  const scope = globalThis as { readonly fetch?: Fetch };
  const { fetch } = scope;
  if (fetch === undefined) {
    throw new TypeError("No global fetch is available. Pass a fetch implementation in the options.");
  }
  return (url, init) => fetch.call(globalThis, url, init);
}

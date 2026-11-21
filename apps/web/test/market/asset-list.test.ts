import { describe, expect, test } from "bun:test";
import { fetchAssetList, parseAssetListPage } from "../../src/server/market/asset-list";
import { MalformedResponseError, UpstreamError } from "../../src/server/market/errors";
import { assetListFixture, FIXTURE_TOKENS, fixtureFetch, TOKENS } from "./support";

const noSleep = async () => {};

/** A `fetch` that answers each request with the next entry, and records what it was called with. */
function scriptedFetch(script: readonly (Response | Error | (() => Response))[]) {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const serve = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    calls.push({ url: new URL(input instanceof Request ? input.url : input), init });
    const step = script[calls.length - 1];
    if (step === undefined) throw new Error("fetch called more often than scripted");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step() : step;
  };
  return { fetch: Object.assign(serve, { preconnect: fetch.preconnect }), calls };
}

const validToken = {
  contract_address: "0xb20000000000000000000078ee7ce2fE4908108C",
  symbol: "NVDAc",
  name: "NVIDIA Corporation",
  decimals: 8,
};

function page(tokens: readonly unknown[], nextPageToken?: string): Response {
  return Response.json(nextPageToken === undefined ? { tokens } : { tokens, next_page_token: nextPageToken });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("fetchAssetList with the recorded pages", () => {
  test("follows next_page_token through every page and keys the result by lowercase address", async () => {
    const { fetch, urls } = fixtureFetch();
    const assets = await fetchAssetList({ fetch, sleep: noSleep });

    expect(urls).toHaveLength(3);
    expect(urls.map((url) => url.searchParams.get("page_token"))).toEqual([
      null,
      assetListFixture.pages[0]?.next_page_token ?? "",
      assetListFixture.pages[1]?.next_page_token ?? "",
    ]);
    for (const url of urls) {
      expect(url.origin + url.pathname).toBe("https://api.coinbase.com/v1/tokenized-stocks");
      expect(url.searchParams.get("page_size")).toBe("500");
    }
    expect([...assets.keys()]).toEqual([...FIXTURE_TOKENS]);
    expect(assets.size).toBe(17);
    for (const [address, asset] of assets) {
      expect(address).toBe(address.toLowerCase() as typeof address);
      expect(asset.address).toBe(address);
    }
  });

  test("keeps identity fields only and exposes no floating-point quantity", async () => {
    const assets = await fetchAssetList({ fetch: fixtureFetch().fetch, sleep: noSleep });
    expect(assets.get(TOKENS.NVDA)).toEqual({
      address: TOKENS.NVDA,
      symbol: "NVDAc",
      name: "NVIDIA Corporation",
      decimals: 8,
      isin: "US67066G1040",
      iconUrl: expect.stringMatching(/^https:\/\/metadata\.coinbase\.com\/equity_icons\//),
    });
    for (const asset of assets.values()) {
      expect(Object.keys(asset).sort()).toEqual(["address", "decimals", "iconUrl", "isin", "name", "symbol"]);
    }
  });

  test("is not addressable by symbol", async () => {
    const assets: ReadonlyMap<string, unknown> = await fetchAssetList({ fetch: fixtureFetch().fetch, sleep: noSleep });
    expect(assets.get("NVDAc")).toBeUndefined();
    expect(assets.get("0xb20000000000000000000078ee7ce2fE4908108C")).toBeUndefined();
  });
});

describe("fetchAssetList request behaviour", () => {
  test("sends a timeout signal, asks for JSON and bypasses the HTTP cache", async () => {
    const { fetch, calls } = scriptedFetch([page([validToken])]);
    await fetchAssetList({ fetch, sleep: noSleep });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.init?.cache).toBe("no-store");
    expect(calls[0]?.init?.headers).toEqual({ accept: "application/json" });
  });

  test("retries a transport error, a 429 and a 5xx, with a growing delay", async () => {
    const delays: number[] = [];
    const sleep = async (milliseconds: number) => {
      delays.push(milliseconds);
    };
    const { fetch, calls } = scriptedFetch([
      new TypeError("network down"),
      new Response("slow down", { status: 429 }),
      page([validToken]),
    ]);
    const assets = await fetchAssetList({ fetch, sleep });
    expect(assets.size).toBe(1);
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([250, 500]);
  });

  test("gives up after three attempts with an upstream error that carries the status", async () => {
    const { fetch, calls } = scriptedFetch([
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
    ]);
    const error = await rejection(fetchAssetList({ fetch, sleep: noSleep }));
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ code: "upstream_failure", source: "coinbase_api", status: 503 });
    expect(calls).toHaveLength(3);
  });

  test("reports a timeout as an upstream error after the bounded retries", async () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    const { fetch, calls } = scriptedFetch([timeout, timeout, timeout]);
    const error = await rejection(fetchAssetList({ fetch, sleep: noSleep }));
    expect(error).toMatchObject({ code: "upstream_failure", status: null, cause: timeout });
    expect(calls).toHaveLength(3);
  });

  test("does not retry a 4xx", async () => {
    const { fetch, calls } = scriptedFetch([
      Response.json({ code: 3, message: "page_token is invalid" }, { status: 400 }),
    ]);
    const error = await rejection(fetchAssetList({ fetch, sleep: noSleep }));
    expect(error).toMatchObject({ code: "upstream_failure", status: 400 });
    expect(calls).toHaveLength(1);
  });

  test("retries only the failing page, not the pages already read", async () => {
    const second = { ...validToken, contract_address: "0xb200000000000000000000397293Cb8cda9a10c5" };
    const { fetch, calls } = scriptedFetch([
      page([validToken], "next"),
      new Response("", { status: 500 }),
      page([second]),
    ]);
    const assets = await fetchAssetList({ fetch, sleep: noSleep });
    expect(assets.size).toBe(2);
    expect(calls.map((call) => call.url.searchParams.get("page_token"))).toEqual([null, "next", "next"]);
  });
});

describe("fetchAssetList with a malformed response", () => {
  const cases: readonly [string, () => Response, string][] = [
    ["a body that is not JSON", () => new Response("<html>"), "$"],
    ["a JSON array", () => Response.json([]), "$"],
    ["a JSON null", () => Response.json(null), "$"],
    ["no tokens field", () => Response.json({ items: [] }), "$.tokens"],
    ["tokens that is not an array", () => Response.json({ tokens: {} }), "$.tokens"],
    ["an empty list", () => page([]), "$.tokens"],
    ["a token that is not an object", () => page(["NVDAc"]), "$.tokens[0]"],
    ["a missing address", () => page([{ ...validToken, contract_address: undefined }]), "$.tokens[0].contract_address"],
    ["a short address", () => page([{ ...validToken, contract_address: "0xb2" }]), "$.tokens[0].contract_address"],
    ["a missing symbol", () => page([validToken, { ...validToken, symbol: undefined }]), "$.tokens[1].symbol"],
    ["an empty name", () => page([{ ...validToken, name: "" }]), "$.tokens[0].name"],
    ["missing decimals", () => page([{ ...validToken, decimals: undefined }]), "$.tokens[0].decimals"],
    ["decimals as a string", () => page([{ ...validToken, decimals: "8" }]), "$.tokens[0].decimals"],
    ["fractional decimals", () => page([{ ...validToken, decimals: 8.5 }]), "$.tokens[0].decimals"],
    ["decimals out of range", () => page([{ ...validToken, decimals: 37 }]), "$.tokens[0].decimals"],
    ["a multiplier as a string", () => page([{ ...validToken, multiplier: "1" }]), "$.tokens[0].multiplier"],
    ["a negative total supply", () => page([{ ...validToken, total_supply: -1 }]), "$.tokens[0].total_supply"],
    ["a NAV price as a string", () => page([{ ...validToken, nav_price: "129.82" }]), "$.tokens[0].nav_price"],
    ["a NAV price without its timestamp", () => page([{ ...validToken, nav_price: 129.82 }]), "$.tokens[0].nav_price"],
    ["an ISIN that is not a string", () => page([{ ...validToken, isin: 67066 }]), "$.tokens[0].isin"],
    [
      "a page token that is not a string",
      () => Response.json({ tokens: [validToken], next_page_token: 7 }),
      "$.next_page_token",
    ],
    ["the same token twice", () => page([validToken, { ...validToken, symbol: "COPYc" }]), "$.tokens"],
  ];

  for (const [name, response, path] of cases) {
    test(`rejects ${name} without retrying`, async () => {
      const { fetch, calls } = scriptedFetch([response]);
      const error = await rejection(fetchAssetList({ fetch, sleep: noSleep }));
      expect(error).toBeInstanceOf(MalformedResponseError);
      expect(error).toMatchObject({ code: "malformed_response", source: "coinbase_api", path });
      expect(calls).toHaveLength(1);
    });
  }

  test("rejects the same token under a different letter case", async () => {
    const lower = { ...validToken, contract_address: validToken.contract_address.toLowerCase() };
    const { fetch } = scriptedFetch([page([validToken], "next"), page([lower])]);
    expect(await rejection(fetchAssetList({ fetch, sleep: noSleep }))).toBeInstanceOf(MalformedResponseError);
  });

  test("rejects a page token that repeats, instead of looping", async () => {
    const other = { ...validToken, contract_address: "0xb200000000000000000000397293Cb8cda9a10c5" };
    const { fetch, calls } = scriptedFetch([page([validToken], "same"), page([other], "same")]);
    const error = await rejection(fetchAssetList({ fetch, sleep: noSleep }));
    expect(error).toMatchObject({ code: "malformed_response", path: "$.next_page_token" });
    expect(calls).toHaveLength(2);
  });

  test("stops after twenty pages when the pagination never ends", async () => {
    const script = Array.from({ length: 25 }, (_, index) => () => {
      const address = `0xb2${index.toString(16).padStart(38, "0")}`;
      return page([{ ...validToken, contract_address: address }], `token-${index}`);
    });
    const { fetch, calls } = scriptedFetch(script);
    const error = await rejection(fetchAssetList({ fetch, sleep: noSleep }));
    expect(error).toMatchObject({ code: "malformed_response", path: "$.next_page_token" });
    expect(calls).toHaveLength(20);
  });
});

describe("parseAssetListPage", () => {
  test("accepts every recorded page", () => {
    for (const recorded of assetListFixture.pages) {
      const parsed = parseAssetListPage(recorded);
      expect(parsed.tokens).toHaveLength(recorded.tokens.length);
      expect(parsed.nextPageToken).toBe(recorded.next_page_token ?? null);
    }
  });

  test("ignores a field it does not know and treats omitted optional fields as absent", () => {
    const parsed = parseAssetListPage({ tokens: [{ ...validToken, added_later: { nested: true } }] });
    expect(parsed.tokens[0]).toEqual({
      address: "0xb20000000000000000000078ee7ce2fe4908108c",
      symbol: "NVDAc",
      name: "NVIDIA Corporation",
      decimals: 8,
      isin: null,
      iconUrl: null,
    });
    expect(parsed.nextPageToken).toBeNull();
  });
});

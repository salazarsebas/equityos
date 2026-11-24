import { describe, expect, test } from "bun:test";
import {
  ApiError,
  createClient,
  OPERATIONS,
  RegistryNotDeployedError,
  ResponseShapeError,
  TransportError,
} from "../src/index.ts";
import { EXAMPLES, example, exampleFetch, mockFetch } from "./support.ts";

const BASE_URL = "https://equityos.example";
const DIVERSIFIED = "diversified-equity-d622e2a5";
const ACCOUNT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

function clientFor(name: string) {
  const mock = exampleFetch(name);
  return { client: createClient({ baseUrl: BASE_URL, fetch: mock.fetch }), calls: mock.calls };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("createClient", () => {
  test("appends /api/v1 to the base URL and drops a trailing slash", () => {
    expect(createClient({ baseUrl: `${BASE_URL}/`, fetch: exampleFetch("getStatus").fetch }).apiUrl).toBe(
      `${BASE_URL}/api/v1`,
    );
    expect(createClient({ baseUrl: "http://127.0.0.1:3000", fetch: exampleFetch("getStatus").fetch }).apiUrl).toBe(
      "http://127.0.0.1:3000/api/v1",
    );
  });

  test("refuses a base URL that is not an absolute http or https URL", () => {
    for (const baseUrl of ["equityos.example", "ftp://equityos.example", `${BASE_URL}?x=1`, ""]) {
      expect(() => createClient({ baseUrl, fetch: exampleFetch("getStatus").fetch })).toThrow(TypeError);
    }
  });

  test("sends a GET with Accept: application/json and the extra headers", async () => {
    const mock = exampleFetch("getStatus");
    const client = createClient({ baseUrl: BASE_URL, fetch: mock.fetch, headers: { "X-Caller": "test" } });
    await client.getStatus();
    expect(mock.calls).toEqual([
      {
        url: `${BASE_URL}/api/v1/status`,
        init: { method: "GET", headers: { Accept: "application/json", "X-Caller": "test" } },
      },
    ]);
  });
});

describe("request URLs", () => {
  const cases: readonly [string, (client: ReturnType<typeof createClient>) => Promise<unknown>, string][] = [
    ["listAssets", (client) => client.listAssets(), "/assets"],
    ["listAssets", (client) => client.listAssets({ eligible: true }), "/assets?eligible=true"],
    ["getAsset", (client) => client.getAsset("0xB2000000000000000000007"), "/assets/0xB2000000000000000000007"],
    ["listIndexes", (client) => client.listIndexes({ offset: 3, limit: 2 }), "/indexes?offset=3&limit=2"],
    ["getIndex", (client) => client.getIndex("a b/c"), "/indexes/a%20b%2Fc"],
    ["getIndexVersion", (client) => client.getIndexVersion(DIVERSIFIED, 2), `/indexes/${DIVERSIFIED}/versions/2`],
    ["getIndexComposition", (client) => client.getIndexComposition(DIVERSIFIED), `/indexes/${DIVERSIFIED}/composition`],
    [
      "getIndexComposition",
      (client) => client.getIndexComposition(DIVERSIFIED, { version: 1 }),
      `/indexes/${DIVERSIFIED}/composition?version=1`,
    ],
    [
      "getPortfolio",
      (client) => client.getPortfolio({ address: ACCOUNT, index: DIVERSIFIED }),
      `/portfolio?address=${ACCOUNT}&index=${DIVERSIFIED}`,
    ],
    [
      "getPortfolioPlan",
      (client) =>
        client.getPortfolioPlan({
          address: ACCOUNT,
          index: DIVERSIFIED,
          version: 2,
          mode: "buy_only",
          depositUsdE8: 100_000_000_000_000_000n,
          reserveBps: 0,
          minLegValueUsdE8: 0n,
        }),
      `/portfolio/plan?address=${ACCOUNT}&index=${DIVERSIFIED}&version=2&mode=buy_only&depositUsdE8=100000000000000000&reserveBps=0&minLegValueUsdE8=0`,
    ],
    ["getStatus", (client) => client.getStatus(), "/status"],
  ];

  for (const [name, call, path] of cases) {
    test(`${path}`, async () => {
      const { client, calls } = clientFor(name);
      await call(client);
      expect(calls.map(({ url }) => url)).toEqual([`${BASE_URL}/api/v1${path}`]);
    });
  }

  test("the OpenAPI document is requested from /openapi.json and returned as served", async () => {
    const document = { openapi: "3.1.0", paths: {} };
    const mock = mockFetch(() => Response.json(document));
    const client = createClient({ baseUrl: BASE_URL, fetch: mock.fetch });
    expect(await client.getOpenApiDocument()).toEqual(document);
    expect(mock.calls[0]?.url).toBe(`${BASE_URL}/api/v1${OPERATIONS.getOpenApiDocument.path}`);
  });
});

describe("decoding the recorded responses", () => {
  test("an asset: amounts become bigint, counts stay numbers, unknown fields are dropped", async () => {
    const { client } = clientFor("getAsset");
    const { data, meta } = await client.getAsset("0xb20000000000000000000078ee7ce2fe4908108c");
    expect(data).toMatchObject({ symbol: "NVDAc", decimals: 8 });
    expect(data.referencePrice.priceE8).toBe(12982480034n);
    expect(data.referencePrice.roundId).toBe(36893488147419104856n);
    expect(typeof data.onchain.totalSupply).toBe("bigint");
    expect(data.onchain.multiplierWad).toBe(1_000_537_939_576_369_481n);
    expect(meta.datasets.onchain.blockNumber).toBe(60489401n);
    expect(meta.datasets.onchain.ageSeconds).toBe(0);
  });

  test("a verified version carries the spec, a version that fails C5 does not", async () => {
    const verified = await clientFor("getIndexVersion").client.getIndexVersion(DIVERSIFIED, 2);
    expect(verified.data.verification.conformant).toBe(true);
    expect(verified.data.spec?.slug).toBe("diversified-equity");
    expect(verified.data.publishedBlock).toBeTypeOf("bigint");

    const failed = await clientFor("getIndexVersion.notConformant").client.getIndexVersion("0x50f8", 1);
    expect(failed.data.spec).toBeNull();
    expect(failed.data.verification.checks.at(-1)).toMatchObject({ id: "C5", status: "fail", code: "weight_mismatch" });
  });

  test("a ready plan and a blocked plan are told apart by status", async () => {
    const ready = await clientFor("getPortfolioPlan").client.getPortfolioPlan({
      address: ACCOUNT,
      index: DIVERSIFIED,
      mode: "rebalance",
    });
    expect(ready.data.executable).toBe(false);
    if (ready.data.plan.status !== "ready") throw new Error("expected a ready plan");
    expect(ready.data.plan.legs.every(({ quoteAmount }) => typeof quoteAmount === "bigint")).toBe(true);

    const blocked = await clientFor("getPortfolioPlan.blocked").client.getPortfolioPlan({
      address: ACCOUNT,
      index: DIVERSIFIED,
      mode: "buy_only",
    });
    if (blocked.data.plan.status !== "blocked") throw new Error("expected a blocked plan");
    expect(blocked.data.plan.blockers[0]?.minimumDeployableValueUsdE8).toBeTypeOf("bigint");
  });

  test("a portfolio keeps null where the API says a value does not exist", async () => {
    const { data } = await clientFor("getPortfolio").client.getPortfolio({ address: ACCOUNT, index: DIVERSIFIED });
    expect(data.totals.quoteBalance).toBe(250500000n);
    expect(data.issues.every(({ uninvestedQuote }) => uninvestedQuote === null)).toBe(true);
  });

  for (const recorded of EXAMPLES.filter(({ status }) => status === 200)) {
    test(`${recorded.name} decodes`, async () => {
      const operation = OPERATIONS[recorded.operationId as keyof typeof OPERATIONS];
      if (!operation.envelope) throw new Error("the examples are envelopes");
      const body = recorded.body as { data: unknown; meta: unknown };
      expect(() => operation.data.decode(body.data, "data")).not.toThrow();
      expect(() => operation.meta.decode(body.meta, "meta")).not.toThrow();
    });
  }
});

describe("versioning rules of API v1", () => {
  test("a field the SDK does not know is ignored and an unknown enumeration value is kept", async () => {
    const body = structuredClone(example("getAsset").body) as {
      data: Record<string, unknown> & { referencePrice: Record<string, unknown> };
    };
    body.data.addedLater = { anything: true };
    body.data.referencePrice.status = "a_status_added_later";
    const client = createClient({ baseUrl: BASE_URL, fetch: mockFetch(() => Response.json(body)).fetch });
    const { data } = await client.getAsset("0xb20000000000000000000078ee7ce2fe4908108c");
    expect("addedLater" in data).toBe(false);
    expect(data.referencePrice.status).toBe("a_status_added_later");
  });
});

describe("pagination", () => {
  test("iterateIndexes follows meta.nextOffset until it is null", async () => {
    const recorded = example("listIndexes").body as { data: unknown[]; meta: Record<string, unknown> };
    const [first, second] = recorded.data;
    const mock = mockFetch((url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      const data = offset === 0 ? [first] : [second];
      const meta = { ...recorded.meta, offset, limit: 1, count: 1, total: 2, nextOffset: offset === 0 ? 1 : null };
      return Response.json({ data, meta });
    });
    const client = createClient({ baseUrl: BASE_URL, fetch: mock.fetch });
    const positions: number[] = [];
    for await (const index of client.iterateIndexes({ limit: 1 })) positions.push(index.position);
    expect(positions).toEqual([0, 1]);
    expect(mock.calls.map(({ url }) => url)).toEqual([
      `${BASE_URL}/api/v1/indexes?offset=0&limit=1`,
      `${BASE_URL}/api/v1/indexes?offset=1&limit=1`,
    ]);
  });
});

describe("errors", () => {
  test("registry_not_deployed is a RegistryNotDeployedError with the chain, address and reason", async () => {
    const error = await rejection(clientFor("listIndexes.registryNotDeployed").client.listIndexes());
    expect(error).toBeInstanceOf(RegistryNotDeployedError);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "registry_not_deployed",
      chainId: 8453,
      registry: "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c",
      reason: "not_configured",
      retryAfterSeconds: null,
    });
  });

  test("an API error keeps its status, code, message and details", async () => {
    const error = await rejection(clientFor("getAsset.invalidAddress").client.getAsset("0x1234"));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(RegistryNotDeployedError);
    expect(error).toMatchObject({ status: 400, code: "invalid_address", details: { parameter: "address" } });
  });

  test("version_not_conformant and index_not_found", async () => {
    const conformance = await rejection(clientFor("getIndexComposition.notConformant").client.getIndexComposition("x"));
    expect(conformance).toMatchObject({ status: 409, code: "version_not_conformant" });
    const missing = await rejection(clientFor("getIndex.notFound").client.getIndex("another-name-d622e2a5"));
    expect(missing).toMatchObject({ status: 404, code: "index_not_found", details: null });
  });

  test("a 503 carries the seconds of Retry-After", async () => {
    const body = {
      error: { code: "upstream_unavailable", message: "Retry shortly.", details: { source: "base_rpc" } },
    };
    const fetch = mockFetch(() => Response.json(body, { status: 503, headers: { "Retry-After": "15" } })).fetch;
    const error = await rejection(createClient({ baseUrl: BASE_URL, fetch }).getStatus());
    expect(error).toMatchObject({ status: 503, code: "upstream_unavailable", retryAfterSeconds: 15 });
  });

  test("a failed request is a TransportError with its cause", async () => {
    const cause = new Error("connection refused");
    const fetch = async () => {
      throw cause;
    };
    const error = await rejection(createClient({ baseUrl: BASE_URL, fetch }).getStatus());
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ url: `${BASE_URL}/api/v1/status`, cause });
  });

  test("a body that is not JSON, or not the documented shape, is a ResponseShapeError at its path", async () => {
    const html = createClient({ baseUrl: BASE_URL, fetch: mockFetch(() => new Response("<html>")).fetch });
    expect(await rejection(html.getStatus())).toMatchObject({ name: "ResponseShapeError", status: 200, path: "" });

    const body = structuredClone(example("getAsset").body) as { data: { referencePrice: { priceE8: unknown } } };
    body.data.referencePrice.priceE8 = 129.82;
    const float = createClient({ baseUrl: BASE_URL, fetch: mockFetch(() => Response.json(body)).fetch });
    const error = await rejection(float.getAsset("0xb20000000000000000000078ee7ce2fe4908108c"));
    expect(error).toBeInstanceOf(ResponseShapeError);
    expect(error).toMatchObject({ path: "data.referencePrice.priceE8" });

    const proxy = createClient({
      baseUrl: BASE_URL,
      fetch: mockFetch(() => new Response("{}", { status: 502 })).fetch,
    });
    expect(await rejection(proxy.getStatus())).toMatchObject({ name: "ResponseShapeError", status: 502 });
  });
});

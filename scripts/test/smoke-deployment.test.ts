import { describe, expect, test } from "bun:test";
import {
  formatSmokeReport,
  KEY_DOCUMENTS,
  KEY_PAGES,
  parseArguments,
  referencePriceProblem,
  runSmokeChecks,
} from "../smoke-deployment.ts";

const BASE = "https://equityos.example";
const FEED = "0x787f13dea48db0897cbcdd985de77809d837f988";
const IDENTIFIER = "large-technology-equal-f0ed26b1";

const price = {
  status: "live",
  priceE8: "34529769685",
  updatedAt: "2026-11-24T15:12:02Z",
  roundId: "36893488147419103834",
  unavailableReason: null,
  lastObserved: null,
  feedProxy: FEED,
};
const datasets = {
  assetList: { source: "coinbase_api", fetchedAt: "2026-11-24T15:20:00Z", servedStale: false, failure: null },
  onchain: {
    source: "base_rpc",
    fetchedAt: "2026-11-24T15:20:00Z",
    servedStale: false,
    failure: null,
    blockNumber: "60600000",
    blockTimestamp: "2026-11-24T15:19:59Z",
  },
};

/** The answers of a healthy deployment on Base mainnet, as the API documents them. */
function healthy(): Record<string, unknown> {
  return {
    "/api/v1/status": {
      data: {
        chainId: 8453,
        marketData: { mode: "live", available: true, referencePriceSource: "chainlink", datasets, error: null },
        registry: { chainId: 8453, mode: "live", deployed: true, notDeployedReason: null, indexCount: 3, error: null },
      },
      meta: { mode: "live", asOf: "2026-11-24T15:20:00Z" },
    },
    "/api/v1/assets?eligible=true": {
      data: [
        { symbol: "AAPLc", referencePrice: price },
        {
          symbol: "MSFTc",
          referencePrice: { ...price, status: "unavailable", reason: undefined, unavailableReason: "stale_feed" },
        },
      ],
      meta: { mode: "live", referencePriceSource: "chainlink", datasets },
    },
    "/api/v1/indexes": {
      data: [{ identifier: IDENTIFIER }],
      meta: { mode: "live", registry: { chainId: 8453, mode: "live" }, total: 3 },
    },
    "/api/v1/network": {
      data: { chainId: 8453, scan: { scannedToBlock: "60599988" }, metrics: { indexesPublished: { value: 3 } } },
      meta: { mode: "live" },
    },
  };
}

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
};

interface Deployment {
  readonly json?: Record<string, unknown>;
  readonly status?: Record<string, number>;
  readonly headers?: Record<string, string>;
  readonly unreachable?: boolean;
}

/** A `fetch` that answers like a deployment and records each request. Nothing leaves the process. */
function deployment(options: Deployment = {}) {
  const json = options.json ?? healthy();
  const requests: { url: string; headers: Headers; method: string }[] = [];
  const serve = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push({ url: url.toString(), headers: new Headers(init?.headers), method: init?.method ?? "GET" });
    if (options.unreachable) throw new TypeError("fetch failed");
    const path = `${url.pathname}${url.search}`;
    const status = options.status?.[path] ?? 200;
    const body = json[path];
    if (body !== undefined) return Response.json(body, { status });
    return new Response("<!doctype html><title>EquityOS</title>", {
      status,
      headers: { "content-type": "text/html", ...(path === "/" ? (options.headers ?? SECURITY_HEADERS) : {}) },
    });
  };
  return { fetch: Object.assign(serve, { preconnect: fetch.preconnect }), requests };
}

function byName(results: Awaited<ReturnType<typeof runSmokeChecks>>) {
  return Object.fromEntries(results.map(({ name, ok, detail }) => [name, { ok, detail }]));
}

describe("runSmokeChecks", () => {
  test("passes against a healthy deployment, with GET requests only, and reports what it saw", async () => {
    const server = deployment();
    const results = await runSmokeChecks(`${BASE}/some/path`, { fetch: server.fetch });
    expect(results.map(({ name }) => name)).toEqual([
      "status",
      "assets",
      "indexes",
      "network",
      "pages",
      "security headers",
    ]);
    expect(results.every(({ ok }) => ok)).toBe(true);
    expect(server.requests.every(({ method }) => method === "GET")).toBe(true);
    const urls = server.requests.map(({ url }) => url);
    for (const page of [...KEY_PAGES, ...KEY_DOCUMENTS, `/indexes/${IDENTIFIER}`])
      expect(urls).toContain(`${BASE}${page}`);
    const report = formatSmokeReport(BASE, results);
    expect(report).toContain("ok   status");
    expect(report).toContain("registry deployed on chain 8453 with 3 indexes, market block 60600000");
    expect(report).toContain("2 eligible, 1 with a usable reference price");
    expect(report).toContain("all checks passed");
  });

  test("fails every API check that serves a replay", async () => {
    const json = healthy();
    for (const body of Object.values(json)) Object.assign((body as { meta: object }).meta, { mode: "replay" });
    const results = byName(await runSmokeChecks(BASE, { fetch: deployment({ json }).fetch }));
    for (const name of ["status", "assets", "indexes", "network"]) {
      expect(results[name]).toEqual({ ok: false, detail: 'meta.mode is "replay", not "live"' });
    }
  });

  test("fails when the registry is not deployed, or is deployed on another chain", async () => {
    const notDeployed = healthy();
    Object.assign(notDeployed, {
      "/api/v1/indexes": { error: { code: "registry_not_deployed", message: "", details: null } },
      "/api/v1/network": { error: { code: "registry_not_deployed", message: "", details: null } },
    });
    const status = notDeployed["/api/v1/status"] as { data: { registry: object } };
    Object.assign(status.data.registry, { deployed: false, notDeployedReason: "not_configured", indexCount: null });
    const server = deployment({ json: notDeployed, status: { "/api/v1/indexes": 409, "/api/v1/network": 409 } });
    const results = byName(await runSmokeChecks(BASE, { fetch: server.fetch }));
    expect(results.status?.ok).toBe(false);
    expect(results.status?.detail).toContain("registry deployed is false");
    expect(results.indexes).toEqual({ ok: false, detail: "HTTP 409 registry_not_deployed" });
    expect(results.network).toEqual({ ok: false, detail: "HTTP 409 registry_not_deployed" });

    const sepolia = byName(await runSmokeChecks(BASE, { fetch: deployment().fetch, chainId: 84_532 }));
    expect(sepolia.status?.detail).toContain("registry chain is 8453, expected 84532");
    expect(sepolia.indexes?.detail).toBe("read from chain 8453, expected 84532");
  });

  test("fails an empty registry", async () => {
    const json = healthy();
    Object.assign(json["/api/v1/indexes"] as object, {
      data: [],
      meta: { mode: "live", registry: { chainId: 8453 }, total: 0 },
    });
    const results = byName(await runSmokeChecks(BASE, { fetch: deployment({ json }).fetch }));
    expect(results.indexes).toEqual({ ok: false, detail: "the registry holds 0 indexes" });
  });

  test("fails a price without its feed or its time, and a list without any usable price", async () => {
    const json = healthy();
    (json["/api/v1/assets?eligible=true"] as { data: object[] }).data = [
      { symbol: "AAPLc", referencePrice: { ...price, updatedAt: null } },
      { symbol: "NVDAc", referencePrice: { ...price, feedProxy: null } },
    ];
    const results = byName(await runSmokeChecks(BASE, { fetch: deployment({ json }).fetch }));
    expect(results.assets?.ok).toBe(false);
    expect(results.assets?.detail).toContain("AAPLc has no publication time");
    expect(results.assets?.detail).toContain("NVDAc names no feed");
    expect(results.assets?.detail).toContain("no asset has a usable reference price");
  });

  test("fails a page that does not answer 200, and missing security headers", async () => {
    const server = deployment({ status: { "/studio": 500 }, headers: { "x-content-type-options": "nosniff" } });
    const results = byName(await runSmokeChecks(BASE, { fetch: server.fetch }));
    expect(results.pages).toEqual({ ok: false, detail: "/studio HTTP 500" });
    expect(results["security headers"]).toEqual({
      ok: false,
      detail: "missing content-security-policy, strict-transport-security, frame-ancestors",
    });
  });

  test("reports an unreachable deployment as failed checks, without throwing", async () => {
    const results = await runSmokeChecks(BASE, { fetch: deployment({ unreachable: true }).fetch });
    expect(results.every(({ ok }) => !ok)).toBe(true);
    expect(byName(results).status?.detail).toBe("request failed (TypeError)");
    expect(formatSmokeReport(BASE, results)).toContain("6 of 6 checks failed");
  });

  test("sends the protection bypass secret as a header, and never prints it", async () => {
    const server = deployment();
    const secret = "bypass-secret-placeholder";
    const results = await runSmokeChecks(BASE, { fetch: server.fetch, bypassSecret: secret });
    expect(server.requests.every(({ headers }) => headers.get("x-vercel-protection-bypass") === secret)).toBe(true);
    expect(formatSmokeReport(BASE, results)).not.toContain(secret);
    const plain = deployment();
    await runSmokeChecks(BASE, { fetch: plain.fetch });
    expect(plain.requests.every(({ headers }) => !headers.has("x-vercel-protection-bypass"))).toBe(true);
  });
});

describe("referencePriceProblem", () => {
  test("accepts a usable price with its feed and time, and an unavailable one with its reason", () => {
    expect(referencePriceProblem(price)).toBeNull();
    expect(referencePriceProblem({ ...price, status: "last_close" })).toBeNull();
    expect(referencePriceProblem({ ...price, status: "unavailable", unavailableReason: "stale_feed" })).toBeNull();
    expect(referencePriceProblem({ ...price, status: "unavailable", unavailableReason: null })).toBe(
      "is unavailable without a reason",
    );
    expect(referencePriceProblem({ ...price, priceE8: "0" })).toBe("has no positive price");
    expect(referencePriceProblem({ ...price, updatedAt: "yesterday" })).toBe("has no publication time");
    expect(referencePriceProblem(null)).toBe("has no reference price object");
  });
});

describe("parseArguments", () => {
  test("takes a URL and an optional chain", () => {
    expect(parseArguments([BASE])).toEqual({ url: BASE, chainId: 8453 });
    expect(parseArguments([BASE, "--chain", "84532"])).toEqual({ url: BASE, chainId: 84_532 });
    expect(() => parseArguments([])).toThrow("usage");
    expect(() => parseArguments(["equityos.example"])).toThrow("usage");
    expect(() => parseArguments([BASE, "--chain", "1"])).toThrow("--chain");
  });
});

import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { assetHandler, assetsHandler } from "../../src/server/api/assets";
import { API_VERSION } from "../../src/server/api/http";
import {
  indexCompositionHandler,
  indexesHandler,
  indexHandler,
  indexVersionHandler,
} from "../../src/server/api/indexes";
import { networkHandler } from "../../src/server/api/network";
import { openApiDocument, type Schema } from "../../src/server/api/openapi";
import { portfolioHandler, portfolioPlanHandler } from "../../src/server/api/portfolio";
import { statusHandler } from "../../src/server/api/status";
import { resolveRegistryConfig } from "../../src/server/registry/config";
import { RegistryUpstreamError } from "../../src/server/registry/errors";
import { createRegistryReader, type RegistryReader } from "../../src/server/registry/reader";
import { TOKENS } from "../market/support";
import { constructedRead, recordedNetwork, stubNetwork } from "../network/support";
import { buildSpec, FakeChain } from "../registry/support";
import {
  addressContext,
  fakeRegistry,
  fixtureService,
  get,
  identifierContext,
  RECORDED_AT,
  recordedRegistry,
  versionContext,
  wrongChain,
} from "./support";

const DIVERSIFIED = "diversified-equity-d622e2a5";
const MISMATCHED = "0x50f8aacd30bddc6f9e0fbca1501526b2ac01106e626678eab50a7867eb94d759";
const UNKNOWN = `0x${"1".repeat(64)}`;

function registryOptions(registry: RegistryReader = recordedRegistry(), service = fixtureService()) {
  return { registry: () => registry, mode: () => "replay" as const, marketData: service.marketData };
}

/** Base mainnet, where the registry is not deployed. */
function notDeployed() {
  return registryOptions(createRegistryReader({ config: resolveRegistryConfig({}) }));
}

/** A registry whose endpoint fails every call. */
function unreachable() {
  const chain = new FakeChain();
  chain.createIndex(buildSpec());
  chain.fail = (method) => method === "eth_call";
  return registryOptions(fakeRegistry(chain));
}

const API_ROOT = new URL("../../src/app/api/v1/", import.meta.url);

/** OpenAPI path of every `route.ts` under the API root: `assets/[address]/route.ts` is `/assets/{address}`. */
function routePaths(): string[] {
  return readdirSync(API_ROOT, { recursive: true, encoding: "utf8" })
    .filter((file) => /(^|\/)route\.ts$/.test(file))
    .map((file) => `/${file.replace(/\/?route\.ts$/, "").replace(/\[([^\]]+)\]/g, "{$1}")}`);
}

// Strict mode rejects unknown keywords and formats, so a misspelled keyword in a schema fails the tests. The
// two keywords below are the containers of the OpenAPI document that hold the schemas.
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addKeyword("components");
ajv.addSchema({ $id: "openapi", components: { schemas: openApiDocument.components.schemas } });

function responseSchema(path: string, status: number): Schema {
  const schema = openApiDocument.paths[path]?.get.responses[String(status)]?.content["application/json"].schema;
  if (schema === undefined) throw new Error(`${path} documents no ${status} response`);
  return schema;
}

/** Validates a real response of a handler against the schema the document gives for its path and status. */
async function expectDocumented(path: string, response: Response): Promise<void> {
  const absolute = JSON.parse(
    JSON.stringify(responseSchema(path, response.status)).replaceAll('"#/components/', '"openapi#/components/'),
  );
  const validate = ajv.compile(absolute);
  const valid = validate(JSON.parse(await response.text()));
  expect(validate.errors ?? []).toEqual([]);
  expect(valid).toBe(true);
}

function collectRefs(value: unknown, refs: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const item of value) collectRefs(item, refs);
  else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") refs.add(child);
      else collectRefs(child, refs);
    }
  }
  return refs;
}

describe("OpenAPI document", () => {
  test("describes every route under src/app/api/v1 and nothing else", () => {
    expect(Object.keys(openApiDocument.paths).sort()).toEqual(routePaths().sort());
    expect(routePaths().length).toBeGreaterThanOrEqual(8);
  });

  test("is OpenAPI 3.1 at the version the responses carry", () => {
    expect(openApiDocument.openapi).toBe("3.1.0");
    expect(openApiDocument.info.version).toBe(API_VERSION);
    expect(openApiDocument.servers).toEqual([{ url: "/api/v1", description: "This deployment" }]);
  });

  test("every reference resolves and every operation has a unique id", () => {
    const { components, paths } = openApiDocument;
    for (const ref of collectRefs(openApiDocument)) {
      const [, , kind, name] = ref.split("/");
      const target = kind === "schemas" ? components.schemas : kind === "headers" ? components.headers : {};
      expect(Object.keys(target)).toContain(name ?? ref);
    }
    const ids = Object.values(paths).map((path) => path.get.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every schema compiles in strict mode and every object schema is closed", () => {
    for (const name of Object.keys(openApiDocument.components.schemas)) {
      expect(() => ajv.compile({ $ref: `openapi#/components/schemas/${name}` })).not.toThrow();
    }
    const open: string[] = [];
    const visit = (schema: Schema, at: string) => {
      if (schema.properties !== undefined && schema.additionalProperties !== false) open.push(at);
      for (const [key, child] of Object.entries(schema.properties ?? {})) visit(child, `${at}.${key}`);
      for (const child of schema.anyOf ?? []) visit(child, at);
      if (schema.items) visit(schema.items, `${at}[]`);
    };
    for (const [name, schema] of Object.entries(openApiDocument.components.schemas)) visit(schema, name);
    expect(open).toEqual([]);
  });

  test("path parameters in the document match the placeholders of the path", () => {
    for (const [path, { get: operation }] of Object.entries(openApiDocument.paths)) {
      const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? "");
      const declared = (operation.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name);
      expect(declared).toEqual(placeholders);
    }
  });
});

describe("handler output validates against the document", () => {
  test("GET /assets: success, filtered, stale feed, bad parameter and each upstream failure", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const responses = [
        await assetsHandler(fixtureService().marketData)(get("/api/v1/assets"), undefined),
        await assetsHandler(fixtureService().marketData)(get("/api/v1/assets?eligible=false"), undefined),
        await assetsHandler(fixtureService(RECORDED_AT + 198_000).marketData)(get("/api/v1/assets"), undefined),
        await assetsHandler(fixtureService().marketData)(get("/api/v1/assets?limit=1"), undefined),
        await assetsHandler(fixtureService(RECORDED_AT, { apiBody: [] }).marketData)(get("/api/v1/assets"), undefined),
        await assetsHandler(fixtureService(RECORDED_AT, { override: wrongChain }).marketData)(
          get("/api/v1/assets"),
          undefined,
        ),
      ];
      const down = fixtureService();
      down.outage.rpc = true;
      responses.push(await assetsHandler(down.marketData)(get("/api/v1/assets"), undefined));
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 400, 502, 500, 503]);
      for (const response of responses) await expectDocumented("/assets", response);
    } finally {
      log.mockRestore();
    }
  });

  test("GET /assets/{address}: found, not eligible, malformed address, unknown address and a source down", async () => {
    const handler = assetHandler(fixtureService().marketData);
    const down = fixtureService();
    down.outage.api = true;
    const responses = [
      await handler(get("/"), addressContext(TOKENS.NVDA)),
      await handler(get("/"), addressContext(TOKENS.RKT)),
      await handler(get("/"), addressContext("0x12")),
      await handler(get("/"), addressContext(`0x${"0".repeat(40)}`)),
      await assetHandler(down.marketData)(get("/"), addressContext(TOKENS.NVDA)),
    ];
    expect(responses.map((response) => response.status)).toEqual([200, 200, 400, 404, 503]);
    for (const response of responses) await expectDocumented("/assets/{address}", response);
  });

  test("GET /status: available, unavailable and a bad parameter", async () => {
    const service = fixtureService();
    const options = {
      marketData: service.marketData,
      mode: () => "live" as const,
      registry: () => recordedRegistry(),
      registryMode: () => "replay" as const,
      now: () => service.clock.now,
    };
    const responses = [
      await statusHandler(options)(get("/api/v1/status", { "x-vercel-ip-country": "US" }), undefined),
      await statusHandler(options)(get("/api/v1/status?x=1"), undefined),
    ];
    service.outage.rpc = true;
    service.clock.now += 3_600;
    responses.push(await statusHandler(options)(get("/api/v1/status"), undefined));
    expect(responses.map((response) => response.status)).toEqual([200, 400, 200]);
    for (const response of responses) await expectDocumented("/status", response);
  });

  test("GET /indexes: recorded list, a page, empty, bad parameter, not deployed and registry down", async () => {
    const responses = [
      await indexesHandler(registryOptions())(get("/api/v1/indexes"), undefined),
      await indexesHandler(registryOptions())(get("/api/v1/indexes?offset=1&limit=2"), undefined),
      await indexesHandler(registryOptions(recordedRegistry("registry-empty")))(get("/api/v1/indexes"), undefined),
      await indexesHandler(registryOptions())(get("/api/v1/indexes?limit=0"), undefined),
      await indexesHandler(notDeployed())(get("/api/v1/indexes"), undefined),
      await indexesHandler(unreachable())(get("/api/v1/indexes"), undefined),
    ];
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 400, 409, 503]);
    for (const response of responses) await expectDocumented("/indexes", response);
  });

  test("GET /indexes/{identifier}: conformant, not conformant, malformed, unknown and not deployed", async () => {
    const handler = indexHandler(registryOptions());
    const responses = [
      await handler(get("/"), identifierContext(DIVERSIFIED)),
      await handler(get("/"), identifierContext(MISMATCHED)),
      await handler(get("/"), identifierContext("not an identifier")),
      await handler(get("/"), identifierContext(UNKNOWN)),
      await indexHandler(notDeployed())(get("/"), identifierContext(DIVERSIFIED)),
    ];
    expect(responses.map((response) => response.status)).toEqual([200, 200, 400, 404, 409]);
    for (const response of responses) await expectDocumented("/indexes/{identifier}", response);
  });

  test("GET /indexes/{identifier}/versions/{version}: every recorded version, and each error", async () => {
    const handler = indexVersionHandler(registryOptions());
    const chain = new FakeChain();
    const notUtf8 = chain.createIndex({ specBytes: Uint8Array.of(0xff), constituents: [], composition: 0 });
    const invalid = chain.createIndex({ ...buildSpec(), specBytes: new TextEncoder().encode('{"schema":"x"}') });
    const responses = [
      await handler(get("/"), versionContext(DIVERSIFIED, "1")),
      await handler(get("/"), versionContext(DIVERSIFIED, "2")),
      await handler(get("/"), versionContext("semiconductors-fixed-a3e409e2", "1")),
      await handler(get("/"), versionContext(MISMATCHED, "1")),
      await indexVersionHandler(registryOptions(fakeRegistry(chain)))(get("/"), versionContext(notUtf8, "1")),
      await indexVersionHandler(registryOptions(fakeRegistry(chain)))(get("/"), versionContext(invalid, "1")),
      await handler(get("/"), versionContext(DIVERSIFIED, "zero")),
      await handler(get("/"), versionContext(DIVERSIFIED, "3")),
      await indexVersionHandler(notDeployed())(get("/"), versionContext(DIVERSIFIED, "1")),
    ];
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200, 400, 404, 409]);
    for (const response of responses) await expectDocumented("/indexes/{identifier}/versions/{version}", response);
  });

  test("GET /indexes/{identifier}/composition: priced, unlisted, not conformant, unknown and sources down", async () => {
    const handler = indexCompositionHandler(registryOptions());
    const chain = new FakeChain();
    const unlisted = chain.createIndex(buildSpec());
    const down = fixtureService();
    down.outage.rpc = true;
    const responses = [
      await handler(get("/"), identifierContext(DIVERSIFIED)),
      await handler(get("/api/v1/x?version=1"), identifierContext(DIVERSIFIED)),
      await indexCompositionHandler(registryOptions(fakeRegistry(chain)))(get("/"), identifierContext(unlisted)),
      await handler(get("/api/v1/x?version=0"), identifierContext(DIVERSIFIED)),
      await handler(get("/"), identifierContext(UNKNOWN)),
      await handler(get("/"), identifierContext(MISMATCHED)),
      await indexCompositionHandler(notDeployed())(get("/"), identifierContext(DIVERSIFIED)),
      await indexCompositionHandler(registryOptions(recordedRegistry(), down))(
        get("/"),
        identifierContext(DIVERSIFIED),
      ),
    ];
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 400, 404, 409, 409, 503]);
    for (const response of responses) await expectDocumented("/indexes/{identifier}/composition", response);
  });

  test("GET /network: constructed and recorded activity, an empty registry, bad parameter, not deployed and registry down", async () => {
    const mode = () => "replay" as const;
    const read = constructedRead();
    const responses = [
      await networkHandler({ network: stubNetwork(read), mode })(get("/api/v1/network"), undefined),
      await recordedNetwork()(get("/api/v1/network"), undefined),
      await recordedNetwork("registry-empty")(get("/api/v1/network"), undefined),
      await networkHandler({ network: stubNetwork(read), mode })(get("/api/v1/network?x=1"), undefined),
      await networkHandler({
        network: stubNetwork({
          status: "registry_not_deployed",
          chainId: 8453,
          registry: "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c",
          reason: "not_configured",
        }),
        mode,
      })(get("/api/v1/network"), undefined),
      await networkHandler({ network: stubNetwork(new RegistryUpstreamError("down")), mode })(
        get("/api/v1/network"),
        undefined,
      ),
    ];
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 400, 409, 503]);
    for (const response of responses) await expectDocumented("/network", response);
  });

  test("GET /portfolio and /portfolio/plan: every state, each error and a source down", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const portfolioOptions = (registry: RegistryReader = recordedRegistry(), service = fixtureService()) => ({
        ...registryOptions(registry, service),
        marketMode: () => "replay" as const,
      });
      const accounts = [
        "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        "0x0000000000000000000000000000000000001001",
        "0x0000000000000000000000000000000000001003",
        "0x0000000000000000000000000000000000001004",
      ];
      const index = `index=${DIVERSIFIED}`;
      const stale = portfolioOptions(recordedRegistry(), fixtureService(RECORDED_AT + 198_000));
      const notDeployedOptions = { ...notDeployed(), marketMode: () => "live" as const };
      const failing = [
        `address=0x12&${index}`,
        `address=${accounts[0]}&index=${UNKNOWN}`,
        `address=${accounts[0]}&index=${MISMATCHED}`,
        `address=0x${"9".repeat(40)}&${index}`,
      ];
      const responses: Response[] = [];
      for (const address of accounts) {
        responses.push(await portfolioHandler(portfolioOptions())(get(`/?address=${address}&${index}`), undefined));
        responses.push(await portfolioHandler(stale)(get(`/?address=${address}&${index}`), undefined));
      }
      responses.push(
        await portfolioHandler(portfolioOptions())(get(`/?address=${accounts[3]}&${index}&version=1`), undefined),
      );
      for (const query of failing)
        responses.push(await portfolioHandler(portfolioOptions())(get(`/?${query}`), undefined));
      responses.push(await portfolioHandler(notDeployedOptions)(get(`/?address=${accounts[0]}&${index}`), undefined));
      expect(responses.map((response) => response.status)).toEqual([...Array(9).fill(200), 400, 404, 409, 503, 409]);
      for (const response of responses) await expectDocumented("/portfolio", response);

      const plans: Response[] = [];
      for (const address of accounts) {
        for (const mode of ["rebalance", "buy_only&depositUsdE8=200000000", "buy_only&depositUsdE8=100000000000"]) {
          plans.push(
            await portfolioPlanHandler(portfolioOptions())(
              get(`/?address=${address}&${index}&mode=${mode}`),
              undefined,
            ),
          );
        }
        plans.push(await portfolioPlanHandler(stale)(get(`/?address=${address}&${index}&mode=rebalance`), undefined));
      }
      plans.push(await portfolioPlanHandler(portfolioOptions())(get(`/?address=${accounts[0]}&${index}`), undefined));
      for (const query of failing) {
        plans.push(await portfolioPlanHandler(portfolioOptions())(get(`/?${query}&mode=rebalance`), undefined));
      }
      expect(plans.map((response) => response.status)).toEqual([...Array(16).fill(200), 400, 400, 404, 409, 503]);
      for (const response of plans) await expectDocumented("/portfolio/plan", response);
    } finally {
      log.mockRestore();
    }
  });

  test("a response with an undocumented field does not validate", () => {
    const validate = ajv.compile({ $ref: "openapi#/components/schemas/Eligibility" });
    expect(validate({ eligible: true, reasons: [] })).toBe(true);
    expect(validate({ eligible: true, reasons: [], score: 1 })).toBe(false);
    expect(validate({ eligible: true, reasons: ["delisted"] })).toBe(false);
  });
});

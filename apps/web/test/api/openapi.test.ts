import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { assetHandler, assetsHandler } from "../../src/server/api/assets";
import { API_VERSION } from "../../src/server/api/http";
import { openApiDocument, type Schema } from "../../src/server/api/openapi";
import { statusHandler } from "../../src/server/api/status";
import { TOKENS } from "../market/support";
import { addressContext, fixtureService, get, RECORDED_AT, wrongChain } from "./support";

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
    expect(routePaths().length).toBeGreaterThanOrEqual(4);
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
    const options = { marketData: service.marketData, mode: () => "live" as const, now: () => service.clock.now };
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

  test("a response with an undocumented field does not validate", () => {
    const validate = ajv.compile({ $ref: "openapi#/components/schemas/Eligibility" });
    expect(validate({ eligible: true, reasons: [] })).toBe(true);
    expect(validate({ eligible: true, reasons: [], score: 1 })).toBe(false);
    expect(validate({ eligible: true, reasons: ["delisted"] })).toBe(false);
  });
});

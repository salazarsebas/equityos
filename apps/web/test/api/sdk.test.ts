/**
 * Keeps `@equityos/sdk` and the OpenAPI document in agreement:
 *
 * - The SDK has an operation for every operation of the document, with the same method and path, and no other.
 * - The decoder of each success response has the shape of the schema the document gives for it, property by
 *   property: names, required and optional, nullability, enumerations, constants, and amounts as decimal strings.
 * - The recorded example responses are what the handlers produce now, validate against the document, and
 *   decode with the SDK client, success and error alike.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  API_ERROR_CODES as SDK_ERROR_CODES,
  ApiError,
  createClient,
  type EquityOSClient,
  OPERATIONS,
  RegistryNotDeployedError,
  type Shape,
} from "@equityos/sdk";
import Ajv2020 from "ajv/dist/2020";
import { API_ERROR_CODES } from "../../src/server/api/errors";
import { openApiDocument, type Schema } from "../../src/server/api/openapi";
import { EXAMPLES_FILE, type RecordedExample, type RecordedExamples, recordApiExamples } from "./examples";
import { FIXTURE_ORIGIN, type FixtureRegistry, fixtureServer } from "./fixture-server";

const { schemas } = openApiDocument.components;

interface DocumentedOperation {
  readonly method: string;
  readonly path: string;
  readonly responses: Readonly<
    Record<string, { readonly content: { readonly "application/json": { schema: Schema } } }>
  >;
}

/** Every operation of the document by `operationId`, whatever its method. */
function documentedOperations(): Map<string, DocumentedOperation> {
  const operations = new Map<string, DocumentedOperation>();
  for (const [path, item] of Object.entries(openApiDocument.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (operation === undefined) continue;
      operations.set(operation.operationId, { method: method.toUpperCase(), path, responses: operation.responses });
    }
  }
  return operations;
}

function refName(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

function resolve(schema: Schema): Schema {
  if (schema.$ref === undefined) return schema;
  const target = schemas[refName(schema.$ref)];
  if (target === undefined) throw new Error(`unresolved ${schema.$ref}`);
  return resolve(target);
}

function describeShape(shape: Shape): string {
  return shape.kind;
}

/**
 * Compares a decoder shape with a schema of the document and returns every difference, each with its path. A
 * schema that refers to `UintString` must be decoded as a `uint`: an amount is never a plain string.
 */
function compare(shape: Shape, schema: Schema, at: string): string[] {
  if (schema.$ref !== undefined && refName(schema.$ref) === "UintString") {
    return shape.kind === "uint" ? [] : [`${at}: the document has an integer string, the SDK ${describeShape(shape)}`];
  }
  const resolved = resolve(schema);
  if (resolved.anyOf !== undefined) {
    const nonNull = resolved.anyOf.filter((member) => member.type !== "null");
    if (nonNull.length === 1 && resolved.anyOf.length === 2) {
      if (shape.kind !== "nullable") return [`${at}: the document allows null, the SDK does not`];
      return compare(shape.inner, nonNull[0] ?? {}, at);
    }
    if (shape.kind !== "union") return [`${at}: the document has a union, the SDK ${shape.kind}`];
    const tags = nonNull.map((member) => String(resolve(member).properties?.[shape.discriminant]?.const));
    const differences = tags.sort().join() === Object.keys(shape.options).sort().join() ? [] : [`${at}: union tags`];
    for (const member of nonNull) {
      const tag = String(resolve(member).properties?.[shape.discriminant]?.const);
      const option = shape.options[tag];
      if (option !== undefined) differences.push(...compare(option, member, `${at}<${tag}>`));
    }
    return differences;
  }
  if (shape.kind === "nullable") return [`${at}: the SDK allows null, the document does not`];
  switch (resolved.type) {
    case "string":
      if (resolved.const !== undefined) {
        return shape.kind === "literal" && shape.value === resolved.const ? [] : [`${at}: constant`];
      }
      if (resolved.enum !== undefined) {
        const documented = [...resolved.enum].sort().join();
        return shape.kind === "enum" && [...shape.values].sort().join() === documented ? [] : [`${at}: enumeration`];
      }
      return shape.kind === "string" ? [] : [`${at}: the document has a string, the SDK ${shape.kind}`];
    case "integer":
      return shape.kind === "integer" ? [] : [`${at}: the document has an integer, the SDK ${shape.kind}`];
    case "boolean":
      if (resolved.const !== undefined) {
        return shape.kind === "literal" && shape.value === resolved.const ? [] : [`${at}: constant`];
      }
      return shape.kind === "boolean" ? [] : [`${at}: the document has a boolean, the SDK ${shape.kind}`];
    case "array":
      if (shape.kind !== "array" || resolved.items === undefined) return [`${at}: the document has an array`];
      return compare(shape.items, resolved.items, `${at}[]`);
    case "object": {
      if (resolved.properties === undefined) {
        return shape.kind === "json" ? [] : [`${at}: the document has an unspecified object`];
      }
      if (shape.kind !== "object") return [`${at}: the document has an object, the SDK ${shape.kind}`];
      const documented = Object.keys(resolved.properties).sort();
      const declared = Object.keys(shape.properties).sort();
      if (documented.join() !== declared.join()) {
        return [`${at}: properties ${JSON.stringify(declared)} instead of ${JSON.stringify(documented)}`];
      }
      const required = new Set(resolved.required ?? []);
      const differences: string[] = [];
      for (const name of documented) {
        if (required.has(name) === shape.optional.includes(name)) differences.push(`${at}.${name}: optionality`);
        differences.push(
          ...compare(shape.properties[name] ?? { kind: "json" }, resolved.properties[name] ?? {}, `${at}.${name}`),
        );
      }
      return differences;
    }
    default:
      return [`${at}: unsupported schema ${JSON.stringify(resolved)}`];
  }
}

describe("the SDK and the OpenAPI document", () => {
  const documented = documentedOperations();

  test("the SDK has one operation per documented operation, with the same method and path", () => {
    expect([...documented.keys()].sort()).toEqual(Object.keys(OPERATIONS).sort());
    for (const [id, operation] of Object.entries(OPERATIONS)) {
      expect<unknown>({ id, method: operation.method, path: operation.path }).toEqual({
        id,
        method: documented.get(id)?.method ?? "",
        path: documented.get(id)?.path ?? "",
      });
    }
  });

  test("the client has a method for every operation", () => {
    const client = createClient({ baseUrl: FIXTURE_ORIGIN, fetch: async () => new Response("{}") });
    for (const id of Object.keys(OPERATIONS)) expect(typeof client[id as keyof EquityOSClient]).toBe("function");
  });

  test("every success decoder has the shape of the documented response", () => {
    const differences: string[] = [];
    for (const [id, operation] of Object.entries(OPERATIONS)) {
      const schema = documented.get(id)?.responses["200"]?.content["application/json"].schema;
      if (schema === undefined) throw new Error(`${id} documents no 200 response`);
      if (operation.envelope) {
        const envelope = resolve(schema);
        differences.push(...compare(operation.data.shape, envelope.properties?.data ?? {}, `${id}.data`));
        differences.push(...compare(operation.meta.shape, envelope.properties?.meta ?? {}, `${id}.meta`));
      } else {
        differences.push(...compare(operation.body.shape, schema, id));
      }
    }
    expect(differences).toEqual([]);
  });

  test("the SDK knows every error code of the API", () => {
    expect([...SDK_ERROR_CODES].sort()).toEqual([...API_ERROR_CODES].sort());
  });

  test("the comparison detects a difference", () => {
    const shape: Shape = { kind: "object", properties: { eligible: { kind: "boolean" } }, optional: [] };
    expect(compare(shape, { $ref: "#/components/schemas/Eligibility" }, "Eligibility")).toEqual([
      'Eligibility: properties ["eligible"] instead of ["eligible","reasons"]',
    ]);
    expect(compare({ kind: "string" }, { $ref: "#/components/schemas/UintString" }, "amount")).toEqual([
      "amount: the document has an integer string, the SDK string",
    ]);
  });
});

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addKeyword("components");
ajv.addSchema({ $id: "openapi", components: { schemas } });

function validateDocumented(operationId: string, status: number, body: unknown): void {
  const schema = documentedOperations().get(operationId)?.responses[String(status)]?.content["application/json"].schema;
  if (schema === undefined) throw new Error(`${operationId} documents no ${status} response`);
  const validate = ajv.compile(
    JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"openapi#/components/')),
  );
  validate(body);
  expect(validate.errors ?? []).toEqual([]);
}

const committed: RecordedExamples = JSON.parse(readFileSync(EXAMPLES_FILE, "utf8"));

/** A client whose requests are answered by the fixture server, as a deployment would answer them. */
function fixtureClient(registry: FixtureRegistry = "recorded"): EquityOSClient {
  const serve = fixtureServer(registry);
  return createClient({ baseUrl: FIXTURE_ORIGIN, fetch: (url, init) => serve(new Request(url, init)) });
}

/** Calls the SDK method of an example with the arguments of its request path. */
function callFor(client: EquityOSClient, example: RecordedExample): Promise<unknown> {
  const url = new URL(example.path, FIXTURE_ORIGIN);
  const segments = url.pathname.split("/").slice(3);
  const query = Object.fromEntries(url.searchParams);
  const version = query.version === undefined ? {} : { version: Number(query.version) };
  const portfolio = { address: query.address ?? "", index: query.index ?? "", ...version };
  switch (example.operationId) {
    case "listAssets":
      return client.listAssets(query.eligible === undefined ? {} : { eligible: query.eligible === "true" });
    case "getAsset":
      return client.getAsset(segments[1] ?? "");
    case "listIndexes":
      return client.listIndexes(query.limit === undefined ? {} : { limit: Number(query.limit) });
    case "getIndex":
      return client.getIndex(segments[1] ?? "");
    case "getIndexVersion":
      return client.getIndexVersion(segments[1] ?? "", Number(segments[3]));
    case "getIndexComposition":
      return client.getIndexComposition(segments[1] ?? "", version);
    case "getPortfolio":
      return client.getPortfolio(portfolio);
    case "getPortfolioPlan":
      return client.getPortfolioPlan({
        ...portfolio,
        mode: query.mode ?? "",
        ...(query.depositUsdE8 === undefined ? {} : { depositUsdE8: BigInt(query.depositUsdE8) }),
      });
    case "executionPlan": {
      const body = example.requestBody ?? {};
      return client.executionPlan({
        address: String(body.address),
        index: String(body.index),
        mode: String(body.mode),
      });
    }
    case "getNetworkMetrics":
      return client.getNetworkMetrics();
    case "getStatus":
      return client.getStatus();
    default:
      throw new Error(`no SDK call for ${example.operationId}`);
  }
}

describe("the recorded examples", () => {
  test("are what the handlers produce now (regenerate with record:api-examples)", async () => {
    expect(committed).toEqual(await recordApiExamples());
  });

  test("cover every operation of the SDK except the OpenAPI document, and an error of each kind shown", () => {
    const covered = new Set(committed.examples.map(({ operationId }) => operationId));
    expect([...covered].sort()).toEqual(
      Object.keys(OPERATIONS)
        .filter((id) => id !== "getOpenApiDocument")
        .sort(),
    );
    expect(committed.examples.map(({ status }) => status)).toContain(409);
  });

  for (const example of committed.examples) {
    test(`${example.name}: validates against the document and decodes with the SDK`, async () => {
      validateDocumented(example.operationId, example.status, example.body);
      const result = callFor(fixtureClient(example.registry), example);
      if (example.status === 200) {
        await expect(result).resolves.toHaveProperty("data");
        return;
      }
      const error = await result.then(
        () => null,
        (rejection: unknown) => rejection,
      );
      expect(error).toBeInstanceOf(ApiError);
      const body = example.body as { error: { code: string } };
      expect(error).toMatchObject({ status: example.status, code: body.error.code });
      if (body.error.code === "registry_not_deployed") {
        expect(error).toBeInstanceOf(RegistryNotDeployedError);
        expect(error).toMatchObject({ chainId: 8453, reason: "not_configured" });
      }
    });
  }
});

describe("the client against the fixture server", () => {
  test("decodes amounts to bigint with their scale in the field name", async () => {
    const { data } = await fixtureClient().getAsset("0xB20000000000000000000078EE7CE2FE4908108C");
    expect(data.address).toBe("0xb20000000000000000000078ee7ce2fe4908108c");
    expect(data.referencePrice.priceE8).toBe(12982480034n);
    expect(typeof data.onchain.totalSupply).toBe("bigint");
  });

  test("iterates over every index across pages, in creation order", async () => {
    const indexes = [];
    for await (const index of fixtureClient().iterateIndexes({ limit: 2 })) indexes.push(index);
    expect(indexes.map(({ position }) => position)).toEqual([0, 1, 2, 3, 4]);
  });

  test("returns the OpenAPI document as served", async () => {
    const document = await fixtureClient().getOpenApiDocument();
    expect(document).toEqual(JSON.parse(JSON.stringify(openApiDocument)));
  });
});

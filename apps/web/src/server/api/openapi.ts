import "server-only";
import { API_ERROR_CODES, MARKET_ERROR_CODES } from "./errors";
import { API_VERSION, API_VERSION_HEADER } from "./http";

/** The subset of JSON Schema 2020-12 this document uses. */
export interface Schema {
  readonly $ref?: string;
  readonly type?: "string" | "integer" | "boolean" | "object" | "array" | "null";
  readonly description?: string;
  readonly enum?: readonly (string | null)[];
  readonly const?: string | number | boolean;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly items?: Schema;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
  readonly anyOf?: readonly Schema[];
}

interface Parameter {
  readonly name: string;
  readonly in: "query" | "path";
  readonly required: boolean;
  readonly description: string;
  readonly schema: Schema;
}

interface ResponseObject {
  readonly description: string;
  readonly headers?: Readonly<Record<string, { readonly $ref: string }>>;
  readonly content: { readonly "application/json": { readonly schema: Schema } };
}

interface Operation {
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly parameters?: readonly Parameter[];
  readonly responses: Readonly<Record<string, ResponseObject>>;
}

export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: { readonly title: string; readonly version: string; readonly description: string };
  readonly servers: readonly { readonly url: string; readonly description: string }[];
  readonly tags: readonly { readonly name: string; readonly description: string }[];
  readonly paths: Readonly<Record<string, { readonly get: Operation }>>;
  readonly components: {
    readonly headers: Readonly<Record<string, { readonly description: string; readonly schema: Schema }>>;
    readonly schemas: Readonly<Record<string, Schema>>;
  };
}

function ref(name: string): Schema {
  return { $ref: `#/components/schemas/${name}` };
}

function nullable(schema: Schema): Schema {
  return { anyOf: [schema, { type: "null" }] };
}

/** A closed object in which every property is required. An absent value is `null`, never a missing key. */
function object(properties: Record<string, Schema>, description?: string): Schema {
  return {
    type: "object",
    ...(description === undefined ? {} : { description }),
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function text(description: string): Schema {
  return { type: "string", description };
}

function oneOf(values: readonly string[], description: string): Schema {
  return { type: "string", enum: values, description };
}

const count: Schema = { type: "integer", minimum: 0 };
const bps: Schema = { type: "integer", minimum: 0, maximum: 10_000 };
const versionNumber: Schema = { type: "integer", minimum: 1, description: "Version number, from 1." };

/** A closed object of the published spec, where a property is present only when the author wrote it. */
function specObject(properties: Record<string, Schema>, optional: readonly string[] = []): Schema {
  const required = Object.keys(properties).filter((name) => !optional.includes(name));
  return { type: "object", properties, required, additionalProperties: false };
}

const HEADERS = {
  [API_VERSION_HEADER]: { $ref: `#/components/headers/${API_VERSION_HEADER}` },
  "Cache-Control": { $ref: "#/components/headers/Cache-Control" },
} as const;

function json(description: string, schema: Schema): ResponseObject {
  return { description, headers: HEADERS, content: { "application/json": { schema } } };
}

function success(description: string, data: Schema, meta: Schema): ResponseObject {
  return json(description, object({ data, meta }));
}

const invalidRequest = json("A parameter is unknown, repeated or malformed.", ref("Error"));
const registryNotDeployed =
  "The request is valid and the state of the service does not allow an answer. registry_not_deployed: the index registry has no code on the configured chain, which is a normal state and not an empty registry.";
const identifierParameter: Parameter = {
  name: "identifier",
  in: "path",
  required: true,
  description:
    "The canonical identifier of the index (its slug, a hyphen and a prefix of its index id), or its 32-byte index id in any letter case.",
  schema: { type: "string" },
};
const failures = {
  "500": json("The server is not configured to read its data sources, or failed unexpectedly.", ref("Error")),
  "502": json("A data source answered with a payload that does not have the expected shape.", ref("Error")),
  "503": json("A data source did not answer and no recent copy is cached. Carries Retry-After.", ref("Error")),
} as const;

const INELIGIBILITY_CODES = [
  "not_listed",
  "onchain_read_failed",
  "not_initialized",
  "decimals_mismatch",
  "not_minted",
  "missing_feed",
  "feed_mismatch",
] as const;

const datasetProperties = {
  source: oneOf(["coinbase_api", "base_rpc"], "Identifier of the source the dataset is read from."),
  fetchedAt: ref("Timestamp"),
  ageSeconds: { ...count, description: "Whole seconds between fetchedAt and the response." },
  servedStale: {
    type: "boolean",
    description: "True when the source could not be reached and the last copy is served past its TTL.",
  },
  failure: nullable(
    oneOf([...MARKET_ERROR_CODES, "unknown"], "Why the source could not be reached. Null when the dataset is fresh."),
  ),
} as const satisfies Record<string, Schema>;

const snapshotMetaProperties = {
  asOf: ref("Timestamp"),
  marketPhase: ref("MarketPhase"),
  referencePriceSource: { type: "string", const: "chainlink" },
  datasets: ref("Datasets"),
} as const satisfies Record<string, Schema>;

const indexProperties = {
  indexId: ref("Bytes32"),
  identifier: text(
    "Canonical identifier: slug and index id prefix, or the index id while the latest version is not conformant.",
  ),
  position: { ...count, description: "Position in creation order. It never changes." },
  creator: ref("Address"),
  createdAt: ref("Timestamp"),
  latestVersion: versionNumber,
  deprecated: { type: "boolean", description: "Whether the creator deprecated the index. It is one-way." },
  deprecatedAt: nullable(ref("Timestamp")),
  latest: ref("VersionSummary"),
} as const satisfies Record<string, Schema>;

const schemas: Record<string, Schema> = {
  Address: {
    type: "string",
    pattern: "^0x[0-9a-f]{40}$",
    description: "A 20-byte address, lowercase.",
  },
  Timestamp: {
    type: "string",
    pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$",
    description: "ISO 8601 instant in UTC with second precision.",
  },
  UintString: {
    type: "string",
    pattern: "^(0|[1-9]\\d*)$",
    description: "A non-negative integer as a decimal string. Its unit and scale are given by the field.",
  },
  MarketPhase: oneOf(
    ["regular", "extended", "closed", "unknown"],
    "Phase of the US equity market. extended covers the pre-market, post-market and overnight sessions. unknown means the market calendar does not cover the instant.",
  ),
  Dataset: object(datasetProperties, "One cached dataset behind a response, and how current it is."),
  OnchainDataset: object(
    {
      ...datasetProperties,
      blockNumber: ref("UintString"),
      blockTimestamp: ref("Timestamp"),
    },
    "The onchain read. Every token state and feed round of a response belongs to this one block.",
  ),
  Datasets: object({ assetList: ref("Dataset"), onchain: ref("OnchainDataset") }),
  SnapshotMeta: object(snapshotMetaProperties, "What a response was built from and when."),
  AssetListMeta: object({
    ...snapshotMetaProperties,
    count: { ...count, description: "Number of assets in data." },
    total: { ...count, description: "Number of listed assets before filtering." },
  }),
  PricePoint: object({
    priceE8: { ...ref("UintString"), description: "USD per whole token, scaled by 1e8." },
    updatedAt: ref("Timestamp"),
    roundId: ref("UintString"),
  }),
  TokenState: object(
    {
      status: oneOf(
        ["ok", "not_initialized", "read_failed"],
        "Outcome of reading the token. Every other field is null unless it is ok.",
      ),
      decimals: nullable({ ...count, description: "Decimals the token reports onchain." }),
      totalSupply: nullable({ ...ref("UintString"), description: "Minted supply in token base units." }),
      multiplierWad: nullable({
        ...ref("UintString"),
        description:
          "Shares of the underlying stock per token, scaled by 1e18. Already included in the reference price: never apply it to priceE8.",
      }),
      pendingMultiplier: nullable(
        object(
          { multiplierWad: ref("UintString"), effectiveAt: ref("Timestamp") },
          "A recorded multiplier update that is not yet in effect.",
        ),
      ),
      transfersPaused: nullable({ type: "boolean", description: "Whether the issuer paused transfers." }),
    },
    "Token state read from the chain at meta.datasets.onchain.blockNumber.",
  ),
  Eligibility: object({
    eligible: { type: "boolean", description: "Whether the token may be a constituent of an index." },
    reasons: {
      type: "array",
      items: oneOf(INELIGIBILITY_CODES, "A condition of eligibility the token fails."),
      description: "Every failed condition. Empty when eligible.",
    },
  }),
  ReferencePrice: object(
    {
      status: oneOf(
        ["live", "delayed", "last_close", "unavailable"],
        "Staleness class. live: published at most 30 minutes ago in an open session. delayed: older, within the feed heartbeat. last_close: the value held since trading last stopped. unavailable: no usable value.",
      ),
      priceE8: nullable({ ...ref("UintString"), description: "USD per whole token, scaled by 1e8." }),
      updatedAt: nullable({ ...ref("Timestamp"), description: "Time the feed published the round." }),
      roundId: nullable(ref("UintString")),
      unavailableReason: nullable(
        oneOf(
          ["not_eligible", "feed_read_failed", "feed_mismatch", "invalid_round", "stale_feed"],
          "Why there is no usable value. Null unless status is unavailable.",
        ),
      ),
      lastObserved: nullable({
        ...ref("PricePoint"),
        description: "The round of a feed that missed its heartbeat. For display with its age only.",
      }),
      feedProxy: nullable({ ...ref("Address"), description: "Feed proxy mapped to the token." }),
    },
    "An indication of value from an oracle feed. It is not an executable price: no trade is guaranteed at it. priceE8, updatedAt and roundId are null exactly when status is unavailable.",
  ),
  Asset: object({
    address: ref("Address"),
    symbol: text("Display symbol. Mutable onchain: never use it as a key."),
    name: text("Display name."),
    decimals: { ...count, description: "Decimals as listed by the issuer." },
    isin: nullable(text("ISIN of the token as listed by the issuer.")),
    onchain: ref("TokenState"),
    eligibility: ref("Eligibility"),
    referencePrice: ref("ReferencePrice"),
  }),
  Bytes32: {
    type: "string",
    pattern: "^0x[0-9a-f]{64}$",
    description: "32 bytes as lowercase hexadecimal: an index id or a spec hash.",
  },
  RegistryRef: object(
    {
      chainId: { type: "integer", description: "EIP-155 id of the chain the registry is read from." },
      address: ref("Address"),
      mode: oneOf(["live", "replay"], "replay means a recording of a development chain is served, for testing."),
    },
    "The index registry a response was read from.",
  ),
  RegistryMeta: object({ asOf: ref("Timestamp"), registry: ref("RegistryRef") }),
  IndexListMeta: object({
    asOf: ref("Timestamp"),
    registry: ref("RegistryRef"),
    total: { ...count, description: "Number of indexes in the registry." },
    offset: { ...count, description: "Position of the first index of the page." },
    limit: { ...count, description: "Maximum number of indexes in a page." },
    count: { ...count, description: "Number of indexes in data." },
    nextOffset: nullable({ ...count, description: "Offset of the next page. Null on the last page." }),
  }),
  CompositionMeta: object({ ...snapshotMetaProperties, registry: ref("RegistryRef") }),
  VerificationSummary: object({
    conformant: { type: "boolean", description: "True only if checks C1 to C5 all pass." },
    failedCheck: nullable(
      object({ id: ref("CheckId"), code: text("Stable code of the failure.") }, "The check that failed."),
    ),
  }),
  CheckId: oneOf(["C1", "C2", "C3", "C4", "C5"], "A conformance check of the methodology spec."),
  VersionSummary: object(
    {
      version: versionNumber,
      name: nullable(text("Name from the spec. Null unless the version is conformant.")),
      slug: nullable(text("Slug from the spec. Null unless the version is conformant.")),
      weighting: nullable(oneOf(["equal", "fixed"], "Weighting of the spec. Null unless the version is conformant.")),
      composition: ref("Composition"),
      constituentCount: { ...count, description: "Number of constituents the registry stores for the version." },
      specHash: ref("Bytes32"),
      publishedAt: ref("Timestamp"),
      publishedBlock: ref("UintString"),
      verification: ref("VerificationSummary"),
    },
    "A version as listed. Nothing is taken from a spec that fails verification.",
  ),
  Composition: oneOf(
    ["rule_based", "dynamic_weights", "static"],
    "How much of the version the registry mirrors in contract state. static: tokens and weights.",
  ),
  IndexSummary: object(indexProperties),
  Index: object({
    ...indexProperties,
    versions: {
      type: "array",
      description: "The most recent versions, newest first, at most 50. latestVersion says how many exist.",
      items: object({
        version: versionNumber,
        publishedAt: ref("Timestamp"),
        publishedBlock: ref("UintString"),
        specHash: ref("Bytes32"),
        conformant: { type: "boolean" },
      }),
    },
  }),
  Constituent: object({
    token: ref("Address"),
    weightBps: { ...bps, description: "Stored weight in basis points." },
  }),
  Check: object({
    id: ref("CheckId"),
    title: text("What the check establishes."),
    status: oneOf(["pass", "fail", "skipped"], "skipped means an earlier check failed. It is never a success."),
    code: text("Stable code of the outcome. ok for a pass."),
    reason: text("Why the check has this status. Not stable."),
  }),
  IndexSpec: {
    ...specObject(
      {
        schema: { type: "string", const: "equityos.index/1" },
        calc: { type: "string", const: "equityos.calc/1" },
        chainId: { type: "integer", minimum: 1 },
        name: { type: "string" },
        slug: { type: "string" },
        description: { type: "string" },
        universe: specObject({
          type: { type: "string", const: "static" },
          tokens: { type: "array", items: ref("Address") },
        }),
        weighting: specObject(
          { type: { type: "string", enum: ["equal", "fixed"] }, weightsBps: { type: "array", items: bps } },
          ["weightsBps"],
        ),
        constraints: specObject({ maxWeightBps: bps, minWeightBps: bps }, ["maxWeightBps", "minWeightBps"]),
        pricing: specObject({
          source: { type: "string", const: "chainlink-aggregator-v3" },
          feeds: { type: "array", items: ref("Address") },
        }),
        rebalance: specObject({
          trigger: { type: "string", const: "drift" },
          driftThresholdBps: bps,
          minIntervalSeconds: count,
        }),
        parent: specObject({
          chainId: { type: "integer", minimum: 1 },
          registry: ref("Address"),
          indexId: ref("Bytes32"),
          version: versionNumber,
          specHash: ref("Bytes32"),
        }),
      },
      ["constraints", "parent"],
    ),
    description:
      "The published methodology spec equityos.index/1, as its author wrote it. Optional properties are absent, not null.",
  },
  IndexVersion: object({
    indexId: ref("Bytes32"),
    identifier: text("Canonical identifier of the index."),
    version: versionNumber,
    latestVersion: versionNumber,
    isLatest: { type: "boolean" },
    creator: ref("Address"),
    chainId: { type: "integer" },
    registry: ref("Address"),
    specHash: { ...ref("Bytes32"), description: "keccak256 of the spec bytes, computed by the registry." },
    publishedAt: ref("Timestamp"),
    publishedBlock: ref("UintString"),
    composition: ref("Composition"),
    specSize: { ...count, description: "Length of the stored spec in bytes." },
    specBytes: { type: "string", pattern: "^0x([0-9a-f]{2})*$", description: "The stored spec, byte for byte." },
    specText: nullable(text("The stored spec as text. Null when the bytes are not well-formed UTF-8.")),
    spec: nullable({ ...ref("IndexSpec"), description: "The parsed spec. Null unless the version is conformant." }),
    constituents: {
      type: "array",
      items: ref("Constituent"),
      description: "The constituents the registry stores, in its order. Verified against the spec by check C5.",
    },
    verification: object({
      conformant: { type: "boolean" },
      checks: { type: "array", items: ref("Check"), description: "C1 to C5, in order." },
      specErrors: {
        type: "array",
        description: "Every schema violation found by C4.",
        items: object({ path: text("JSON Pointer of the value."), code: text("Stable code."), message: text("Text.") }),
      },
    }),
  }),
  IndexComposition: object({
    indexId: ref("Bytes32"),
    identifier: text("Canonical identifier of the index."),
    version: versionNumber,
    isLatest: { type: "boolean" },
    constituents: {
      type: "array",
      items: object({
        token: ref("Address"),
        symbol: nullable(text("Display symbol. Null when the asset list does not hold the token.")),
        name: nullable(text("Display name. Null when the asset list does not hold the token.")),
        targetWeightBps: { ...bps, description: "Target weight as published, in basis points." },
        eligibility: {
          ...ref("Eligibility"),
          description: "Index eligibility of the token now. It can change after a version is published.",
        },
        transfersPaused: nullable({ type: "boolean", description: "Whether the issuer paused transfers now." }),
        referencePrice: ref("ReferencePrice"),
      }),
    },
  }),
  RegistryStatus: object(
    {
      chainId: { type: "integer" },
      address: ref("Address"),
      mode: oneOf(["live", "replay"], "replay means a recording of a development chain is served, for testing."),
      deployed: nullable({ type: "boolean", description: "Whether the registry has code. Null when unknown." }),
      notDeployedReason: nullable(
        oneOf(
          ["not_configured", "no_code"],
          "not_configured: no deployment is recorded for the chain. no_code: the address holds no code.",
        ),
      ),
      indexCount: nullable({ ...count, description: "Number of indexes. Null unless the registry is deployed." }),
      error: nullable(
        object({
          code: oneOf(API_ERROR_CODES, "Why the registry could not be read."),
          details: ref("ErrorDetails"),
        }),
      ),
    },
    "The index registry on the configured chain. A registry that is not deployed is a normal state.",
  ),
  Status: object({
    apiVersion: text("Version of the API contract."),
    chainId: { type: "integer", const: 8453, description: "Chain the market data is read from: Base mainnet." },
    marketPhase: ref("MarketPhase"),
    executionAvailable: {
      type: "boolean",
      description: "Whether trade execution is available to this request. Always false in this release.",
    },
    executionUnavailableReason: nullable(
      oneOf(
        ["restricted_jurisdiction", "jurisdiction_unknown", "not_released"],
        "restricted_jurisdiction: the request is located in the United States. jurisdiction_unknown: its location could not be established. not_released: no execution endpoint exists in this release.",
      ),
    ),
    marketData: object({
      mode: oneOf(["live", "replay"], "replay means a recorded block is served instead of current data."),
      available: { type: "boolean", description: "Whether the market data could be loaded." },
      referencePriceSource: { type: "string", const: "chainlink" },
      datasets: nullable(ref("Datasets")),
      error: nullable(
        object({
          code: oneOf(API_ERROR_CODES, "Why the market data could not be loaded."),
          details: ref("ErrorDetails"),
        }),
      ),
    }),
    registry: ref("RegistryStatus"),
  }),
  ErrorDetails: nullable({
    type: "object",
    description: "Machine-readable context of an error, such as the offending parameter or the failing source.",
  }),
  Error: object({
    error: object({
      code: oneOf(API_ERROR_CODES, "Stable identifier of the error. Branch on it, never on the message."),
      message: text("Explanation for a developer. Not stable."),
      details: ref("ErrorDetails"),
    }),
  }),
};

/**
 * OpenAPI 3.1 description of the public API. It is the contract: `test/api/openapi.test.ts` fails when a route
 * under `src/app/api/v1` is missing from `paths`, and when the output of a handler does not validate against
 * the schema of its response. A new endpoint adds its path here and its schemas to `schemas`.
 */
export const openApiDocument: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "EquityOS API",
    version: API_VERSION,
    description:
      "Public, keyless, read-only API. Amounts and prices are integers in decimal strings with the scale in the field name. Timestamps are ISO 8601 in UTC. Addresses are lowercase.",
  },
  servers: [{ url: "/api/v1", description: "This deployment" }],
  tags: [
    { name: "Assets", description: "Tokenized stocks listed on Base mainnet." },
    { name: "Indexes", description: "Published index methodologies, their versions and their verification." },
    { name: "Meta", description: "The API itself." },
  ],
  paths: {
    "/assets": {
      get: {
        operationId: "listAssets",
        summary: "List the asset universe",
        description:
          "Every tokenized stock in the issuer's list with its onchain state, index eligibility and reference price, all read at one block. Ordered by symbol, then address. Not paginated.",
        tags: ["Assets"],
        parameters: [
          {
            name: "eligible",
            in: "query",
            required: false,
            description: "true returns only index-eligible assets, false only the others.",
            schema: { type: "string", enum: ["true", "false"] },
          },
        ],
        responses: {
          "200": success("The assets.", { type: "array", items: ref("Asset") }, ref("AssetListMeta")),
          "400": invalidRequest,
          ...failures,
        },
      },
    },
    "/assets/{address}": {
      get: {
        operationId: "getAsset",
        summary: "Get one asset",
        description: "One listed asset by token address. The address is accepted in any letter case.",
        tags: ["Assets"],
        parameters: [
          {
            name: "address",
            in: "path",
            required: true,
            description: "Token address on Base mainnet.",
            schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
          },
        ],
        responses: {
          "200": success("The asset.", ref("Asset"), ref("SnapshotMeta")),
          "400": invalidRequest,
          "404": json("No listed asset has this token address.", ref("Error")),
          ...failures,
        },
      },
    },
    "/indexes": {
      get: {
        operationId: "listIndexes",
        summary: "List the published indexes",
        description:
          "A page of indexes in creation order, each with a summary of its latest version. Pagination is by position: the registry is append-only and a position never changes, so an offset is a stable cursor. An index whose latest version fails verification is listed with its state and without a name.",
        tags: ["Indexes"],
        parameters: [
          {
            name: "offset",
            in: "query",
            required: false,
            description: "Position of the first index to return. Defaults to 0.",
            schema: { type: "integer", minimum: 0 },
          },
          {
            name: "limit",
            in: "query",
            required: false,
            description: "Maximum number of indexes to return, 1 to 50. Defaults to 20.",
            schema: { type: "integer", minimum: 1, maximum: 50 },
          },
        ],
        responses: {
          "200": success("The indexes.", { type: "array", items: ref("IndexSummary") }, ref("IndexListMeta")),
          "400": invalidRequest,
          "409": json(registryNotDeployed, ref("Error")),
          ...failures,
        },
      },
    },
    "/indexes/{identifier}": {
      get: {
        operationId: "getIndex",
        summary: "Get one index",
        description: "One index with its most recent versions, newest first.",
        tags: ["Indexes"],
        parameters: [identifierParameter],
        responses: {
          "200": success("The index.", ref("Index"), ref("RegistryMeta")),
          "400": invalidRequest,
          "404": json("The registry holds no index with this identifier.", ref("Error")),
          "409": json(registryNotDeployed, ref("Error")),
          ...failures,
        },
      },
    },
    "/indexes/{identifier}/versions/{version}": {
      get: {
        operationId: "getIndexVersion",
        summary: "Get one version of an index",
        description:
          "Everything the registry stores for one version: the onchain facts, the spec bytes as hex and as text, the stored constituents and the report of checks C1 to C5. The parsed spec is present only when every check passes.",
        tags: ["Indexes"],
        parameters: [
          identifierParameter,
          {
            name: "version",
            in: "path",
            required: true,
            description: "Version number, from 1.",
            schema: { type: "string", pattern: "^[1-9][0-9]{0,9}$" },
          },
        ],
        responses: {
          "200": success("The version.", ref("IndexVersion"), ref("RegistryMeta")),
          "400": invalidRequest,
          "404": json("No index has this identifier, or the index has no version with this number.", ref("Error")),
          "409": json(registryNotDeployed, ref("Error")),
          ...failures,
        },
      },
    },
    "/indexes/{identifier}/composition": {
      get: {
        operationId: "getIndexComposition",
        summary: "Get the composition of an index",
        description:
          "The constituents of a verified version with their target weights, joined with the asset universe as it is now: symbol, name, reference price with its staleness class, and whether the token is still index-eligible. Eligibility is a current status and can differ from the day of publication. A reference price is not an executable price.",
        tags: ["Indexes"],
        parameters: [
          identifierParameter,
          {
            name: "version",
            in: "query",
            required: false,
            description: "Version number. Defaults to the latest version.",
            schema: { type: "string", pattern: "^[1-9][0-9]{0,9}$" },
          },
        ],
        responses: {
          "200": success("The composition.", ref("IndexComposition"), ref("CompositionMeta")),
          "400": invalidRequest,
          "404": json("No index has this identifier, or the index has no version with this number.", ref("Error")),
          "409": json(
            `${registryNotDeployed} version_not_conformant: the version fails verification, so no composition is computed from it.`,
            ref("Error"),
          ),
          ...failures,
        },
      },
    },
    "/status": {
      get: {
        operationId: "getStatus",
        summary: "API and data status",
        description:
          "Version, chain, market phase, execution availability, the age of each cached dataset and whether the index registry is deployed on the configured chain. Answers 200 when a data source is down and reports the failure in marketData.error or registry.error.",
        tags: ["Meta"],
        responses: {
          "200": success("The status.", ref("Status"), object({ asOf: ref("Timestamp") })),
          "400": invalidRequest,
          "500": failures["500"],
        },
      },
    },
    "/openapi.json": {
      get: {
        operationId: "getOpenApiDocument",
        summary: "This document",
        description: "The OpenAPI 3.1 description of the API, as served by this deployment.",
        tags: ["Meta"],
        responses: {
          "200": json("The OpenAPI document.", { type: "object" }),
        },
      },
    },
  },
  components: {
    headers: {
      [API_VERSION_HEADER]: {
        description: "Version of the API contract that produced the response.",
        schema: { type: "string" },
      },
      "Cache-Control": {
        description: "How long the response stays current. Errors and the status are never stored.",
        schema: { type: "string" },
      },
    },
    schemas,
  },
};

import { DecodeFailure, type Decoder, type Infer, type OpenEnum, object } from "./decode.ts";
import { ApiError, RegistryNotDeployedError, ResponseShapeError, TransportError } from "./errors.ts";
import { type Fetch, type FetchResponse, globalFetch } from "./fetch.ts";
import { type EnvelopeOperation, OPERATIONS } from "./operations.ts";
import { errorBody, type IndexSummary } from "./schemas.ts";

type Ops = typeof OPERATIONS;
type EnvelopeOperationId = { [K in keyof Ops]: Ops[K]["envelope"] extends true ? K : never }[keyof Ops];

/** A success response of the API: the resource in `data`, and in `meta` what it was built from and when. */
export interface ApiResponse<Data, Meta> {
  readonly data: Data;
  readonly meta: Meta;
}

/** The decoded success response of an operation. */
export type ResponseOf<K extends EnvelopeOperationId> = ApiResponse<Infer<Ops[K]["data"]>, Infer<Ops[K]["meta"]>>;

export interface ClientOptions {
  /** Origin of an EquityOS deployment, such as `https://equityos.example`. `/api/v1` is appended. */
  readonly baseUrl: string;
  /** A Fetch API implementation. Defaults to the global `fetch`. */
  readonly fetch?: Fetch;
  /** Headers sent with every request, for example to identify the caller to a proxy. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface PortfolioQuery {
  /** Any address on Base mainnet, in any letter case. */
  readonly address: string;
  /** Index identifier (`<slug>-<prefix>`) or 32-byte index id. */
  readonly index: string;
  /** Version number. The latest version when absent. */
  readonly version?: number;
}

export interface PortfolioPlanQuery extends PortfolioQuery {
  /** `rebalance` sells and buys. `buy_only` never sells. */
  readonly mode: OpenEnum<"rebalance" | "buy_only">;
  /** USDC to add before the plan, in USD scaled by 1e8. 0 when absent. */
  readonly depositUsdE8?: bigint;
  /** Share of the funds the buys leave unspent, in basis points, 0 to 2000. 50 when absent. */
  readonly reserveBps?: number;
  /** Reference value below which a leg is not proposed, in USD scaled by 1e8. 1.00 USD when absent. */
  readonly minLegValueUsdE8?: bigint;
}

/** The body of `POST /portfolio/execution-plan`. Absent fields take the defaults of the API. */
export interface ExecutionPlanRequest {
  /** The account on Base mainnet that would send and receive every swap, in any letter case. */
  readonly address: string;
  /** Index identifier (`<slug>-<prefix>`) or 32-byte index id. */
  readonly index: string;
  /** Version number. The latest version when absent. */
  readonly version?: number;
  /** `rebalance` sells and buys. `buy_only` never sells. */
  readonly mode: OpenEnum<"rebalance" | "buy_only">;
  /** Share of the funds the buys leave unspent, in basis points, 0 to 2000. 50 when absent. */
  readonly reserveBps?: number;
  /** Reference value below which a leg is not proposed, in USD scaled by 1e8. 1.00 USD when absent. */
  readonly minLegValueUsdE8?: bigint;
  /** Slippage tolerance of each swap, in basis points, 0 to 200. 50 when absent. */
  readonly slippageBps?: number;
  /** Largest deviation of the quoted and minimum prices from the reference, in basis points, 0 to 500. */
  readonly maxDeviationBps?: number;
  /** Accept calls that could not be simulated as a sequence. `false` when absent. */
  readonly allowUnsimulated?: boolean;
}

/**
 * A typed client of the public API v1 of one deployment. Every method makes one request, decodes the
 * response and returns `{ data, meta }`, or throws:
 *
 * - `ApiError` with the stable `code` of the API (`RegistryNotDeployedError` for `registry_not_deployed`).
 * - `TransportError` when the request did not complete.
 * - `ResponseShapeError` when the response is not what the API documents.
 */
export interface EquityOSClient {
  /** The API root every path is appended to: `<baseUrl>/api/v1`. */
  readonly apiUrl: string;
  /** `GET /assets`: every listed asset, or only the index-eligible ones (`true`) or only the others (`false`). */
  listAssets(query?: { readonly eligible?: boolean }): Promise<ResponseOf<"listAssets">>;
  /** `GET /assets/{address}`: one listed asset by token address. */
  getAsset(address: string): Promise<ResponseOf<"getAsset">>;
  /** `GET /indexes`: one page of indexes in creation order. */
  listIndexes(query?: { readonly offset?: number; readonly limit?: number }): Promise<ResponseOf<"listIndexes">>;
  /**
   * Every index from `offset` on, in creation order, requesting pages of `limit` and following
   * `meta.nextOffset`. Positions never change, so a page never repeats or skips an index while new ones are
   * created.
   */
  iterateIndexes(query?: { readonly offset?: number; readonly limit?: number }): AsyncGenerator<IndexSummary, void>;
  /** `GET /indexes/{identifier}`: one index with its most recent versions. */
  getIndex(identifier: string): Promise<ResponseOf<"getIndex">>;
  /** `GET /indexes/{identifier}/versions/{version}`: one version, its stored bytes and its verification report. */
  getIndexVersion(identifier: string, version: number): Promise<ResponseOf<"getIndexVersion">>;
  /** `GET /indexes/{identifier}/composition`: the constituents of a verified version with their current state. */
  getIndexComposition(
    identifier: string,
    query?: { readonly version?: number },
  ): Promise<ResponseOf<"getIndexComposition">>;
  /** `GET /portfolio`: the holdings of an address compared with a published version. */
  getPortfolio(query: PortfolioQuery): Promise<ResponseOf<"getPortfolio">>;
  /** `GET /portfolio/plan`: arithmetic toward the target weights at reference prices. Not an executable quote. */
  getPortfolioPlan(query: PortfolioPlanQuery): Promise<ResponseOf<"getPortfolioPlan">>;
  /**
   * `POST /portfolio/execution-plan`: the reference-price plan quoted and checked for execution on Base mainnet.
   * Either `blocked` with the checks that fail, or `ready` with the calls and `planHash`. Nothing is signed or
   * sent. A client that sends the calls must verify them and refuse to send after `expiresAt`.
   */
  executionPlan(request: ExecutionPlanRequest): Promise<ResponseOf<"executionPlan">>;
  /**
   * `GET /network`: registry and usage metrics computed from chain events only, each with its definition id,
   * chain, block range and computation time, with the classified attestations and the excluded accounts.
   */
  getNetworkMetrics(): Promise<ResponseOf<"getNetworkMetrics">>;
  /** `GET /status`: the API version, the age of each dataset and whether the registry is deployed. */
  getStatus(): Promise<ResponseOf<"getStatus">>;
  /** `GET /openapi.json`: the OpenAPI 3.1 document of the deployment, as it is served. */
  getOpenApiDocument(): Promise<Readonly<Record<string, unknown>>>;
}

type Query = Readonly<Record<string, string | number | bigint | boolean | undefined>>;

/** An absolute http or https URL without query or fragment. A trailing slash is removed. */
function normalizeBaseUrl(baseUrl: string): string {
  if (!/^https?:\/\/[^/?#\s]+(\/[^?#\s]*)?$/i.test(baseUrl)) {
    throw new TypeError(`baseUrl must be an absolute http or https URL without query: ${JSON.stringify(baseUrl)}`);
  }
  return baseUrl.replace(/\/+$/, "");
}

/** Fills `{name}` placeholders with URL-encoded values. */
function fillPath(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new TypeError(`missing path parameter ${name}`);
    return encodeURIComponent(String(value));
  });
}

function queryString(query: Query): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

function parseJson(status: number, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ResponseShapeError(status, "", `The response (status ${status}) is not JSON.`);
  }
}

function decodeBody<T>(decoder: Decoder<T>, status: number, value: unknown): T {
  try {
    return decoder.decode(value, "");
  } catch (error) {
    if (error instanceof DecodeFailure) {
      throw new ResponseShapeError(
        status,
        error.path,
        `The response (status ${status}) is not documented: ${error.message}`,
      );
    }
    throw error;
  }
}

function retryAfter(response: FetchResponse): number | null {
  const value = response.headers.get("retry-after");
  return value !== null && /^[0-9]+$/.test(value) ? Number(value) : null;
}

function toApiError(response: FetchResponse, body: unknown): ApiError {
  const { error } = decodeBody(errorBody, response.status, body);
  const init = {
    status: response.status,
    code: error.code,
    message: error.message,
    details: error.details,
    retryAfterSeconds: retryAfter(response),
  };
  return error.code === "registry_not_deployed" ? new RegistryNotDeployedError(init) : new ApiError(init);
}

/**
 * Creates a client of the public API v1 of the deployment at `baseUrl`. The API is keyless and read-only, so no
 * credential is needed.
 *
 * ```ts
 * const client = createClient({ baseUrl: "https://equityos.example" });
 * const { data } = await client.getIndexComposition("diversified-equity-d622e2a5");
 * ```
 */
export function createClient(options: ClientOptions): EquityOSClient {
  const apiUrl = `${normalizeBaseUrl(options.baseUrl)}/api/v1`;
  const fetch = options.fetch ?? globalFetch();
  const headers = { Accept: "application/json", ...options.headers };

  async function send(
    path: string,
    json?: string,
  ): Promise<{ readonly response: FetchResponse; readonly body: unknown }> {
    const url = `${apiUrl}${path}`;
    let response: FetchResponse;
    let text: string;
    const init =
      json === undefined
        ? { method: "GET" as const, headers }
        : { method: "POST" as const, headers: { ...headers, "Content-Type": "application/json" }, body: json };
    try {
      response = await fetch(url, init);
      text = await response.text();
    } catch (error) {
      throw new TransportError(url, error);
    }
    const body = parseJson(response.status, text);
    if (response.status < 200 || response.status > 299) throw toApiError(response, body);
    return { response, body };
  }

  async function call<K extends EnvelopeOperationId>(
    id: K,
    params: Readonly<Record<string, string | number>>,
    query: Query,
    json?: string,
  ): Promise<ResponseOf<K>> {
    const operation: EnvelopeOperation = OPERATIONS[id];
    const { response, body } = await send(`${fillPath(operation.path, params)}${queryString(query)}`, json);
    const envelope = object({ data: operation.data, meta: operation.meta });
    // The decoders of `OPERATIONS[id]` produce exactly `ResponseOf<K>`: the type is derived from them.
    return decodeBody(envelope, response.status, body) as ResponseOf<K>;
  }

  const client: EquityOSClient = {
    apiUrl,
    listAssets: (query = {}) => call("listAssets", {}, { eligible: query.eligible }),
    getAsset: (address) => call("getAsset", { address }, {}),
    listIndexes: (query = {}) => call("listIndexes", {}, { offset: query.offset, limit: query.limit }),
    async *iterateIndexes(query = {}) {
      let offset: number | null = query.offset ?? 0;
      while (offset !== null) {
        const page: ResponseOf<"listIndexes"> = await client.listIndexes({
          offset,
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        });
        yield* page.data;
        offset = page.meta.nextOffset;
      }
    },
    getIndex: (identifier) => call("getIndex", { identifier }, {}),
    getIndexVersion: (identifier, version) => call("getIndexVersion", { identifier, version }, {}),
    getIndexComposition: (identifier, query = {}) =>
      call("getIndexComposition", { identifier }, { version: query.version }),
    getPortfolio: ({ address, index, version }) => call("getPortfolio", {}, { address, index, version }),
    getPortfolioPlan: (query) =>
      call(
        "getPortfolioPlan",
        {},
        {
          address: query.address,
          index: query.index,
          version: query.version,
          mode: query.mode,
          depositUsdE8: query.depositUsdE8,
          reserveBps: query.reserveBps,
          minLegValueUsdE8: query.minLegValueUsdE8,
        },
      ),
    executionPlan: (request) =>
      call(
        "executionPlan",
        {},
        {},
        JSON.stringify({
          ...request,
          ...(request.minLegValueUsdE8 === undefined ? {} : { minLegValueUsdE8: request.minLegValueUsdE8.toString() }),
        }),
      ),
    getNetworkMetrics: () => call("getNetworkMetrics", {}, {}),
    getStatus: () => call("getStatus", {}, {}),
    async getOpenApiDocument() {
      const { response, body } = await send(OPERATIONS.getOpenApiDocument.path);
      return decodeBody(OPERATIONS.getOpenApiDocument.body, response.status, body);
    },
  };
  return client;
}

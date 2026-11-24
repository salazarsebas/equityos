import type { OpenEnum } from "./decode.ts";
import type { ApiErrorCode } from "./schemas.ts";

/** Base class of every error this package throws, apart from a `TypeError` for an invalid argument. */
export class EquityOSError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "EquityOSError";
  }
}

/**
 * The API answered with its error envelope. `code` is stable: branch on it, never on `message`. A code added in a
 * later minor version of the API arrives as is.
 */
export class ApiError extends EquityOSError {
  readonly status: number;
  readonly code: OpenEnum<ApiErrorCode>;
  /** Machine-readable context, such as the offending parameter or the failing source. */
  readonly details: Readonly<Record<string, unknown>> | null;
  /** Seconds to wait before retrying, from `Retry-After`. Set on `upstream_unavailable` (503). */
  readonly retryAfterSeconds: number | null;

  constructor(init: {
    readonly status: number;
    readonly code: OpenEnum<ApiErrorCode>;
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>> | null;
    readonly retryAfterSeconds: number | null;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/**
 * `registry_not_deployed` (409): the index registry has no code on the chain the deployment reads. This is a
 * normal state of a deployment, not a failure and not an empty registry: retrying does not change it.
 */
export class RegistryNotDeployedError extends ApiError {
  /** Chain the deployment reads the registry from. `null` if the API did not state it. */
  readonly chainId: number | null;
  /** Address the registry would have on that chain. `null` if the API did not state it. */
  readonly registry: string | null;
  /** `not_configured`: no deployment is recorded for the chain. `no_code`: the address holds no code. */
  readonly reason: OpenEnum<"not_configured" | "no_code"> | null;

  constructor(init: ConstructorParameters<typeof ApiError>[0]) {
    super(init);
    this.name = "RegistryNotDeployedError";
    const { details } = init;
    this.chainId = typeof details?.chainId === "number" ? details.chainId : null;
    this.registry = typeof details?.registry === "string" ? details.registry : null;
    this.reason = typeof details?.reason === "string" ? details.reason : null;
  }
}

/** The request did not complete: the network failed, or `fetch` rejected. Nothing was received. */
export class TransportError extends EquityOSError {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`The request to ${url} did not complete.`, { cause });
    this.name = "TransportError";
    this.url = url;
  }
}

/**
 * A response arrived and is not what the API documents: not JSON, or a value of the wrong type at `path`. It
 * means the base URL is not an EquityOS deployment, or a proxy changed the response.
 */
export class ResponseShapeError extends EquityOSError {
  readonly status: number;
  /** Location of the first mismatch, such as `data[2].referencePrice.priceE8`. Empty for the whole body. */
  readonly path: string;

  constructor(status: number, path: string, message: string) {
    super(message);
    this.name = "ResponseShapeError";
    this.status = status;
    this.path = path;
  }
}

export type RegistryReadErrorCode =
  /** The RPC endpoint is on another chain than the one asked for. */
  | "chain_mismatch"
  /** The registry address holds no code on the chain at the block read. */
  | "registry_not_deployed"
  /** The registry holds no index with this id. */
  | "index_not_found"
  /** The index has no version with this number. */
  | "version_not_found"
  /** The RPC endpoint failed, timed out or answered with a JSON-RPC error. */
  | "rpc_failure"
  /** The chain answered with something the registry cannot have stored. */
  | "malformed_response";

/** `verifyIndexVersion` could not read the version from the chain. A version that fails a check is not an error. */
export class RegistryReadError extends EquityOSError {
  readonly code: RegistryReadErrorCode;

  constructor(code: RegistryReadErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RegistryReadError";
    this.code = code;
  }
}

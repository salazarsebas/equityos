import "server-only";

/**
 * Error taxonomy of the registry reader, with the same codes the market data layer uses for the same
 * conditions. These are failures of the read itself. A registry that is not deployed, an index that does not
 * exist and a version that fails verification are not errors: they are typed results, because a caller has to
 * render each of them.
 */
export type RegistryErrorCode = "upstream_failure" | "malformed_response" | "missing_configuration";

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;

  constructor(code: RegistryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The RPC endpoint did not answer, answered with an error, or timed out. Retrying later may succeed. */
export class RegistryUpstreamError extends RegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super("upstream_failure", `registry_rpc: ${message}`, options);
  }
}

/** The chain answered with something the registry contract cannot have produced. Never retried or defaulted. */
export class MalformedRegistryResponseError extends RegistryError {
  constructor(message: string) {
    super("malformed_response", `registry_rpc: ${message}`);
  }
}

/** An environment variable is absent or unusable, or the endpoint is not the configured chain. */
export class RegistryConfigurationError extends RegistryError {
  readonly variable: string;

  constructor(variable: string, problem: string, options?: ErrorOptions) {
    super("missing_configuration", `${variable} ${problem}`, options);
    this.variable = variable;
  }
}

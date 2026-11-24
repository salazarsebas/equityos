import "server-only";
import { DEPLOYMENTS, type Deployment, LOCAL_CHAIN_ID, type SupportedChainId } from "@equityos/contracts-abi";
import { resolveBaseRpcUrl } from "./market/config";
import { REPLAY_VARIABLE } from "./market/replay";
import { resolveChainId, resolveRegistryRpcUrl } from "./registry/config";
import { REGISTRY_REPLAY_VARIABLE } from "./registry/replay";

/**
 * The variable that declares that this deployment serves a deployed registry: `true` makes the server refuse to
 * start when the deployment map records no registry on `EQUITYOS_CHAIN_ID`. Unset or `false`: no such claim.
 */
export const REQUIRE_REGISTRY_VARIABLE = "EQUITYOS_REQUIRE_REGISTRY";

/** Everything the check reads. Values are read, never logged. */
export interface DeploymentEnvironment {
  readonly NODE_ENV?: string | undefined;
  readonly NEXT_PHASE?: string | undefined;
  readonly VERCEL_ENV?: string | undefined;
  readonly EQUITYOS_REPLAY_FOR_TESTS?: string | undefined;
  readonly MARKET_REPLAY_DIR?: string | undefined;
  readonly REGISTRY_REPLAY_DIR?: string | undefined;
  readonly BASE_RPC_URL?: string | undefined;
  readonly EQUITYOS_CHAIN_ID?: string | undefined;
  readonly EQUITYOS_RPC_URL?: string | undefined;
  readonly EQUITYOS_REQUIRE_REGISTRY?: string | undefined;
  readonly NEXT_PUBLIC_SITE_URL?: string | undefined;
  readonly NEXT_PUBLIC_BASE_RPC_URL?: string | undefined;
  readonly NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL?: string | undefined;
}

/**
 * The environment of this server. The `NEXT_PUBLIC_*` values are read by their full names so that Next.js
 * inlines them: what is checked is what the browser bundle was built with.
 */
function processEnvironment(): DeploymentEnvironment {
  return {
    ...process.env,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    NEXT_PUBLIC_BASE_RPC_URL: process.env.NEXT_PUBLIC_BASE_RPC_URL,
    NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL,
  };
}

/** One unusable variable and what is wrong with it. Never contains the value. */
export interface ConfigurationProblem {
  readonly variable: string;
  readonly problem: string;
}

/** A production server is missing a variable or has contradictory ones. It must not serve. */
export class DeploymentConfigurationError extends Error {
  readonly problems: readonly ConfigurationProblem[];

  constructor(problems: readonly ConfigurationProblem[]) {
    super(`refusing to serve: ${problems.map(({ variable, problem }) => `${variable} ${problem}`).join("; ")}`);
    this.name = "DeploymentConfigurationError";
    this.problems = problems;
  }
}

function isSet(value: string | undefined): value is string {
  return (value?.trim() ?? "") !== "";
}

/**
 * Whether the production checks apply.
 *
 * - `development`: not a production build (`next dev`, unit tests). Nothing is checked.
 * - `test_replay`: a production build started by the browser smoke tests, which set `EQUITYOS_REPLAY_FOR_TESTS=1`
 *   outside Vercel and serve recordings. The replay rules of `data-mode.ts` apply, not these checks.
 * - `build`: `next build` evaluating server code. Nothing is served yet.
 * - `production`: anything else in a production build, a Vercel deployment always included.
 */
export function deploymentContext(env: DeploymentEnvironment): "development" | "test_replay" | "build" | "production" {
  if (env.NODE_ENV !== "production") return "development";
  if (env.NEXT_PHASE === "phase-production-build") return "build";
  if (!isSet(env.VERCEL_ENV) && env.EQUITYOS_REPLAY_FOR_TESTS === "1") return "test_replay";
  return "production";
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Why `value` is not a usable public origin, or `null`. Plain HTTP is accepted for a local host only. */
function originProblem(value: string): string | null {
  if (!URL.canParse(value)) return "is not a URL";
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    return "is not an https URL";
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    return "is not an origin (it has a path, query, fragment or credentials)";
  }
  return null;
}

function httpUrlProblem(value: string | undefined): string | null {
  if (!isSet(value)) return "is not set";
  if (!URL.canParse(value.trim()) || !/^https?:$/.test(new URL(value.trim()).protocol)) {
    return "is not an http or https URL";
  }
  return null;
}

/**
 * Every problem of a production configuration: a required variable that is missing or unusable, a test-only
 * variable that is set, or two variables that contradict each other. Empty outside production.
 */
export function checkDeploymentConfiguration(
  env: DeploymentEnvironment,
  deployments: Readonly<Record<SupportedChainId, Deployment>> = DEPLOYMENTS,
): ConfigurationProblem[] {
  if (deploymentContext(env) !== "production") return [];
  const problems: ConfigurationProblem[] = [];
  const add = (variable: string, problem: string) => problems.push({ variable, problem });
  const production = { ...env, NODE_ENV: "production" };

  try {
    resolveBaseRpcUrl(production);
  } catch {
    add("BASE_RPC_URL", isSet(env.BASE_RPC_URL) ? "is not an http or https URL" : "is not set");
  }

  for (const variable of [REPLAY_VARIABLE, REGISTRY_REPLAY_VARIABLE, "EQUITYOS_REPLAY_FOR_TESTS"] as const) {
    if (isSet(env[variable])) add(variable, "is set: it is for the browser tests only and never for a deployment");
  }

  let chainId: SupportedChainId | null = null;
  try {
    chainId = resolveChainId(production);
  } catch {
    add("EQUITYOS_CHAIN_ID", "is not a supported chain id");
  }
  if (chainId === LOCAL_CHAIN_ID) add("EQUITYOS_CHAIN_ID", "names the local development chain");
  if (chainId !== null && chainId !== LOCAL_CHAIN_ID) {
    try {
      resolveRegistryRpcUrl(chainId, production);
    } catch {
      // Base mainnet is read through BASE_RPC_URL, already reported above.
      if (!problems.some(({ variable }) => variable === "BASE_RPC_URL")) {
        add("EQUITYOS_RPC_URL", `is required for chain ${chainId} and is not set or not an http or https URL`);
      }
    }
  }

  const requireRegistry = env.EQUITYOS_REQUIRE_REGISTRY?.trim() ?? "";
  if (requireRegistry !== "" && requireRegistry !== "true" && requireRegistry !== "false") {
    add(REQUIRE_REGISTRY_VARIABLE, "is neither true nor false");
  }
  if (requireRegistry === "true" && chainId !== null && deployments[chainId].deployBlock === null) {
    add(
      REQUIRE_REGISTRY_VARIABLE,
      `is true, and the deployment map records no registry on EQUITYOS_CHAIN_ID ${chainId}`,
    );
  }

  const siteUrl = env.NEXT_PUBLIC_SITE_URL?.trim() ?? "";
  const siteProblem = siteUrl === "" ? "is not set" : originProblem(siteUrl);
  if (siteProblem !== null) add("NEXT_PUBLIC_SITE_URL", siteProblem);

  for (const variable of ["NEXT_PUBLIC_BASE_RPC_URL", "NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL"] as const) {
    const problem = httpUrlProblem(env[variable]);
    if (problem !== null) add(variable, problem);
  }
  return problems;
}

/**
 * Checks the configuration at server start. Each problem is logged on its own line, by variable name and
 * without its value, then the check throws: Next.js logs the error and answers every request with a 500.
 *
 * @throws {DeploymentConfigurationError} if any problem is found.
 */
export function assertDeploymentConfiguration(
  env: DeploymentEnvironment = processEnvironment(),
  log: (line: string) => void = console.error,
): void {
  const problems = checkDeploymentConfiguration(env);
  if (problems.length === 0) return;
  for (const { variable, problem } of problems) log(`deployment configuration: ${variable} ${problem}`);
  throw new DeploymentConfigurationError(problems);
}

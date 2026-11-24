import { describe, expect, test } from "bun:test";
import { DEPLOYMENTS } from "@equityos/contracts-abi";
import {
  assertDeploymentConfiguration,
  checkDeploymentConfiguration,
  DeploymentConfigurationError,
  type DeploymentEnvironment,
  deploymentContext,
} from "../src/server/deployment-check";

/** A complete production configuration on Vercel. Every value is a placeholder. */
const COMPLETE: DeploymentEnvironment = {
  NODE_ENV: "production",
  VERCEL_ENV: "production",
  BASE_RPC_URL: "https://base-rpc.example/v1/server-key-placeholder",
  NEXT_PUBLIC_SITE_URL: "https://equityos.example",
  NEXT_PUBLIC_BASE_RPC_URL: "https://base-rpc.example/v1/public-key-placeholder",
  NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL: "https://sepolia-rpc.example/v1/public-key-placeholder",
};

/** The map after a deployment on both live chains. */
const DEPLOYED = {
  ...DEPLOYMENTS,
  8453: { ...DEPLOYMENTS[8453], deployBlock: 1_000n },
  84532: { ...DEPLOYMENTS[84532], deployBlock: 1_000n },
};

function variables(env: DeploymentEnvironment, deployments = DEPLOYMENTS): string[] {
  return checkDeploymentConfiguration(env, deployments).map(({ variable }) => variable);
}

describe("deploymentContext", () => {
  test("checks production servers only, and leaves the browser tests and the build to their own rules", () => {
    expect(deploymentContext({})).toBe("development");
    expect(deploymentContext({ NODE_ENV: "development", VERCEL_ENV: "preview" })).toBe("development");
    expect(deploymentContext({ NODE_ENV: "test" })).toBe("development");
    expect(deploymentContext({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" })).toBe("build");
    expect(deploymentContext({ NODE_ENV: "production", EQUITYOS_REPLAY_FOR_TESTS: "1" })).toBe("test_replay");
    // On Vercel the test flag changes nothing.
    expect(deploymentContext({ NODE_ENV: "production", VERCEL_ENV: "preview", EQUITYOS_REPLAY_FOR_TESTS: "1" })).toBe(
      "production",
    );
    expect(deploymentContext({ NODE_ENV: "production" })).toBe("production");
    expect(deploymentContext({ NODE_ENV: "production", EQUITYOS_REPLAY_FOR_TESTS: "true" })).toBe("production");
  });
});

describe("checkDeploymentConfiguration", () => {
  test("accepts a complete configuration on Base mainnet, and on Base Sepolia with its endpoint", () => {
    expect(checkDeploymentConfiguration(COMPLETE)).toEqual([]);
    const sepolia = { ...COMPLETE, EQUITYOS_CHAIN_ID: "84532", EQUITYOS_RPC_URL: "https://sepolia-rpc.example/v1/k" };
    expect(checkDeploymentConfiguration(sepolia)).toEqual([]);
    expect(checkDeploymentConfiguration({ ...COMPLETE, VERCEL_ENV: undefined })).toEqual([]);
  });

  test("checks nothing outside production", () => {
    expect(checkDeploymentConfiguration({ NODE_ENV: "development" })).toEqual([]);
    expect(checkDeploymentConfiguration({ NODE_ENV: "production", EQUITYOS_REPLAY_FOR_TESTS: "1" })).toEqual([]);
  });

  test("lists every missing required variable", () => {
    expect(variables({ NODE_ENV: "production", VERCEL_ENV: "preview" })).toEqual([
      "BASE_RPC_URL",
      "NEXT_PUBLIC_SITE_URL",
      "NEXT_PUBLIC_BASE_RPC_URL",
      "NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL",
    ]);
    expect(variables({ ...COMPLETE, BASE_RPC_URL: "  " })).toEqual(["BASE_RPC_URL"]);
  });

  test("refuses unusable URLs", () => {
    expect(variables({ ...COMPLETE, BASE_RPC_URL: "wss://base-rpc.example" })).toEqual(["BASE_RPC_URL"]);
    expect(variables({ ...COMPLETE, NEXT_PUBLIC_BASE_RPC_URL: "not a url" })).toEqual(["NEXT_PUBLIC_BASE_RPC_URL"]);
    for (const site of ["http://equityos.example", "https://equityos.example/app", "https://equityos.example/?a=1"]) {
      expect(variables({ ...COMPLETE, NEXT_PUBLIC_SITE_URL: site })).toEqual(["NEXT_PUBLIC_SITE_URL"]);
    }
    expect(variables({ ...COMPLETE, NEXT_PUBLIC_SITE_URL: "http://localhost:3000" })).toEqual([]);
    expect(variables({ ...COMPLETE, NEXT_PUBLIC_SITE_URL: "https://equityos.example/" })).toEqual([]);
  });

  test("refuses every replay variable, the test flag included", () => {
    for (const variable of ["MARKET_REPLAY_DIR", "REGISTRY_REPLAY_DIR", "EQUITYOS_REPLAY_FOR_TESTS"]) {
      expect(variables({ ...COMPLETE, [variable]: "1" })).toEqual([variable]);
    }
    expect(variables({ ...COMPLETE, MARKET_REPLAY_DIR: " " })).toEqual([]);
  });

  test("refuses an unsupported or local chain, and Base Sepolia without its endpoint", () => {
    expect(variables({ ...COMPLETE, EQUITYOS_CHAIN_ID: "1" })).toEqual(["EQUITYOS_CHAIN_ID"]);
    expect(variables({ ...COMPLETE, EQUITYOS_CHAIN_ID: "31337" })).toEqual(["EQUITYOS_CHAIN_ID"]);
    expect(variables({ ...COMPLETE, EQUITYOS_CHAIN_ID: "84532" })).toEqual(["EQUITYOS_RPC_URL"]);
    const ftp = { ...COMPLETE, EQUITYOS_CHAIN_ID: "84532", EQUITYOS_RPC_URL: "ftp://sepolia.example" };
    expect(variables(ftp)).toEqual(["EQUITYOS_RPC_URL"]);
  });

  test("refuses a claim of a deployed registry on a chain where the map records none", () => {
    expect(variables({ ...COMPLETE, EQUITYOS_REQUIRE_REGISTRY: "true" })).toEqual(["EQUITYOS_REQUIRE_REGISTRY"]);
    const sepolia = {
      ...COMPLETE,
      EQUITYOS_CHAIN_ID: "84532",
      EQUITYOS_RPC_URL: "https://sepolia-rpc.example/v1/k",
      EQUITYOS_REQUIRE_REGISTRY: "true",
    };
    expect(variables(sepolia)).toEqual(["EQUITYOS_REQUIRE_REGISTRY"]);
    expect(variables(sepolia, DEPLOYED)).toEqual([]);
    expect(variables({ ...COMPLETE, EQUITYOS_REQUIRE_REGISTRY: "true" }, DEPLOYED)).toEqual([]);
    expect(variables({ ...COMPLETE, EQUITYOS_REQUIRE_REGISTRY: "false" })).toEqual([]);
    expect(variables({ ...COMPLETE, EQUITYOS_REQUIRE_REGISTRY: "yes" })).toEqual(["EQUITYOS_REQUIRE_REGISTRY"]);
  });
});

describe("assertDeploymentConfiguration", () => {
  test("logs one line per problem without any value, then throws", () => {
    const lines: string[] = [];
    const secret = "https://base-rpc.example/v1/secret-key-placeholder-123";
    const env = { ...COMPLETE, NEXT_PUBLIC_SITE_URL: undefined, BASE_RPC_URL: secret.replace("https", "wss") };
    const attempt = () => assertDeploymentConfiguration(env, (line) => lines.push(line));
    expect(attempt).toThrow(DeploymentConfigurationError);
    expect(lines).toEqual([
      "deployment configuration: BASE_RPC_URL is not an http or https URL",
      "deployment configuration: NEXT_PUBLIC_SITE_URL is not set",
    ]);
    const error = (() => {
      try {
        attempt();
      } catch (caught) {
        return caught;
      }
    })();
    expect(String(error)).not.toContain("secret-key-placeholder");
    for (const line of lines) expect(line).not.toContain("secret-key-placeholder");
  });

  test("is silent and returns for a complete configuration", () => {
    const lines: string[] = [];
    assertDeploymentConfiguration(COMPLETE, (line) => lines.push(line));
    expect(lines).toEqual([]);
  });
});

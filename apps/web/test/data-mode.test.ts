import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { statusHandler } from "../src/server/api/status";
import { combinedMode, replayRefusal } from "../src/server/data-mode";
import { register } from "../src/instrumentation";
import { DeploymentConfigurationError } from "../src/server/deployment-check";
import { getMarketData, MissingConfigurationError, marketDataMode } from "../src/server/market/index";
import { RegistryConfigurationError } from "../src/server/registry/errors";
import { getRegistryReader, getRegistryReplay, registryMode } from "../src/server/registry/reader";
import { body, fixtureService, get, recordedRegistry } from "./api/support";

const VARIABLES = [
  "NODE_ENV",
  "VERCEL_ENV",
  "NEXT_RUNTIME",
  "EQUITYOS_REPLAY_FOR_TESTS",
  "MARKET_REPLAY_DIR",
  "REGISTRY_REPLAY_DIR",
  "BASE_RPC_URL",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_BASE_RPC_URL",
  "NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL",
] as const;
const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));

/** Sets the process environment of one test. Every variable it does not name is unset. */
function environment(values: Partial<Record<(typeof VARIABLES)[number], string>>): void {
  const env: Record<string, string | undefined> = process.env;
  for (const name of VARIABLES) {
    const value = values[name];
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
}

afterEach(() => {
  const env: Record<string, string | undefined> = process.env;
  for (const name of VARIABLES) {
    const value = saved[name];
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
});

describe("replayRefusal", () => {
  test("allows a replay in development and tests, refuses it on a deployment and in a plain production build", () => {
    expect(replayRefusal({ NODE_ENV: "development" })).toBeNull();
    expect(replayRefusal({ NODE_ENV: "test" })).toBeNull();
    expect(replayRefusal({})).toBeNull();
    expect(replayRefusal({ NODE_ENV: "production", EQUITYOS_REPLAY_FOR_TESTS: "1" })).toBeNull();
    expect(replayRefusal({ NODE_ENV: "production" })).toContain("production build");
    expect(replayRefusal({ NODE_ENV: "production", EQUITYOS_REPLAY_FOR_TESTS: "yes" })).toContain("production build");
    expect(replayRefusal({ NODE_ENV: "development", VERCEL_ENV: "preview" })).toContain("deployment");
    expect(
      replayRefusal({ NODE_ENV: "production", VERCEL_ENV: "production", EQUITYOS_REPLAY_FOR_TESTS: "1" }),
    ).toContain("deployment");
    // An empty value is how an unset variable is often written: it is not a deployment.
    expect(replayRefusal({ NODE_ENV: "test", VERCEL_ENV: " " })).toBeNull();
  });

  test("a response is a replay as soon as one of its sources is", () => {
    expect(combinedMode()).toBe("live");
    expect(combinedMode("live", "live")).toBe("live");
    expect(combinedMode("live", "replay")).toBe("replay");
    expect(combinedMode("replay", "live")).toBe("replay");
  });
});

describe("the process-wide sources on a deployment", () => {
  const deployment = {
    NODE_ENV: "production",
    VERCEL_ENV: "production",
    EQUITYOS_REPLAY_FOR_TESTS: "1",
    MARKET_REPLAY_DIR: "test/fixtures/market",
    REGISTRY_REPLAY_DIR: "test/fixtures/registry",
  } as const;

  test("every accessor of the market data and the registry fails with a typed configuration error", () => {
    environment(deployment);
    expect(() => marketDataMode()).toThrow(MissingConfigurationError);
    expect(() => getMarketData()).toThrow(MissingConfigurationError);
    expect(() => registryMode()).toThrow(RegistryConfigurationError);
    expect(() => getRegistryReplay()).toThrow(RegistryConfigurationError);
    expect(() => getRegistryReader()).toThrow(RegistryConfigurationError);
  });

  test("the startup hook fails, which makes the server answer every request with a 500", async () => {
    environment({ ...deployment, NEXT_RUNTIME: "nodejs" });
    await expect(register()).rejects.toThrow(MissingConfigurationError);
    environment({ ...deployment, NEXT_RUNTIME: "nodejs", MARKET_REPLAY_DIR: "" });
    await expect(register()).rejects.toThrow(RegistryConfigurationError);
    // Without a replay, the production configuration is checked next: an empty one is refused as well.
    const log = spyOn(console, "error").mockImplementation(() => {});
    environment({ NODE_ENV: "production", VERCEL_ENV: "production", NEXT_RUNTIME: "nodejs" });
    await expect(register()).rejects.toThrow(DeploymentConfigurationError);
    log.mockRestore();
    environment({
      NODE_ENV: "production",
      VERCEL_ENV: "production",
      NEXT_RUNTIME: "nodejs",
      BASE_RPC_URL: "https://rpc.example/base",
      NEXT_PUBLIC_SITE_URL: "https://equityos.example",
      NEXT_PUBLIC_BASE_RPC_URL: "https://rpc.example/base-public",
      NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL: "https://rpc.example/sepolia-public",
    });
    await expect(register()).resolves.toBeUndefined();
  });

  test("the status endpoint answers 500 service_misconfigured instead of reporting a replay", async () => {
    environment(deployment);
    const log = spyOn(console, "error").mockImplementation(() => {});
    const service = fixtureService();
    const response = await statusHandler({
      marketData: service.marketData,
      mode: marketDataMode,
      registry: () => recordedRegistry(),
      registryMode,
    })(get("/api/v1/status"), undefined);
    expect(response.status).toBe(500);
    expect((await body(response)).error?.code).toBe("service_misconfigured");
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});

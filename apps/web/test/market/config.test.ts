import { describe, expect, test } from "bun:test";
import { resolveBaseRpcUrl } from "../../src/server/market/config";
import { MissingConfigurationError } from "../../src/server/market/errors";

describe("resolveBaseRpcUrl", () => {
  test("returns the configured URL", () => {
    expect(resolveBaseRpcUrl({ BASE_RPC_URL: "https://rpc.example/v1/key", NODE_ENV: "production" })).toBe(
      "https://rpc.example/v1/key",
    );
    expect(resolveBaseRpcUrl({ BASE_RPC_URL: "  http://127.0.0.1:8545 ", NODE_ENV: "development" })).toBe(
      "http://127.0.0.1:8545",
    );
  });

  test("fails with a typed error when unset or blank in production", () => {
    for (const BASE_RPC_URL of [undefined, "", "   "]) {
      let thrown: unknown;
      try {
        resolveBaseRpcUrl({ BASE_RPC_URL, NODE_ENV: "production" });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(MissingConfigurationError);
      expect(thrown).toMatchObject({ code: "missing_configuration", variable: "BASE_RPC_URL" });
    }
  });

  test("falls back to the public endpoint outside production only", () => {
    expect(resolveBaseRpcUrl({ NODE_ENV: "development" })).toBe("https://mainnet.base.org");
    expect(resolveBaseRpcUrl({ NODE_ENV: "test" })).toBe("https://mainnet.base.org");
    expect(resolveBaseRpcUrl({})).toBe("https://mainnet.base.org");
  });

  test("rejects a value that is not an http or https URL, in every environment", () => {
    for (const BASE_RPC_URL of ["mainnet.base.org", "wss://rpc.example", "file:///etc/hosts", "not a url"]) {
      expect(() => resolveBaseRpcUrl({ BASE_RPC_URL, NODE_ENV: "development" })).toThrow(MissingConfigurationError);
      expect(() => resolveBaseRpcUrl({ BASE_RPC_URL, NODE_ENV: "production" })).toThrow(MissingConfigurationError);
    }
  });
});

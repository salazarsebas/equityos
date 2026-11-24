import { describe, expect, test } from "bun:test";
import { INDEX_REGISTRY_ADDRESS } from "@equityos/contracts-abi";
import vectors from "@equityos/core/vectors/specs-valid.json";
import { buildExampleSpec, EXAMPLE_VECTOR_NAME } from "../src/lib/landing/example-spec";
import { executionAvailability } from "../src/server/api/status";
import { executionReleased, loadRegistry, loadUniverse, summarizeUniverse } from "../src/server/landing";
import { resolveRegistryConfig } from "../src/server/registry/config";
import { createRegistryReader } from "../src/server/registry/reader";
import { fixtureService, RECORDED_AT, recordedRegistry } from "./api/support";

describe("example spec of the landing page", () => {
  const example = buildExampleSpec();
  const vector = vectors.vectors.find(({ name }) => name === EXAMPLE_VECTOR_NAME);

  test("is the canonical text of the vector, with the hash and the weights the vector records", () => {
    expect(vector).toBeDefined();
    expect<string>(example.specHash).toBe(vector?.specHash ?? "");
    expect(`0x${Buffer.from(example.canonicalText, "utf8").toString("hex")}`).toBe(vector?.canonicalHex ?? "");
    expect(example.byteLength).toBe(642);
    expect(example.weightsBps).toEqual([3334n, 3333n, 3333n]);
    expect(JSON.parse(example.canonicalText)).toEqual(vector?.spec);
  });

  test("refuses a vector that does not exist rather than showing something else", () => {
    expect(() => buildExampleSpec("no-such-vector")).toThrow("no valid spec vector named no-such-vector");
  });
});

describe("asset universe of the landing page", () => {
  test("counts the listed, minted and eligible tokens of the recorded block", async () => {
    const snapshot = await fixtureService().marketData().getSnapshot();
    expect(summarizeUniverse(snapshot, true)).toEqual({
      status: "ok",
      listed: 17,
      minted: 14,
      eligible: 13,
      blockNumber: 60_489_401n,
      blockTimestamp: snapshot.onchain.blockTimestamp,
      servedStale: false,
      phase: "closed",
      observedAt: RECORDED_AT,
      replay: true,
    });
  });

  test("is unavailable, with no count, when the sources cannot be read", async () => {
    const service = fixtureService();
    service.outage.api = true;
    service.outage.rpc = true;
    expect(await loadUniverse(service.marketData)).toEqual({ status: "unavailable" });
  });
});

describe("registry of the landing page", () => {
  test("on Base mainnet it is not deployed, from the deployment map", async () => {
    const reader = createRegistryReader({ config: resolveRegistryConfig({}) });
    expect(
      await loadRegistry(
        () => reader,
        () => 1_000,
      ),
    ).toEqual({
      status: "not_deployed",
      chainId: 8453,
      address: INDEX_REGISTRY_ADDRESS,
      reason: "not_configured",
      readAt: 1_000,
    });
  });

  test("on the recorded chain it counts the indexes and names the newest", async () => {
    const registry = await loadRegistry(
      () => recordedRegistry(),
      () => 1_000,
    );
    if (registry.status !== "deployed") throw new Error(`expected a deployed registry, got ${registry.status}`);
    expect(registry.total).toBe(5);
    expect(registry.newest?.latest.spec?.name).toBe("Diversified Equity");
    expect(registry.newest?.position).toBe(4);
  });

  test("is unavailable when the reader cannot be built", async () => {
    const failing = () => {
      throw new Error("misconfigured");
    };
    expect(await loadRegistry(failing)).toEqual({ status: "unavailable" });
  });
});

test("execution is reported as released exactly when the status endpoint would release it", () => {
  const permitted = executionAvailability({ restricted: false, reason: "permitted_country", country: "DE" });
  expect(executionReleased()).toBe(permitted.executionAvailable);
});

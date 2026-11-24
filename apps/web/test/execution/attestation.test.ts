import { describe, expect, test } from "bun:test";
import { DEPLOYMENTS, LOCAL_CHAIN_ID } from "@equityos/contracts-abi";
import type { Address } from "viem";
import { DIVERSIFIED } from "../../e2e/execution-plans";
import { planAttestation, rebalanceLogToRead } from "../../src/lib/execution/attestation";
import {
  builderCodeSuffix,
  ERC8021_MARKER,
  InvalidBuilderCodeError,
  withSuffix,
} from "../../src/lib/execution/builder-code";
import { EXECUTION_USDC, executionNetwork, executionNetworks } from "../../src/lib/execution/networks";
import { KYBERSWAP_EXECUTOR, KYBERSWAP_ROUTER } from "../../src/lib/execution/calldata";

const local = executionNetwork(LOCAL_CHAIN_ID, { NODE_ENV: "development" });
const registry = DEPLOYMENTS[LOCAL_CHAIN_ID].registry.toLowerCase() as Address;

describe("execution networks", () => {
  test("a production build sends plans on Base mainnet only, with the pinned addresses", () => {
    const networks = executionNetworks({ NODE_ENV: "production" });
    expect(networks).toEqual([
      {
        chainId: 8453,
        router: KYBERSWAP_ROUTER,
        executor: KYBERSWAP_EXECUTOR,
        usdc: EXECUTION_USDC,
        rebalanceLog: null,
      },
    ]);
    expect(executionNetwork(LOCAL_CHAIN_ID, { NODE_ENV: "production" })).toBeNull();
    expect(executionNetwork(84_532, { NODE_ENV: "development" })).toBeNull();
  });

  test("a development build adds the local chain with the same router, executor and USDC", () => {
    expect(local).toMatchObject({ router: KYBERSWAP_ROUTER, executor: KYBERSWAP_EXECUTOR, usdc: EXECUTION_USDC });
    expect(local?.rebalanceLog).toEqual({
      address: DEPLOYMENTS[LOCAL_CHAIN_ID].rebalanceLog.toLowerCase() as Address,
      registry,
    });
  });
});

describe("planAttestation", () => {
  if (local === null) throw new Error("no local network");
  const index = { indexId: DIVERSIFIED.indexId, version: DIVERSIFIED.version };

  test("is included where the log is deployed, has code, and validates against the index's registry", () => {
    const plan = planAttestation({
      network: local,
      registry: { chainId: LOCAL_CHAIN_ID, address: registry },
      index,
      code: "0x60",
    });
    expect(plan.status).toBe("included");
    expect(rebalanceLogToRead(local)).toBe(DEPLOYMENTS[LOCAL_CHAIN_ID].rebalanceLog.toLowerCase() as Address);
  });

  test("is omitted, with the reason, everywhere else", () => {
    const base = executionNetwork(8453, { NODE_ENV: "production" });
    if (base === null) throw new Error("no base network");
    expect(rebalanceLogToRead(base)).toBeNull();
    const at = (chainId: number, address: Address, code: `0x${string}` | undefined | null) =>
      planAttestation({ network: chainId === 8453 ? base : local, registry: { chainId, address }, index, code });
    expect(at(8453, registry, "0x60")).toEqual({ status: "omitted", reason: "not_deployed" });
    expect(
      planAttestation({ network: local, registry: { chainId: 8453, address: registry }, index, code: "0x60" }),
    ).toEqual({ status: "omitted", reason: "registry_elsewhere" });
    expect(at(LOCAL_CHAIN_ID, "0x1111111111111111111111111111111111111111", "0x60")).toEqual({
      status: "omitted",
      reason: "registry_elsewhere",
    });
    expect(at(LOCAL_CHAIN_ID, registry, "0x")).toEqual({ status: "omitted", reason: "no_code" });
    expect(at(LOCAL_CHAIN_ID, registry, undefined)).toEqual({ status: "omitted", reason: "no_code" });
    expect(at(LOCAL_CHAIN_ID, registry, null)).toEqual({ status: "omitted", reason: "unreadable" });
  });
});

describe("ERC-8021 Builder Code suffix", () => {
  test("is nothing when no code is configured", () => {
    expect(builderCodeSuffix(undefined)).toBeNull();
    expect(builderCodeSuffix("")).toBeNull();
    expect(builderCodeSuffix("   ")).toBeNull();
    expect(withSuffix("0x1234", null)).toBe("0x1234");
  });

  test("is schema 0: codes, their length, schema id 0, then the 16-byte marker", () => {
    // Attribution.toDataSuffix({ codes: ["baseapp"] }) of ox/erc8021.
    expect(builderCodeSuffix("baseapp")).toBe(`0x626173656170700700${ERC8021_MARKER.slice(2)}`);
    expect(ERC8021_MARKER).toBe("0x80218021802180218021802180218021");
    const suffix = builderCodeSuffix("bc_xyz456") ?? "0x";
    expect(withSuffix("0x1234", suffix)).toBe(`0x1234${suffix.slice(2)}`);
    // Read backwards as the specification parses it: marker, schema id, length, codes.
    const bytes = suffix.slice(2);
    expect(bytes.slice(-32)).toBe(ERC8021_MARKER.slice(2));
    expect(bytes.slice(-34, -32)).toBe("00");
    const length = Number.parseInt(bytes.slice(-36, -34), 16);
    expect(Buffer.from(bytes.slice(0, length * 2), "hex").toString("ascii")).toBe("bc_xyz456");
  });

  test("refuses a code that would not decode as itself", () => {
    for (const code of ["a,b", "two words", "café", "x".repeat(65)]) {
      expect(() => builderCodeSuffix(code)).toThrow(InvalidBuilderCodeError);
    }
  });
});

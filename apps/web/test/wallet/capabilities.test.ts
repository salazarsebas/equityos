import { describe, expect, test } from "bun:test";
import {
  BATCHING_PENDING,
  type Batching,
  classifyCapabilities,
  classifyCapabilitiesError,
  describeBatching,
} from "../../src/lib/wallet/capabilities";

const BASE = 8453;

/** The `wallet_getCapabilities` example of EIP-5792: no chain reports the `atomic` capability. */
const EIP_EXAMPLE = {
  "0x0": { "flow-control": { supported: true } },
  "0x2105": { paymasterService: { supported: true }, sessionKeys: { supported: true } },
  "0x14A34": { auxiliaryFunds: { supported: true } },
};

/** MetaMask, "Send atomic batch transactions": `ready` on mainnet, `supported` on Sepolia. */
const METAMASK = {
  "0x1": { atomic: { status: "ready" } },
  "0xaa36a7": { atomic: { status: "supported" } },
};

/** Coinbase Wallet SDK reference, `atomic` capability: the status string is under `supported`. */
const COINBASE_REFERENCE = { "0x2105": { atomic: { supported: "supported" } } };

/** Coinbase Wallet SDK batch transactions guide: the capability name from before the EIP was final. */
const COINBASE_LEGACY = {
  "0x2105": { atomicBatch: { supported: true }, paymasterService: { supported: true } },
};

describe("classifyCapabilities", () => {
  test("reads the three statuses the EIP defines", () => {
    const answer = (status: string) => classifyCapabilities({ "0x2105": { atomic: { status } } }, BASE);
    expect(answer("supported")).toEqual({ mode: "atomic", reason: "atomic_supported" });
    expect(answer("ready")).toEqual({ mode: "atomic", reason: "atomic_ready" });
    expect(answer("unsupported")).toEqual({ mode: "sequential", reason: "atomic_unsupported" });
  });

  test("an answer without the atomic capability means no batching, as the EIP states", () => {
    expect(classifyCapabilities(EIP_EXAMPLE, BASE)).toEqual({ mode: "sequential", reason: "not_reported" });
    expect(classifyCapabilities(EIP_EXAMPLE, 1)).toEqual({ mode: "sequential", reason: "not_reported" });
    expect(classifyCapabilities({}, BASE)).toEqual({ mode: "sequential", reason: "not_reported" });
  });

  test("reads the MetaMask answer per chain", () => {
    expect(classifyCapabilities(METAMASK, 1)).toEqual({ mode: "atomic", reason: "atomic_ready" });
    expect(classifyCapabilities(METAMASK, 11155111)).toEqual({ mode: "atomic", reason: "atomic_supported" });
    expect(classifyCapabilities(METAMASK, BASE)).toEqual({ mode: "sequential", reason: "not_reported" });
  });

  test("reads both Coinbase formats", () => {
    expect(classifyCapabilities(COINBASE_REFERENCE, BASE)).toEqual({ mode: "atomic", reason: "atomic_supported" });
    expect(classifyCapabilities({ "0x2105": { atomic: { supported: "unsupported" } } }, BASE).mode).toBe("sequential");
    expect(classifyCapabilities(COINBASE_LEGACY, BASE)).toEqual({ mode: "atomic", reason: "legacy_atomic_batch" });
    expect(classifyCapabilities({ "0x2105": { atomicBatch: { supported: false } } }, BASE)).toEqual({
      mode: "sequential",
      reason: "atomic_unsupported",
    });
  });

  test("the spec capability takes precedence over the legacy one", () => {
    const payload = { "0x2105": { atomic: { status: "unsupported" }, atomicBatch: { supported: true } } };
    expect(classifyCapabilities(payload, BASE).mode).toBe("sequential");
  });

  test("accepts the keys viem produces and hex keys in any case", () => {
    expect(classifyCapabilities({ 8453: { atomic: { status: "supported" } } }, BASE).mode).toBe("atomic");
    expect(classifyCapabilities({ "0x14a34": { atomic: { status: "supported" } } }, 84532).mode).toBe("atomic");
    expect(classifyCapabilities({ "0x14A34": { atomic: { status: "supported" } } }, 84532).mode).toBe("atomic");
  });

  test("capabilities under chain 0x0 apply to every chain and the chain entry overrides them", () => {
    const everywhere = { "0x0": { atomic: { status: "supported" } } };
    expect(classifyCapabilities(everywhere, BASE).mode).toBe("atomic");
    const overridden = { ...everywhere, "0x2105": { atomic: { status: "unsupported" } } };
    expect(classifyCapabilities(overridden, BASE).mode).toBe("sequential");
    expect(classifyCapabilities(overridden, 1).mode).toBe("atomic");
  });

  test("never assumes support from a malformed answer", () => {
    const malformed: Batching = { mode: "unknown", reason: "malformed" };
    for (const payload of [null, undefined, "0x", [], 1]) {
      expect(classifyCapabilities(payload, BASE)).toEqual(malformed);
    }
    for (const atomic of [true, "supported", null, {}, { status: "yes" }, { status: true }, { supported: true }]) {
      expect(classifyCapabilities({ "0x2105": { atomic } }, BASE)).toEqual(malformed);
    }
    expect(classifyCapabilities({ "0x2105": "atomic" }, BASE)).toEqual(malformed);
    expect(classifyCapabilities({ "0x2105": { atomicBatch: { supported: "true" } } }, BASE)).toEqual(malformed);
  });
});

describe("classifyCapabilitiesError", () => {
  test("a wallet without the method does not batch", () => {
    const sequential: Batching = { mode: "sequential", reason: "method_unsupported" };
    expect(classifyCapabilitiesError({ code: 4200, message: "Unsupported method" })).toEqual(sequential);
    expect(classifyCapabilitiesError({ code: -32601, message: "Method not found" })).toEqual(sequential);
    const wrapped = new Error("request failed", { cause: Object.assign(new Error("inner"), { code: -32601 }) });
    expect(classifyCapabilitiesError(wrapped)).toEqual(sequential);
  });

  test("any other failure leaves the answer unknown", () => {
    const unknown: Batching = { mode: "unknown", reason: "request_failed" };
    expect(classifyCapabilitiesError({ code: 4100, message: "Unauthorized" })).toEqual(unknown);
    expect(classifyCapabilitiesError({ code: 4900, message: "Disconnected" })).toEqual(unknown);
    expect(classifyCapabilitiesError(new Error("timeout"))).toEqual(unknown);
    expect(classifyCapabilitiesError(undefined)).toEqual(unknown);
  });
});

describe("describeBatching", () => {
  test("states the number of confirmations for each outcome", () => {
    expect(describeBatching({ mode: "atomic", reason: "atomic_supported" }).label).toBe("One confirmation");
    expect(describeBatching({ mode: "atomic", reason: "legacy_atomic_batch" }).label).toBe("One confirmation");
    expect(describeBatching({ mode: "atomic", reason: "atomic_ready" }).label).toContain("after an account upgrade");
    expect(describeBatching({ mode: "sequential", reason: "not_reported" }).label).toBe("One confirmation per step");
    expect(describeBatching(BATCHING_PENDING).label).toBe("Checking");
    const undetermined = describeBatching({ mode: "unknown", reason: "request_failed" });
    expect(undetermined.label).toBe("Not determined");
    expect(undetermined.meaning).toContain("treated as not batching");
  });
});

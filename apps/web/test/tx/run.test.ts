import { describe, expect, test } from "bun:test";
import { TX_IDLE, type TxEvent, type TxState, txReducer } from "../../src/lib/tx/machine";
import { type Replacement, runTransaction, type TxDriver } from "../../src/lib/tx/run";

const HASH = `0x${"a1".repeat(32)}` as const;
const OTHER = `0x${"b2".repeat(32)}` as const;
type Receipt = { status: "success" | "reverted" };

function harness(overrides: Partial<TxDriver<Receipt, string>> = {}) {
  let state: TxState<string> = TX_IDLE;
  const seen: string[] = [];
  const calls = { verify: 0 };
  const driver: TxDriver<Receipt, string> = {
    send: async () => HASH,
    wait: async () => ({ status: "success" }),
    verify: async () => {
      calls.verify += 1;
      return { ok: true, result: "verified" };
    },
    classify: () => ({ kind: "unknown" }),
    ...overrides,
  };
  const dispatch = (event: TxEvent<string>) => {
    state = txReducer(state, event);
    seen.push(state.status);
  };
  return { run: () => runTransaction(driver, dispatch), state: () => state, seen, calls };
}

describe("runTransaction", () => {
  test("walks signature, submission, receipt and verification in order", async () => {
    const h = harness();
    await h.run();
    expect(h.seen).toEqual(["awaiting_signature", "submitted", "verifying", "confirmed"]);
    expect(h.state()).toEqual({ status: "confirmed", hash: HASH, result: "verified" });
  });

  test("a reverted receipt is never verified and never confirmed", async () => {
    const h = harness({ wait: async () => ({ status: "reverted" }) });
    expect(await h.run()).toBeNull();
    expect(h.state()).toEqual({ status: "reverted", hash: HASH });
    expect(h.calls.verify).toBe(0);
  });

  test("a failed check on the effect leaves the transaction unverified", async () => {
    const h = harness({ verify: async () => ({ ok: false, reason: "spec hash differs" }) });
    await h.run();
    expect(h.state()).toEqual({ status: "unverified", hash: HASH, reason: "spec hash differs" });
  });

  test("a check that throws is a failed check", async () => {
    const h = harness({
      verify: async () => {
        throw new Error("rpc down");
      },
    });
    await h.run();
    expect(h.state().status).toBe("unverified");
  });

  test("a rejection in the wallet is not a failure", async () => {
    const h = harness({
      send: async () => {
        throw Object.assign(new Error("denied"), { code: 4001 });
      },
      classify: () => ({ kind: "user_rejected" }),
    });
    await h.run();
    expect(h.seen).toEqual(["awaiting_signature", "rejected"]);
  });

  test("any other send error is a failure with its classification", async () => {
    const h = harness({
      send: async () => {
        throw new Error("no funds");
      },
      classify: () => ({ kind: "insufficient_funds" }),
    });
    await h.run();
    expect(h.state()).toEqual({ status: "failed", failure: { kind: "insufficient_funds" } });
  });

  test("no receipt in time, or a wait that fails, is dropped", async () => {
    const none = harness({ wait: async () => null });
    await none.run();
    expect(none.state()).toEqual({ status: "dropped", hash: HASH });
    const failing = harness({
      wait: async () => {
        throw new Error("timeout");
      },
    });
    await failing.run();
    expect(failing.state().status).toBe("dropped");
  });

  test("a repriced transaction is followed to confirmation under the new hash", async () => {
    const h = harness({
      wait: async (_hash, onReplaced: (replacement: Replacement) => void) => {
        onReplaced({ reason: "repriced", hash: OTHER });
        return { status: "success" };
      },
    });
    await h.run();
    expect(h.state()).toEqual({ status: "confirmed", hash: OTHER, result: "verified" });
  });

  test("the receipt of a transaction that took the nonce is not treated as the requested one", async () => {
    const h = harness({
      wait: async (_hash, onReplaced: (replacement: Replacement) => void) => {
        onReplaced({ reason: "cancelled", hash: OTHER });
        return { status: "success" };
      },
    });
    expect(await h.run()).toBeNull();
    expect(h.state()).toEqual({ status: "replaced", hash: HASH, replacement: OTHER, reason: "cancelled" });
    expect(h.calls.verify).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import { isTxInFlight, TX_IDLE, type TxEvent, type TxState, txReducer } from "../../src/lib/tx/machine";

const HASH = `0x${"a1".repeat(32)}` as const;
const OTHER = `0x${"b2".repeat(32)}` as const;

function run(events: readonly TxEvent<string>[], from: TxState<string> = TX_IDLE): TxState<string> {
  return events.reduce(txReducer<string>, from);
}

const mined: TxEvent<string>[] = [
  { type: "request" },
  { type: "submitted", hash: HASH },
  { type: "receipt", status: "success", hash: HASH },
];

describe("txReducer", () => {
  test("the full path reaches confirmed only through a successful receipt and a passed verification", () => {
    expect(run([{ type: "request" }])).toEqual({ status: "awaiting_signature" });
    expect(run(mined.slice(0, 2))).toEqual({ status: "submitted", hash: HASH, repriced: false });
    expect(run(mined)).toEqual({ status: "verifying", hash: HASH });
    expect(run([...mined, { type: "verified", result: "ok" }])).toEqual({
      status: "confirmed",
      hash: HASH,
      result: "ok",
    });
  });

  test("a hash alone is never success: verified is ignored before the receipt", () => {
    const state = run([{ type: "request" }, { type: "submitted", hash: HASH }, { type: "verified", result: "ok" }]);
    expect(state.status).toBe("submitted");
  });

  test("a receipt that is not a success is a revert, and verification cannot follow it", () => {
    const state = run([
      { type: "request" },
      { type: "submitted", hash: HASH },
      { type: "receipt", status: "reverted", hash: HASH },
      { type: "verified", result: "ok" },
    ]);
    expect(state).toEqual({ status: "reverted", hash: HASH });
  });

  test("a failed verification is unverified, and a recheck can pass or fail again", () => {
    const failed = run([...mined, { type: "verification_failed", reason: "hash differs" }]);
    expect(failed).toEqual({ status: "unverified", hash: HASH, reason: "hash differs" });
    expect(run([{ type: "recheck" }], failed)).toEqual({ status: "verifying", hash: HASH });
    expect(run([{ type: "recheck" }, { type: "verified", result: "ok" }], failed).status).toBe("confirmed");
  });

  test("a rejection in the wallet is its own calm state and a new request can follow", () => {
    const rejected = run([{ type: "request" }, { type: "rejected" }]);
    expect(rejected).toEqual({ status: "rejected" });
    expect(run([{ type: "request" }], rejected)).toEqual({ status: "awaiting_signature" });
  });

  test("a failed send keeps the failure", () => {
    const failure = { kind: "insufficient_funds" } as const;
    expect(run([{ type: "request" }, { type: "send_failed", failure }])).toEqual({ status: "failed", failure });
  });

  test("a repriced transaction is followed under its new hash", () => {
    const state = run([{ type: "request" }, { type: "submitted", hash: HASH }, { type: "repriced", hash: OTHER }]);
    expect(state).toEqual({ status: "submitted", hash: OTHER, repriced: true });
  });

  test("replaced and dropped are terminal for the request and ignore a late receipt", () => {
    const start: TxEvent<string>[] = [{ type: "request" }, { type: "submitted", hash: HASH }];
    const replaced = run([...start, { type: "replaced", replacement: OTHER, reason: "cancelled" }]);
    expect(replaced).toEqual({ status: "replaced", hash: HASH, replacement: OTHER, reason: "cancelled" });
    expect(run([{ type: "receipt", status: "success", hash: OTHER }], replaced)).toBe(replaced);
    const dropped = run([...start, { type: "dropped" }]);
    expect(dropped).toEqual({ status: "dropped", hash: HASH });
    expect(run([{ type: "verified", result: "ok" }], dropped)).toBe(dropped);
  });

  test("no second request while one is with the wallet or the chain, nor after one was mined", () => {
    for (const events of [
      mined.slice(0, 1),
      mined.slice(0, 2),
      mined,
      [...mined, { type: "verified", result: "ok" } as const],
    ]) {
      const state = run(events);
      expect(run([{ type: "request" }], state)).toBe(state);
    }
  });

  test("reset returns to idle except while a transaction is in flight", () => {
    const confirmed = run([...mined, { type: "verified", result: "ok" }]);
    expect(run([{ type: "reset" }], confirmed)).toEqual({ status: "idle" });
    const submitted = run(mined.slice(0, 2));
    expect(run([{ type: "reset" }], submitted)).toBe(submitted);
    expect(isTxInFlight(submitted)).toBe(true);
    expect(isTxInFlight(confirmed)).toBe(false);
  });

  test("events that do not apply leave the state unchanged", () => {
    for (const event of [
      { type: "rejected" },
      { type: "submitted", hash: HASH },
      { type: "receipt", status: "success", hash: HASH },
      { type: "verified", result: "ok" },
      { type: "dropped" },
      { type: "recheck" },
    ] satisfies TxEvent<string>[]) {
      expect(txReducer<string>(TX_IDLE, event)).toBe(TX_IDLE);
    }
  });
});

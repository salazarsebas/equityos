import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { AMZN, DIVERSIFIED, NVDA, TSLA } from "../../e2e/execution-plans";
import {
  appendHistory,
  HISTORY_STORAGE_KEY,
  type HistoryEntry,
  type KeyValueStore,
  MAX_HISTORY_ENTRIES,
  parseHistory,
  readHistory,
} from "../../src/lib/execution/history";
import { driftAfter } from "../../src/lib/execution/outcome";

const ACCOUNT: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

function store(initial: string | null = null): KeyValueStore & { value: string | null } {
  return {
    value: initial,
    getItem(key) {
      return key === HISTORY_STORAGE_KEY ? this.value : null;
    },
    setItem(key, value) {
      if (key === HISTORY_STORAGE_KEY) this.value = value;
    },
  };
}

function entry(at: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    at,
    chainId: 8453,
    account: ACCOUNT,
    index: { identifier: DIVERSIFIED.identifier, name: DIVERSIFIED.name, indexId: DIVERSIFIED.indexId, version: 2 },
    planHash: hash(9),
    mode: "sequential",
    result: "partial",
    transactions: [{ hash: hash(1), label: "Approve NVDAc" }],
    attestation: null,
    stoppedBefore: null,
    ...overrides,
  };
}

describe("execution history in this browser", () => {
  test("records entries newest first, for the account that sent them", () => {
    const local = store();
    appendHistory(local, entry(1));
    appendHistory(local, entry(2, { result: "complete", planHash: hash(10) }));
    appendHistory(local, entry(3, { account: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }));
    const mine = readHistory(local, ACCOUNT);
    expect(mine.map(({ at }) => at)).toEqual([2, 1]);
    expect(mine[0]?.account).toBe(ACCOUNT.toLowerCase() as Address);
  });

  test("records where a run stopped, and reads entries written before that field existed", () => {
    const local = store();
    appendHistory(local, entry(1, { stoppedBefore: 2 }));
    expect(readHistory(local, ACCOUNT)[0]?.stoppedBefore).toBe(2);
    const { stoppedBefore: _, ...older } = { ...entry(2), account: ACCOUNT.toLowerCase() };
    expect(parseHistory(JSON.stringify({ entries: [older] }))[0]?.stoppedBefore).toBeNull();
    expect(parseHistory(JSON.stringify({ entries: [{ ...older, stoppedBefore: -1 }] }))).toEqual([]);
  });

  test("a later record of the same plan replaces the earlier one", () => {
    const local = store();
    appendHistory(local, entry(1, { result: "complete" }));
    appendHistory(local, entry(2, { result: "complete", attestation: hash(5) }));
    appendHistory(local, entry(3, { planHash: hash(8) }));
    const kept = readHistory(local, ACCOUNT);
    expect(kept.map(({ at }) => at)).toEqual([3, 2]);
    expect(kept[1]?.attestation).toBe(hash(5));
  });

  test("keeps the newest entries only", () => {
    const local = store();
    for (let at = 0; at < MAX_HISTORY_ENTRIES + 5; at += 1)
      appendHistory(local, entry(at, { planHash: hash(1000 + at) }));
    const kept = readHistory(local, ACCOUNT);
    expect(kept).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(kept[0]?.at).toBe(MAX_HISTORY_ENTRIES + 4);
  });

  test("a corrupted store is read as fewer entries, never as an error", () => {
    expect(parseHistory("{not json")).toEqual([]);
    expect(parseHistory("[]")).toEqual([]);
    expect(parseHistory(JSON.stringify({ entries: "x" }))).toEqual([]);
    const good = { ...entry(5), account: ACCOUNT.toLowerCase() };
    const bad = [
      { ...good, planHash: "0x12" },
      { ...good, result: "great" },
      { ...good, transactions: [{ hash: hash(1), label: "<b>".repeat(100) }] },
      { ...good, index: { ...good.index, version: 0 } },
      { ...good, attestation: "yes" },
      null,
    ];
    expect(parseHistory(JSON.stringify({ entries: [good, ...bad] }))).toHaveLength(1);
    // Appending over a corrupted value replaces it with a valid one.
    const local = store("{not json");
    appendHistory(local, entry(7));
    expect(readHistory(local, ACCOUNT)).toHaveLength(1);
  });

  test("a storage that throws records and reads nothing, and does not throw", () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(() => appendHistory(broken, entry(1))).not.toThrow();
    expect(readHistory(broken, ACCOUNT)).toEqual([]);
    expect(readHistory(null, ACCOUNT)).toEqual([]);
  });
});

describe("driftAfter", () => {
  const constituents = [
    { token: NVDA, decimals: 8, targetWeightBps: 5_000, priceE8: 10_000_000_000n, priceStatus: "live" as const },
    { token: TSLA, decimals: 8, targetWeightBps: 5_000, priceE8: 20_000_000_000n, priceStatus: "live" as const },
  ];

  test("recomputes weights and drift from the balances read again, with the same reference prices", () => {
    const balances = new Map<string, bigint | null>([
      [NVDA, 300_000_000n],
      [TSLA, 100_000_000n],
    ]);
    const outcome = driftAfter({ constituents, driftThresholdBps: 500, balances, usdcBalance: 1_000_000n });
    expect(outcome).toEqual({
      status: "ready",
      positions: [
        { token: TSLA, balance: 100_000_000n, weightBps: 4_000, driftBps: -1_000 },
        { token: NVDA, balance: 300_000_000n, weightBps: 6_000, driftBps: 1_000 },
      ],
      usdcBalance: 1_000_000n,
      maxAbsDriftBps: 1_000,
      thresholdReached: true,
    });
  });

  test("computes nothing from a partial read", () => {
    const balances = new Map<string, bigint | null>([
      [NVDA, 1n],
      [TSLA, null],
    ]);
    expect(driftAfter({ constituents, driftThresholdBps: 500, balances, usdcBalance: 0n })).toEqual({
      status: "incomplete",
      unread: [TSLA],
    });
    expect(
      driftAfter({
        constituents,
        driftThresholdBps: 500,
        balances: new Map([
          [NVDA, 1n],
          [TSLA, 1n],
        ]),
        usdcBalance: null,
      }).status,
    ).toBe("incomplete");
  });

  test("without a usable price the drift is undefined, never zero", () => {
    const priced = [
      ...constituents.slice(0, 1),
      { token: AMZN, decimals: 8, targetWeightBps: 5_000, priceE8: null, priceStatus: "unavailable" as const },
    ];
    const outcome = driftAfter({
      constituents: priced,
      driftThresholdBps: 500,
      balances: new Map([
        [NVDA, 1n],
        [AMZN, 1n],
      ]),
      usdcBalance: 0n,
    });
    expect(outcome.status === "ready" && outcome.maxAbsDriftBps).toBeNull();
  });
});

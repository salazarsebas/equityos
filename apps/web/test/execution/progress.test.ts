import { describe, expect, test } from "bun:test";
import { DEPLOYMENTS, LOCAL_CHAIN_ID, rebalanceLogAbi } from "@equityos/contracts-abi";
import { type Address, encodeAbiParameters, encodeEventTopics, erc20Abi, type Hex } from "viem";
import { DIVERSIFIED, NVDA, TSLA, USDC } from "../../e2e/execution-plans";
import type { AttestationCall } from "../../src/lib/execution/attestation";
import { KYBERSWAP_EXECUTOR, KYBERSWAP_ROUTER } from "../../src/lib/execution/calldata";
import {
  batchOutcome,
  batchResult,
  runSequential,
  type SequentialAction,
  type SequentialProgress,
  sequentialReducer,
  sequentialStart,
  sentHashes,
  summarizeSequential,
} from "../../src/lib/execution/progress";
import {
  checkBatchReceipts,
  checkTransactionReceipt,
  type LogLike,
  type TransactionReceiptLike,
} from "../../src/lib/execution/receipts";
import type { ExecutionRequest, SequentialStop } from "../../src/lib/execution/request";
import type { VerifiedCall } from "../../src/lib/execution/verify";
import type { TxDriver } from "../../src/lib/tx/run";

const ACCOUNT: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const LOG = DEPLOYMENTS[LOCAL_CHAIN_ID].rebalanceLog.toLowerCase() as Address;
/** The topics of an event with every argument given: each is one hex word. */
const onlyHex = (topics: readonly (Hex | Hex[] | null)[]): Hex[] =>
  topics.filter((topic): topic is Hex => typeof topic === "string");
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const sell: VerifiedCall = {
  kind: "swap",
  to: KYBERSWAP_ROUTER,
  data: "0x",
  value: 0n,
  leg: 0,
  side: "sell",
  tokenIn: NVDA,
  tokenOut: USDC,
  amountIn: 400n,
  minAmountOut: 500n,
  quotedAmountOut: 510n,
  deadline: 1,
};
const buy: VerifiedCall = {
  ...sell,
  leg: 1,
  side: "buy",
  tokenIn: USDC,
  tokenOut: TSLA,
  amountIn: 300n,
  minAmountOut: 70n,
};
const attestation: AttestationCall = {
  to: LOG,
  data: "0x",
  value: 0n,
  indexId: DIVERSIFIED.indexId,
  version: DIVERSIFIED.version,
};

function transfer(token: Address, from: Address, to: Address, value: bigint): LogLike {
  return {
    address: token,
    topics: onlyHex(encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } })),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

function recorded(account: Address, version: number = DIVERSIFIED.version, emitter: Address = LOG): LogLike {
  return {
    address: emitter,
    topics: onlyHex(
      encodeEventTopics({
        abi: rebalanceLogAbi,
        eventName: "RebalanceRecorded",
        args: { account, indexId: DIVERSIFIED.indexId, version },
      }),
    ),
    data: "0x",
  };
}

/** An `Approval` of the router, which a receipt of an approval call or a batch carries next to the transfers. */
const approval: LogLike = {
  address: NVDA,
  topics: onlyHex(
    encodeEventTopics({
      abi: erc20Abi,
      eventName: "Approval",
      args: { owner: ACCOUNT, spender: KYBERSWAP_ROUTER },
    }),
  ),
  data: encodeAbiParameters([{ type: "uint256" }], [400n]),
};

/** The transfers of the sell and the buy, executed within their bounds, after an approval. */
const swapLogs = [
  approval,
  transfer(NVDA, ACCOUNT, KYBERSWAP_EXECUTOR, 400n),
  transfer(USDC, KYBERSWAP_EXECUTOR, ACCOUNT, 505n),
  transfer(USDC, ACCOUNT, KYBERSWAP_EXECUTOR, 300n),
  transfer(TSLA, KYBERSWAP_EXECUTOR, ACCOUNT, 71n),
];

function receipt(logs: readonly LogLike[], overrides: Partial<TransactionReceiptLike> = {}): TransactionReceiptLike {
  return {
    status: "success",
    transactionHash: hash(1),
    blockNumber: 10n,
    logs,
    from: ACCOUNT,
    to: KYBERSWAP_ROUTER,
    ...overrides,
  };
}

describe("checkBatchReceipts", () => {
  const expected = { account: ACCOUNT, calls: [sell, buy], attestation };

  test("passes a successful batch within its bounds that recorded the attestation once, and decodes it", () => {
    const outcome = checkBatchReceipts([receipt([...swapLogs, recorded(ACCOUNT)])], expected);
    expect(outcome).toEqual({
      ok: true,
      result: {
        transactionHashes: [hash(1)],
        blockNumber: 10n,
        attestation: {
          log: LOG,
          account: ACCOUNT,
          indexId: DIVERSIFIED.indexId,
          version: DIVERSIFIED.version,
          transactionHash: hash(1),
        },
      },
    });
  });

  const refused: [string, Parameters<typeof checkBatchReceipts>[0]][] = [
    ["no receipt", []],
    ["a reverted receipt", [receipt([...swapLogs, recorded(ACCOUNT)], { status: "reverted" })]],
    ["no attestation event", [receipt(swapLogs)]],
    ["two attestation events", [receipt([...swapLogs, recorded(ACCOUNT), recorded(ACCOUNT)])]],
    ["an attestation of another account", [receipt([...swapLogs, recorded(OTHER)])]],
    ["an attestation of another version", [receipt([...swapLogs, recorded(ACCOUNT, 1)])]],
    [
      "more sold than the swap pulls",
      [receipt([transfer(NVDA, ACCOUNT, KYBERSWAP_EXECUTOR, 401n), ...swapLogs.slice(2), recorded(ACCOUNT)])],
    ],
    [
      "less received than the minimum",
      [receipt([...swapLogs.slice(0, 4), transfer(TSLA, KYBERSWAP_EXECUTOR, ACCOUNT, 69n), recorded(ACCOUNT)])],
    ],
  ];
  for (const [name, receipts] of refused) {
    test(`refuses ${name}`, () => {
      expect(checkBatchReceipts(receipts, expected).ok).toBe(false);
    });
  }

  test("an attestation event from another contract does not count", () => {
    const outcome = checkBatchReceipts(
      [receipt([...swapLogs, recorded(ACCOUNT, DIVERSIFIED.version, "0x1111111111111111111111111111111111111111")])],
      expected,
    );
    expect(outcome.ok).toBe(false);
  });
});

describe("checkTransactionReceipt", () => {
  const expected = { account: ACCOUNT, to: KYBERSWAP_ROUTER, call: sell, attestation: null };
  const sellLogs = swapLogs.slice(0, 3);

  test("passes a successful swap from the account to the router within its bounds", () => {
    expect(checkTransactionReceipt(receipt(sellLogs), expected).ok).toBe(true);
  });

  test("refuses another status, another sender and another contract", () => {
    expect(checkTransactionReceipt(receipt(sellLogs, { status: "reverted" }), expected).ok).toBe(false);
    expect(checkTransactionReceipt(receipt(sellLogs, { from: OTHER }), expected).ok).toBe(false);
    expect(checkTransactionReceipt(receipt(sellLogs, { to: USDC }), expected).ok).toBe(false);
    expect(checkTransactionReceipt(receipt(sellLogs, { to: null }), expected).ok).toBe(false);
  });

  test("an attestation transaction must carry its event", () => {
    const attest = { account: ACCOUNT, to: LOG, call: null, attestation };
    expect(checkTransactionReceipt(receipt([recorded(ACCOUNT)], { to: LOG }), attest).ok).toBe(true);
    expect(checkTransactionReceipt(receipt([], { to: LOG }), attest).ok).toBe(false);
  });
});

describe("batchOutcome", () => {
  const ok = { status: "success" as const, transactionHash: hash(1), blockNumber: 1n, logs: [] };
  const failed = { ...ok, status: "reverted" as const };
  const kind = (statusCode: number, receipts: (typeof ok | typeof failed)[]) =>
    batchOutcome({ statusCode, receipts })?.kind;

  test("is confirmed only with a 2xx code and every receipt successful", () => {
    expect(batchOutcome({ statusCode: 200, receipts: [ok] })?.status).toBe("success");
    expect(kind(200, [ok])).toBe("confirmed");
  });

  test("says nothing took effect only when the wallet says so: not included (4xx) or reverted (5xx)", () => {
    expect(kind(400, [])).toBe("not_included");
    expect(kind(500, [failed])).toBe("reverted");
    expect(batchOutcome({ statusCode: 500, receipts: [failed] })?.status).toBe("reverted");
  });

  test("anything else final is partial: a 6xx, or a 2xx without every receipt successful", () => {
    expect(kind(600, [ok, failed])).toBe("partial");
    expect(kind(200, [])).toBe("partial");
    expect(kind(200, [ok, failed])).toBe("partial");
  });

  test("only a batch the wallet reports as not included or reverted is recorded as nothing executed", () => {
    const reverted = { status: "reverted" as const, hash: "batch" };
    expect(batchResult(reverted, "reverted")).toBe("none");
    expect(batchResult(reverted, "not_included")).toBe("none");
    expect(batchResult(reverted, "partial")).toBe("partial");
    expect(batchResult({ status: "dropped", hash: "batch" }, null)).toBe("unknown");
    expect(batchResult({ status: "rejected" }, null)).toBeNull();
  });

  test("pending is no outcome yet", () => {
    expect(batchOutcome({ statusCode: 100 })).toBeNull();
    expect(batchOutcome({ statusCode: 700 })).toBeNull();
  });
});

type Receipt = { status: "success" | "reverted"; index: number };

function sequentialRequest(count: number): Extract<ExecutionRequest, { mode: "sequential" }> {
  const transaction = { account: ACCOUNT, chainId: LOCAL_CHAIN_ID, to: KYBERSWAP_ROUTER, data: "0x" as Hex, value: 0n };
  return {
    mode: "sequential",
    account: ACCOUNT,
    chainId: LOCAL_CHAIN_ID,
    transactions: Array.from({ length: count }, () => transaction),
    steps: Array.from({ length: count }, (_, call) => ({ kind: "swap" as const, call })),
    attestation: transaction,
    expiresAt: 1,
  };
}

function harness(
  count: number,
  behave: {
    receipt?: (index: number) => "success" | "reverted";
    verified?: (index: number) => boolean;
    reject?: (index: number) => boolean;
    recheck?: (index: number) => SequentialStop | null;
  } = {},
) {
  let state: SequentialProgress = sequentialStart(count);
  const sent: number[] = [];
  const rechecked: number[] = [];
  const dispatch = (action: SequentialAction) => {
    state = sequentialReducer(state, action);
  };
  const driver = (
    _: unknown,
    index: number,
  ): TxDriver<Receipt, { transactionHashes: Hex[]; blockNumber: bigint; attestation: null }> => ({
    send: async () => {
      if (behave.reject?.(index)) throw Object.assign(new Error("declined"), { code: 4001 });
      sent.push(index);
      return hash(index + 1);
    },
    wait: async () => ({ status: behave.receipt?.(index) ?? "success", index }),
    verify: async () =>
      (behave.verified?.(index) ?? true)
        ? { ok: true, result: { transactionHashes: [hash(index + 1)], blockNumber: 1n, attestation: null } }
        : { ok: false, reason: "not from the account" },
    classify: () => ({ kind: "user_rejected" }),
  });
  const run = () =>
    runSequential<Receipt>(sequentialRequest(count), {
      recheck: async (index) => {
        rechecked.push(index);
        return behave.recheck?.(index) ?? null;
      },
      driver,
      dispatch,
    });
  return { run, state: () => state, sent, rechecked };
}

describe("runSequential", () => {
  test("sends every transaction in order, each after the one before confirmed, rechecking before each", async () => {
    const h = harness(4);
    expect(await h.run()).toBe(true);
    expect(h.sent).toEqual([0, 1, 2, 3]);
    expect(h.rechecked).toEqual([0, 1, 2, 3]);
    const summary = summarizeSequential(h.state());
    expect(summary).toMatchObject({
      confirmed: [0, 1, 2, 3],
      failed: null,
      notSent: [],
      complete: true,
      settled: true,
    });
    expect(sentHashes(h.state())).toEqual([hash(1), hash(2), hash(3), hash(4)]);
  });

  test("stops at the first reverted transaction: what confirmed, what failed and what was not sent", async () => {
    const h = harness(4, { receipt: (index) => (index === 2 ? "reverted" : "success") });
    expect(await h.run()).toBe(false);
    expect(h.sent).toEqual([0, 1, 2]);
    const summary = summarizeSequential(h.state());
    expect(summary.confirmed).toEqual([0, 1]);
    expect(summary.failed?.index).toBe(2);
    expect(summary.failed?.state.status).toBe("reverted");
    expect(summary.notSent).toEqual([3]);
    expect(summary.settled).toBe(true);
    expect(summary.complete).toBe(false);
  });

  test("stops at a mined transaction whose receipt check fails", async () => {
    const h = harness(3, { verified: (index) => index !== 0 });
    expect(await h.run()).toBe(false);
    expect(h.sent).toEqual([0]);
    expect(summarizeSequential(h.state()).failed?.state.status).toBe("unverified");
  });

  test("a rejection is a stop like any other, with nothing after it sent", async () => {
    const h = harness(3, { reject: (index) => index === 1 });
    expect(await h.run()).toBe(false);
    const summary = summarizeSequential(h.state());
    expect(summary.confirmed).toEqual([0]);
    expect(summary.failed?.state.status).toBe("rejected");
    expect(summary.notSent).toEqual([2]);
  });

  test("a recheck that refuses stops before sending, with the reason", async () => {
    const h = harness(3, {
      recheck: (index) =>
        index === 1 ? { reason: "wrong_network", walletChainId: 8453, chainId: LOCAL_CHAIN_ID } : null,
    });
    expect(await h.run()).toBe(false);
    expect(h.sent).toEqual([0]);
    expect(h.state().stopped).toEqual({
      before: 1,
      refusal: { reason: "wrong_network", walletChainId: 8453, chainId: LOCAL_CHAIN_ID },
    });
    expect(summarizeSequential(h.state())).toMatchObject({
      confirmed: [0],
      failed: null,
      notSent: [1, 2],
      settled: true,
    });
  });

  test("leaving the page stops the run before the next transaction", async () => {
    const h = harness(3, { recheck: (index) => (index === 2 ? { reason: "left_page" } : null) });
    expect(await h.run()).toBe(false);
    expect(h.sent).toEqual([0, 1]);
    expect(h.state().stopped).toEqual({ before: 2, refusal: { reason: "left_page" } });
  });

  test("a stopped run accepts no later event", () => {
    let state = sequentialStart(2);
    state = sequentialReducer(state, { type: "stopped", before: 0, refusal: { reason: "chain_time_unknown" } });
    state = sequentialReducer(state, { type: "step", index: 0, event: { type: "request" } });
    expect(state.steps[0]?.status).toBe("idle");
  });
});

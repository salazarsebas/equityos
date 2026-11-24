/**
 * Tracking of an execution after the click. Pure: the wallet and the chain are injected, as in `lib/tx/run.ts`,
 * whose state machine tracks each transaction of the sequential path and the batch of the atomic path.
 */
import type { Hex } from "viem";
import { TX_IDLE, type TxEvent, type TxState, txReducer } from "@/lib/tx/machine";
import { runTransaction, type TxDriver, type Verification } from "@/lib/tx/run";
import type { ReceiptsCheck } from "./receipts";
import type { ExecutionRefusal, ExecutionRequest, SequentialTransaction } from "./request";

/** One transaction of the sequential path, or the batch of the atomic path. */
export type StepState = TxState<ReceiptsCheck>;
export type BatchState = TxState<ReceiptsCheck, string>;

/** States that end a transaction without its effect being established. */
const FAILED: readonly StepState["status"][] = ["rejected", "failed", "reverted", "replaced", "dropped", "unverified"];

export interface SequentialProgress {
  /** One state per transaction of `request.transactions`, in order. `idle` means not sent. */
  readonly steps: readonly StepState[];
  /** Set when a recheck before a transaction refused to send it: nothing from that one on was sent. */
  readonly stopped: { readonly before: number; readonly refusal: ExecutionRefusal } | null;
  /** The optional attestation, sent separately after every transaction confirmed. */
  readonly attestation: StepState;
}

export type SequentialAction =
  | { readonly type: "step"; readonly index: number; readonly event: TxEvent<ReceiptsCheck> }
  | { readonly type: "stopped"; readonly before: number; readonly refusal: ExecutionRefusal }
  | { readonly type: "attestation"; readonly event: TxEvent<ReceiptsCheck> };

export function sequentialStart(count: number): SequentialProgress {
  return { steps: Array.from({ length: count }, () => TX_IDLE), stopped: null, attestation: TX_IDLE };
}

export function sequentialReducer(state: SequentialProgress, action: SequentialAction): SequentialProgress {
  switch (action.type) {
    case "step": {
      const current = state.steps[action.index];
      if (current === undefined || state.stopped !== null) return state;
      const steps = state.steps.map((step, index) => (index === action.index ? txReducer(step, action.event) : step));
      return { ...state, steps };
    }
    case "stopped":
      return state.stopped === null ? { ...state, stopped: { before: action.before, refusal: action.refusal } } : state;
    case "attestation":
      return { ...state, attestation: txReducer(state.attestation, action.event) };
  }
}

export interface SequentialSummary {
  /** Indexes of the transactions mined with every check on their receipt passed. */
  readonly confirmed: readonly number[];
  /** The transaction the sequence stopped at, with its state, or `null`. */
  readonly failed: { readonly index: number; readonly state: StepState } | null;
  /** Indexes of the transactions that were never sent. */
  readonly notSent: readonly number[];
  /** The index of a transaction with the wallet or the chain, or `null`. */
  readonly inFlight: number | null;
  /** Every transaction confirmed. */
  readonly complete: boolean;
  /** Nothing is in flight and nothing more will be sent by this run. */
  readonly settled: boolean;
}

/** What happened to each transaction, in the words the result is reported in. */
export function summarizeSequential(progress: SequentialProgress): SequentialSummary {
  const confirmed: number[] = [];
  const notSent: number[] = [];
  let failed: SequentialSummary["failed"] = null;
  let inFlight: number | null = null;
  for (const [index, step] of progress.steps.entries()) {
    if (step.status === "confirmed") confirmed.push(index);
    else if (step.status === "idle") notSent.push(index);
    else if (FAILED.includes(step.status)) failed ??= { index, state: step };
    else inFlight ??= index;
  }
  const complete = confirmed.length === progress.steps.length;
  return {
    confirmed,
    failed,
    notSent,
    inFlight,
    complete,
    settled: inFlight === null && (complete || failed !== null || progress.stopped !== null),
  };
}

export interface SequentialDependencies<Receipt extends { readonly status: "success" | "reverted" }> {
  /**
   * Rechecks the plan before each transaction: the expiry by chain time, the account and the network, read at
   * that moment. Returns the refusal, or `null` to proceed.
   */
  recheck(index: number): Promise<ExecutionRefusal | null>;
  /** The driver of one transaction: send it, wait for its receipt and check the receipt. */
  driver(transaction: SequentialTransaction, index: number): TxDriver<Receipt, ReceiptsCheck>;
  dispatch(action: SequentialAction): void;
}

/**
 * Sends the transactions of a sequential request one at a time, in order. Each is sent only after the one
 * before it confirmed: mined with a successful receipt, from the account, to the expected contract, within its
 * bounds. The run stops at the first transaction that does not confirm, and before any transaction whose
 * recheck refuses. Called from a click handler and from nowhere else.
 *
 * @returns whether every transaction confirmed
 */
export async function runSequential<Receipt extends { readonly status: "success" | "reverted" }>(
  request: Extract<ExecutionRequest, { mode: "sequential" }>,
  deps: SequentialDependencies<Receipt>,
): Promise<boolean> {
  for (const [index, transaction] of request.transactions.entries()) {
    const refusal = await deps.recheck(index);
    if (refusal !== null) {
      deps.dispatch({ type: "stopped", before: index, refusal });
      return false;
    }
    const driver = deps.driver(transaction, index);
    let confirmed = false;
    const receipt = await runTransaction<Receipt, ReceiptsCheck>(
      {
        ...driver,
        verify: async (mined) => {
          const outcome: Verification<ReceiptsCheck> = await driver.verify(mined);
          confirmed = outcome.ok;
          return outcome;
        },
      },
      (event) => deps.dispatch({ type: "step", index, event }),
    );
    if (receipt === null || !confirmed) return false;
  }
  return true;
}

/** The hashes of the transactions of a sequential run that reached the chain, in order. */
export function sentHashes(progress: SequentialProgress): Hex[] {
  return [...progress.steps, progress.attestation].flatMap((step) => ("hash" in step ? [step.hash] : []));
}

/** The outcome of an atomic batch, as `waitForCallsStatus` reports it, reduced to what the state machine needs. */
export interface BatchReceipt {
  /** `success` only when the wallet reports the batch as succeeded (2xx) and every receipt succeeded. */
  readonly status: "success" | "reverted";
  /** The wallet's status code (EIP-5792): 2xx succeeded, 4xx failed offchain, 5xx reverted, 6xx partially. */
  readonly statusCode: number;
  readonly receipts: readonly {
    readonly status: "success" | "reverted";
    readonly transactionHash: Hex;
    readonly blockNumber: bigint;
    readonly logs: readonly { readonly address: Hex; readonly data: Hex; readonly topics: readonly Hex[] }[];
  }[];
}

/**
 * Reads a final batch status. Pending, or a status the EIP does not define, is `null`: no outcome yet, which the
 * machine reports as not found in time. A batch is a success only with a 2xx code and every receipt successful.
 */
export function batchOutcome(status: {
  readonly statusCode: number;
  readonly receipts?: BatchReceipt["receipts"] | undefined;
}): BatchReceipt | null {
  const { statusCode } = status;
  const receipts = status.receipts ?? [];
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 700) return null;
  const succeeded =
    statusCode < 300 && receipts.length > 0 && receipts.every((receipt) => receipt.status === "success");
  return { status: succeeded ? "success" : "reverted", statusCode, receipts };
}

"use client";

import { rebalanceLogAbi } from "@equityos/contracts-abi";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { type Abi, erc20Abi, type Hex, type TransactionReceipt } from "viem";
import { useConfig } from "wagmi";
import { sendCalls, sendTransaction, waitForCallsStatus } from "wagmi/actions";
import { appendHistory, browserStore, type HistoryResult } from "@/lib/execution/history";
import {
  type BatchKind,
  type BatchReceipt,
  type BatchState,
  batchOutcome,
  batchResult,
  runSequential,
  type SequentialAction,
  type SequentialProgress,
  sequentialReducer,
  sequentialResult,
  sequentialStart,
  type StepState,
  summarizeSequential,
} from "@/lib/execution/progress";
import { checkBatchReceipts, checkTransactionReceipt, type ReceiptsCheck } from "@/lib/execution/receipts";
import {
  type AttestationRefusal,
  buildAttestationRequest,
  type ExecutionRequest,
  type SequentialTransaction,
  sendPreconditions,
} from "@/lib/execution/request";
import type { ExecutionSnapshot } from "@/lib/execution/snapshot";
import type { VerifiedCall } from "@/lib/execution/verify";
import { classifyTxError } from "@/lib/tx/errors";
import { TX_IDLE, type TxEvent, txReducer } from "@/lib/tx/machine";
import { runTransaction, type TxDriver } from "@/lib/tx/run";
import { RECEIPT_TIMEOUT_MS, waitForReceipt } from "@/lib/tx/use-transaction";
import { readChainTime, readWallet } from "./chain";
import { callTitle, type TokenLabels } from "./labels";

/** Errors of the contracts an execution calls, for decoding a refusal of the wallet or the node. */
const EXECUTION_ABI: Abi = [...erc20Abi, ...rebalanceLogAbi];

type Sequential = { readonly request: Extract<ExecutionRequest, { mode: "sequential" }> } & SequentialProgress;

export type ExecutionState =
  | { readonly mode: "none" }
  | {
      readonly mode: "atomic";
      readonly request: Extract<ExecutionRequest, { mode: "atomic" }>;
      readonly batch: BatchState;
    }
  | ({ readonly mode: "sequential" } & Sequential);

type Action =
  | { readonly type: "start_atomic"; readonly request: Extract<ExecutionRequest, { mode: "atomic" }> }
  | { readonly type: "start_sequential"; readonly request: Extract<ExecutionRequest, { mode: "sequential" }> }
  | { readonly type: "batch"; readonly event: TxEvent<ReceiptsCheck, string> }
  | { readonly type: "sequential"; readonly action: SequentialAction }
  | { readonly type: "reset" };

function reducer(state: ExecutionState, action: Action): ExecutionState {
  switch (action.type) {
    case "start_atomic":
      return { mode: "atomic", request: action.request, batch: TX_IDLE };
    case "start_sequential":
      return { mode: "sequential", request: action.request, ...sequentialStart(action.request.transactions.length) };
    case "batch":
      return state.mode === "atomic" ? { ...state, batch: txReducer(state.batch, action.event) } : state;
    case "sequential": {
      if (state.mode !== "sequential") return state;
      const { request, ...progress } = state;
      return { mode: "sequential", request, ...sequentialReducer(progress, action.action) };
    }
    case "reset":
      return { mode: "none" };
  }
}

const IN_FLIGHT: readonly StepState["status"][] = ["awaiting_signature", "submitted", "verifying"];

/** Whether anything of the execution is with the wallet or the chain now. */
export function executionInFlight(state: ExecutionState): boolean {
  if (state.mode === "atomic") return IN_FLIGHT.includes(state.batch.status);
  if (state.mode === "sequential") {
    return [...state.steps, state.attestation].some((step) => IN_FLIGHT.includes(step.status));
  }
  return false;
}

/**
 * Whether the snapshot was used: something reached the chain, or is with the wallet. A used snapshot is never
 * sent again; a plan whose request ended with nothing sent (declined, refused by the wallet) can be signed again.
 */
export function snapshotSpent(state: ExecutionState): boolean {
  const reached = (step: StepState | BatchState) =>
    step.status !== "idle" && step.status !== "rejected" && step.status !== "failed";
  if (state.mode === "atomic") return reached(state.batch);
  if (state.mode === "sequential") return state.stopped !== null || state.steps.some(reached);
  return false;
}

function callOf(snapshot: ExecutionSnapshot, index: number): VerifiedCall | null {
  return snapshot.verification.ok ? (snapshot.verification.calls[index] ?? null) : null;
}

/**
 * Sends an execution request and follows it. `execute` is called from the click handler of the button whose
 * label says what is signed, with the request `buildExecutionRequest` returned for that click; this hook never
 * sends on its own and never builds a request itself.
 *
 * Leaving the page stops a sequential run before its next transaction: no further signature is asked for. Each
 * run is recorded in this browser's history when it ends, including where it stopped.
 */
export function useExecution(snapshot: ExecutionSnapshot, tokens: TokenLabels) {
  const config = useConfig();
  const [state, dispatch] = useReducer(reducer, { mode: "none" });
  const [running, setRunning] = useState(false);
  const [batchKind, setBatchKind] = useState<BatchKind | null>(null);
  /** The transactions a final batch status reported, whatever its outcome. */
  const [batchHashes, setBatchHashes] = useState<readonly Hex[]>([]);
  const reportedHashes = useRef<readonly Hex[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const started = useRef(false);
  const attestStarted = useRef(false);
  const mounted = useRef(true);
  // The latest state of a run, outside React, for the decisions taken in callbacks and for the history.
  const latest = useRef<ExecutionState>({ mode: "none" });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const apply = useCallback((action: Action) => {
    latest.current = reducer(latest.current, action);
    dispatch(action);
  }, []);

  const label = useCallback(
    (index: number) => {
      const call = snapshot.verification.ok ? snapshot.verification.calls[index] : undefined;
      return call === undefined ? `Call ${index + 1}` : callTitle(call, tokens);
    },
    [snapshot, tokens],
  );

  /** Records the run in this browser, replacing an earlier record of the same plan. */
  const record = useCallback(
    (result: HistoryResult | null) => {
      const current = latest.current;
      if (result === null || current.mode === "none" || snapshot.plan.planHash === null) return;
      const attestation =
        current.mode === "atomic"
          ? current.batch.status === "confirmed"
            ? (current.batch.result.attestation?.transactionHash ?? null)
            : null
          : current.attestation.status === "confirmed"
            ? (current.attestation.result.attestation?.transactionHash ?? null)
            : null;
      appendHistory(browserStore(), {
        at: Date.now(),
        chainId: snapshot.plan.chainId,
        account: snapshot.account,
        index: snapshot.plan.index,
        planHash: snapshot.plan.planHash,
        mode: current.mode,
        result,
        transactions:
          current.mode === "atomic" && current.batch.status !== "confirmed"
            ? reportedHashes.current.map((hash) => ({ hash, label: "Batch" }))
            : sentTransactions(current, label),
        attestation,
        stoppedBefore: current.mode === "sequential" ? (current.stopped?.before ?? null) : null,
      });
      setHistoryVersion((version) => version + 1);
    },
    [snapshot, label],
  );

  const transactionDriver = useCallback(
    (
      transaction: SequentialTransaction,
      expected: { readonly call: VerifiedCall | null; readonly attestation: boolean },
    ): TxDriver<TransactionReceipt, ReceiptsCheck> => ({
      send: () =>
        sendTransaction(config, {
          account: transaction.account,
          chainId: transaction.chainId,
          to: transaction.to,
          data: transaction.data,
          value: transaction.value,
        }),
      wait: (hash, onReplaced) => waitForReceipt(config, transaction.chainId, hash, onReplaced),
      verify: async (receipt) =>
        checkTransactionReceipt(receipt, {
          account: transaction.account,
          to: transaction.to,
          call: expected.call,
          attestation:
            expected.attestation && snapshot.attestation.status === "included" ? snapshot.attestation.call : null,
        }),
      classify: (error) => classifyTxError(EXECUTION_ABI, error),
    }),
    [config, snapshot],
  );

  const execute = useCallback(
    async (request: ExecutionRequest) => {
      if (started.current) return;
      started.current = true;
      setRunning(true);
      try {
        if (request.mode === "atomic") {
          apply({ type: "start_atomic", request });
          const calls = snapshot.verification.ok ? snapshot.verification.calls : [];
          let kind: BatchKind | null = null;
          const driver: TxDriver<BatchReceipt, ReceiptsCheck, string> = {
            send: async () => {
              const { sendCalls: parameters } = request;
              const { id } = await sendCalls(config, {
                account: parameters.account,
                chainId: parameters.chainId,
                calls: parameters.calls.map(({ to, data, value }) => ({ to, data, value })),
                forceAtomic: parameters.forceAtomic,
                ...(parameters.capabilities === undefined
                  ? {}
                  : { capabilities: { dataSuffix: { ...parameters.capabilities.dataSuffix } } }),
              });
              return id;
            },
            wait: async (id) => {
              const outcome = batchOutcome(await waitForCallsStatus(config, { id, timeout: RECEIPT_TIMEOUT_MS }));
              kind = outcome?.kind ?? null;
              reportedHashes.current = outcome?.receipts.map(({ transactionHash }) => transactionHash) ?? [];
              setBatchKind(kind);
              setBatchHashes(reportedHashes.current);
              return outcome;
            },
            verify: async (outcome) =>
              checkBatchReceipts(outcome.receipts, {
                account: request.sendCalls.account,
                calls,
                attestation: snapshot.attestation.status === "included" ? snapshot.attestation.call : null,
              }),
            classify: (error) => classifyTxError(EXECUTION_ABI, error),
          };
          await runTransaction(driver, (event) => apply({ type: "batch", event }));
          const current = latest.current;
          if (current.mode === "atomic") record(batchResult(current.batch, kind));
          return;
        }
        apply({ type: "start_sequential", request });
        await runSequential<TransactionReceipt>(request, {
          recheck: async () => {
            if (!mounted.current) return { reason: "left_page" };
            const [chainTime, wallet] = await Promise.all([
              readChainTime(config, request.chainId).catch(() => null),
              readWallet(config),
            ]);
            return sendPreconditions(
              { account: request.account, chainId: request.chainId, expiresAt: request.expiresAt },
              wallet.address,
              wallet.chainId,
              chainTime,
            );
          },
          driver: (transaction, index) =>
            transactionDriver(transaction, { call: callOf(snapshot, index), attestation: false }),
          dispatch: (action) => apply({ type: "sequential", action }),
        });
        const current = latest.current;
        if (current.mode === "sequential") record(sequentialResult(current));
      } finally {
        if (mounted.current) setRunning(false);
      }
    },
    [config, snapshot, transactionDriver, apply, record],
  );

  /**
   * After a declined or refused request with nothing sent, lets the same verified plan be signed again. Never
   * after anything reached the chain.
   */
  const retry = useCallback(() => {
    if (snapshotSpent(latest.current) || executionInFlight(latest.current)) return;
    started.current = false;
    apply({ type: "reset" });
  }, [apply]);

  /**
   * Sends the optional attestation of the sequential path. The decision is taken again at the click, with the
   * account and the network of that moment, and at most one attestation is ever requested. Returns the refusal
   * when it may not be sent.
   */
  const attest = useCallback(async (): Promise<AttestationRefusal | null> => {
    const current = latest.current;
    if (current.mode !== "sequential") return { reason: "not_included" };
    // Claimed before anything is awaited, so a second click is refused while the first one decides or sends.
    if (attestStarted.current || executionInFlight(current)) return { reason: "busy" };
    attestStarted.current = true;
    const wallet = await readWallet(config);
    const decision = buildAttestationRequest(
      current.request,
      summarizeSequential(current).confirmed.length,
      wallet.address,
      wallet.chainId,
      false,
    );
    if (!decision.ok) {
      attestStarted.current = false;
      return decision.refusal;
    }
    setRunning(true);
    try {
      await runTransaction(transactionDriver(decision.transaction, { call: null, attestation: true }), (event) =>
        apply({ type: "sequential", action: { type: "attestation", event } }),
      );
      const after = latest.current;
      if (after.mode !== "sequential") return null;
      // A request that ended with nothing sent can be made again; anything that reached the chain cannot.
      if (after.attestation.status === "rejected" || after.attestation.status === "failed")
        attestStarted.current = false;
      else record(sequentialResult(after));
      return null;
    } finally {
      if (mounted.current) setRunning(false);
    }
  }, [config, transactionDriver, apply, record]);

  return { state, execute, attest, retry, running, batchKind, batchHashes, historyVersion };
}

/** The transactions of an execution that reached the chain, with what each did. */
export function sentTransactions(
  state: ExecutionState,
  label: (index: number) => string,
): { readonly hash: Hex; readonly label: string }[] {
  if (state.mode === "sequential") {
    const steps = state.steps.flatMap((step, index) =>
      "hash" in step ? [{ hash: step.hash, label: label(index) }] : [],
    );
    const attestation =
      "hash" in state.attestation ? [{ hash: state.attestation.hash, label: "Record the rebalance" }] : [];
    return [...steps, ...attestation];
  }
  if (state.mode === "atomic" && state.batch.status === "confirmed") {
    return state.batch.result.transactionHashes.map((hash) => ({ hash, label: "Batch" }));
  }
  return [];
}

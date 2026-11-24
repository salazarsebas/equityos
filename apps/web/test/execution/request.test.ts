import { describe, expect, test } from "bun:test";
import { DEPLOYMENTS, LOCAL_CHAIN_ID, rebalanceLogAbi } from "@equityos/contracts-abi";
import { type Address, decodeFunctionData, type Hex } from "viem";
import { AMZN, buildReadyPlan, chainReadsFor, DIVERSIFIED, NVDA, TSLA, USDC } from "../../e2e/execution-plans";
import { builderCodeSuffix } from "../../src/lib/execution/builder-code";
import { executionNetwork } from "../../src/lib/execution/networks";
import {
  type Acknowledgements,
  buildAttestationRequest,
  buildExecutionRequest,
  type ExecutionDecision,
  type ExecutionGate,
  sendPreconditions,
} from "../../src/lib/execution/request";
import { parseExecutionPlan } from "../../src/lib/execution/response";
import { type ExecutionSnapshot, takeExecutionSnapshot } from "../../src/lib/execution/snapshot";
import type { Batching } from "../../src/lib/wallet/capabilities";

const ACCOUNT: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const EXPIRES = 1_800_000_000;
const CONSTITUENTS = [
  TSLA,
  AMZN,
  NVDA,
  "0xb200000000000000000000c2e324d24d7eecd1fb",
  "0xb200000000000000000000d9192b6b456483c2e8",
] as Address[];
const ATOMIC: Batching = { mode: "atomic", reason: "atomic_supported" };
const SEQUENTIAL: Batching = { mode: "sequential", reason: "atomic_unsupported" };
const UNKNOWN: Batching = { mode: "unknown", reason: "request_failed" };
const OPEN: ExecutionGate = { executionAvailable: true, busy: false };
const SUFFIX = builderCodeSuffix("bc_test123");

function body(chainId: number) {
  return buildReadyPlan({
    account: ACCOUNT,
    chainId,
    expiresAt: EXPIRES,
    legs: [
      { side: "sell", token: NVDA, symbol: "NVDAc", amountIn: 400_000_000n, quotedAmountOut: 519_000_000n },
      { side: "buy", token: TSLA, symbol: "TSLAc", amountIn: 300_000_000n, quotedAmountOut: 77_000_000n },
    ],
    balances: { [USDC]: 250_500_000n, [NVDA]: 2_464_860_328n },
    warnings: [
      ["reference_freshness", "delayed", 1],
      ["allowance", "above_plan", null],
    ],
  });
}

function snapshot(
  options: {
    chainId?: number;
    suffix?: Hex | null;
    logCode?: Hex | null;
    mutate?: (data: ReturnType<typeof body>["data"]) => void;
  } = {},
): ExecutionSnapshot {
  const chainId = options.chainId ?? LOCAL_CHAIN_ID;
  const answer = structuredClone(body(chainId));
  options.mutate?.(answer.data);
  const plan = parseExecutionPlan(answer);
  return takeExecutionSnapshot({
    plan,
    index: { indexId: DIVERSIFIED.indexId, version: DIVERSIFIED.version },
    market: chainReadsFor(plan),
    account: ACCOUNT,
    network: executionNetwork(chainId, { NODE_ENV: "development" }),
    constituents: CONSTITUENTS,
    logCode: options.logCode === undefined ? "0x6080" : options.logCode,
    suffix: options.suffix === undefined ? null : options.suffix,
  });
}

function acknowledgeAll(shot: ExecutionSnapshot): Acknowledgements {
  return { planHash: shot.plan.planHash ?? "0x", keys: new Set(shot.warningKeys) };
}

function decide(
  shot: ExecutionSnapshot | null,
  overrides: {
    account?: Address | null;
    chainId?: number | null;
    batching?: Batching;
    acknowledgements?: Acknowledgements | null;
    now?: number | null;
    gate?: ExecutionGate;
  } = {},
): ExecutionDecision {
  return buildExecutionRequest(
    shot,
    overrides.account === undefined ? ACCOUNT : overrides.account,
    overrides.chainId === undefined ? (shot?.plan.chainId ?? null) : overrides.chainId,
    overrides.batching ?? ATOMIC,
    overrides.acknowledgements === undefined
      ? shot === null
        ? null
        : acknowledgeAll(shot)
      : overrides.acknowledgements,
    overrides.now === undefined ? EXPIRES - 60 : overrides.now,
    overrides.gate ?? OPEN,
  );
}

function reason(decision: ExecutionDecision): string {
  return decision.ok ? "ok" : decision.refusal.reason;
}

describe("buildExecutionRequest refuses", () => {
  test("without a plan", () => {
    expect(reason(decide(null))).toBe("no_plan");
  });

  test("when execution is unavailable, before anything else of the plan", () => {
    expect(reason(decide(snapshot(), { gate: { executionAvailable: false, busy: false } }))).toBe(
      "execution_unavailable",
    );
  });

  test("while a request is in flight or after one was sent", () => {
    expect(reason(decide(snapshot(), { gate: { executionAvailable: true, busy: true } }))).toBe("busy");
  });

  test("a plan that did not verify in the browser, with its failures", () => {
    const shot = snapshot({
      mutate: (data) => {
        const leg = data.legs[0];
        if (leg) leg.quote.minAmountOut = "1";
      },
    });
    const decision = decide(shot);
    expect(reason(decision)).toBe("verification_failed");
    expect(
      !decision.ok && decision.refusal.reason === "verification_failed" && decision.refusal.failures[0]?.code,
    ).toBe("swap_mismatch");
  });

  test("a plan whose server hash differs from the hash recomputed here", () => {
    const shot = snapshot({ mutate: (data) => Object.assign(data, { planHash: `0x${"cd".repeat(32)}` }) });
    expect(
      reason(
        decide(shot, { acknowledgements: { planHash: `0x${"cd".repeat(32)}`, keys: new Set(snapshot().warningKeys) } }),
      ),
    ).toBe("hash_mismatch");
  });

  test("another account, or none", () => {
    expect(reason(decide(snapshot(), { account: OTHER }))).toBe("wrong_account");
    expect(reason(decide(snapshot(), { account: null }))).toBe("wrong_account");
    expect(reason(decide(snapshot(), { account: ACCOUNT.toLowerCase() as Address }))).toBe("ok");
  });

  test("another network, or none", () => {
    expect(decide(snapshot(), { chainId: 8453 })).toEqual({
      ok: false,
      refusal: { reason: "wrong_network", walletChainId: 8453, chainId: LOCAL_CHAIN_ID },
    });
    expect(reason(decide(snapshot(), { chainId: null }))).toBe("wrong_network");
  });

  test("at and after the expiry by chain time, and when the chain time is unknown", () => {
    expect(decide(snapshot(), { now: EXPIRES })).toEqual({
      ok: false,
      refusal: { reason: "expired", expiresAt: EXPIRES, chainTime: EXPIRES },
    });
    expect(reason(decide(snapshot(), { now: EXPIRES + 1 }))).toBe("expired");
    expect(reason(decide(snapshot(), { now: EXPIRES - 1 }))).toBe("ok");
    expect(reason(decide(snapshot(), { now: null }))).toBe("chain_time_unknown");
  });

  test("until every warning is acknowledged, each on its own, for this plan", () => {
    const shot = snapshot();
    const [first, second] = shot.warningKeys;
    expect(shot.warningKeys).toHaveLength(2);
    expect(decide(shot, { acknowledgements: null })).toEqual({
      ok: false,
      refusal: { reason: "warnings_not_acknowledged", missing: [first ?? "", second ?? ""] },
    });
    const one = { planHash: shot.plan.planHash ?? "0x", keys: new Set([first ?? ""]) };
    expect(decide(shot, { acknowledgements: one })).toEqual({
      ok: false,
      refusal: { reason: "warnings_not_acknowledged", missing: [second ?? ""] },
    });
    const otherPlan = { planHash: `0x${"ef".repeat(32)}` as Hex, keys: new Set(shot.warningKeys) };
    expect(reason(decide(shot, { acknowledgements: otherPlan }))).toBe("warnings_not_acknowledged");
  });

  test("a plan without warnings needs no acknowledgement", () => {
    const shot = snapshot({
      mutate: (data) => {
        data.warnings = [];
        data.checks = data.checks.filter(({ status }) => status !== "warn");
      },
    });
    expect(reason(decide(shot, { acknowledgements: null }))).toBe("ok");
  });
});

describe("buildExecutionRequest, atomic", () => {
  test("one sendCalls with every call in order, atomicRequired, and the attestation last", () => {
    const shot = snapshot();
    const decision = decide(shot);
    if (!decision.ok || decision.request.mode !== "atomic") throw new Error(reason(decision));
    const { sendCalls, steps } = decision.request;
    expect(sendCalls.forceAtomic).toBe(true);
    expect(sendCalls.account).toBe(ACCOUNT);
    expect(sendCalls.chainId).toBe(LOCAL_CHAIN_ID);
    expect(sendCalls.capabilities).toBeUndefined();
    const plan = shot.plan.calls ?? [];
    expect(sendCalls.calls.slice(0, plan.length)).toEqual(plan.map(({ to, data, value }) => ({ to, data, value })));
    const last = sendCalls.calls.at(-1);
    expect(last?.to).toBe(DEPLOYMENTS[LOCAL_CHAIN_ID].rebalanceLog.toLowerCase() as Address);
    const decoded = decodeFunctionData({ abi: rebalanceLogAbi, data: last?.data ?? "0x" });
    expect(decoded.functionName).toBe("recordRebalance");
    expect(decoded.args).toEqual([DIVERSIFIED.indexId, DIVERSIFIED.version]);
    expect(steps.map(({ kind }) => kind)).toEqual(["approve", "approve", "swap", "swap", "attestation"]);
  });

  test("the Builder Code goes in the dataSuffix capability, optional, and never into the calls", () => {
    const decision = decide(snapshot({ suffix: SUFFIX }));
    if (!decision.ok || decision.request.mode !== "atomic") throw new Error(reason(decision));
    expect(decision.request.sendCalls.capabilities).toEqual({ dataSuffix: { value: SUFFIX ?? "0x", optional: true } });
    for (const call of decision.request.sendCalls.calls) expect(call.data.endsWith("80218021")).toBe(false);
  });

  test("no attestation where the log is not deployed", () => {
    const decision = decide(snapshot({ chainId: 8453 }));
    if (!decision.ok || decision.request.mode !== "atomic") throw new Error(reason(decision));
    expect(decision.request.steps.some(({ kind }) => kind === "attestation")).toBe(false);
    expect(decision.request.sendCalls.calls).toHaveLength(4);
  });
});

describe("buildExecutionRequest, sequential", () => {
  test("a sequential or undetermined wallet gets the ordered transactions, and the attestation apart", () => {
    for (const batching of [SEQUENTIAL, UNKNOWN]) {
      const shot = snapshot();
      const decision = decide(shot, { batching });
      if (!decision.ok || decision.request.mode !== "sequential") throw new Error(reason(decision));
      const plan = shot.plan.calls ?? [];
      expect(decision.request.transactions.map(({ to, data }) => ({ to, data }))).toEqual(
        plan.map(({ to, data }) => ({ to, data })),
      );
      for (const transaction of decision.request.transactions) {
        expect(transaction).toMatchObject({ account: ACCOUNT, chainId: LOCAL_CHAIN_ID });
      }
      expect(decision.request.attestation?.to).toBe(DEPLOYMENTS[LOCAL_CHAIN_ID].rebalanceLog.toLowerCase() as Address);
    }
  });

  test("the Builder Code suffix is appended to every transaction when configured, and only then", () => {
    const shot = snapshot({ suffix: SUFFIX });
    const decision = decide(shot, { batching: SEQUENTIAL });
    if (!decision.ok || decision.request.mode !== "sequential" || SUFFIX === null) throw new Error(reason(decision));
    const plan = shot.plan.calls ?? [];
    decision.request.transactions.forEach((transaction, index) => {
      expect(transaction.data).toBe(`${plan[index]?.data}${SUFFIX.slice(2)}` as Hex);
    });
    expect(decision.request.attestation?.data.endsWith(SUFFIX.slice(2))).toBe(true);
  });
});

describe("sendPreconditions before each sequential transaction", () => {
  const target = { account: ACCOUNT, chainId: LOCAL_CHAIN_ID, expiresAt: EXPIRES };
  test("refuses a changed account, a changed chain and an expired plan", () => {
    expect(sendPreconditions(target, ACCOUNT, LOCAL_CHAIN_ID, EXPIRES - 1)).toBeNull();
    expect(sendPreconditions(target, OTHER, LOCAL_CHAIN_ID, EXPIRES - 1)?.reason).toBe("wrong_account");
    expect(sendPreconditions(target, ACCOUNT, 8453, EXPIRES - 1)?.reason).toBe("wrong_network");
    expect(sendPreconditions(target, ACCOUNT, LOCAL_CHAIN_ID, EXPIRES)?.reason).toBe("expired");
    expect(sendPreconditions(target, ACCOUNT, LOCAL_CHAIN_ID, null)?.reason).toBe("chain_time_unknown");
  });
});

describe("buildAttestationRequest", () => {
  const decision = decide(snapshot(), { batching: SEQUENTIAL });
  if (!decision.ok) throw new Error(reason(decision));
  const { request } = decision;
  const all = request.mode === "sequential" ? request.transactions.length : 0;

  test("is offered only after every transaction confirmed, from the same account and network", () => {
    expect(buildAttestationRequest(request, all, ACCOUNT, LOCAL_CHAIN_ID, false).ok).toBe(true);
    expect(buildAttestationRequest(request, all - 1, ACCOUNT, LOCAL_CHAIN_ID, false)).toEqual({
      ok: false,
      refusal: { reason: "swaps_not_confirmed" },
    });
    expect(buildAttestationRequest(request, all, ACCOUNT, LOCAL_CHAIN_ID, true).ok).toBe(false);
    expect(buildAttestationRequest(request, all, OTHER, LOCAL_CHAIN_ID, false).ok).toBe(false);
    expect(buildAttestationRequest(request, all, ACCOUNT, 8453, false).ok).toBe(false);
  });

  test("is never built for an atomic request, which carries it in the batch", () => {
    const atomic = decide(snapshot());
    if (!atomic.ok) throw new Error(reason(atomic));
    expect(buildAttestationRequest(atomic.request, 5, ACCOUNT, LOCAL_CHAIN_ID, false)).toEqual({
      ok: false,
      refusal: { reason: "not_included" },
    });
  });
});

describe("the snapshot", () => {
  test("is frozen: no call can be edited after it was verified", () => {
    const shot = snapshot();
    const calls = shot.verification.ok ? shot.verification.calls : [];
    expect(Object.isFrozen(shot)).toBe(true);
    expect(Object.isFrozen(calls)).toBe(true);
    expect(Reflect.set(calls, 0, { to: OTHER })).toBe(false);
  });
});

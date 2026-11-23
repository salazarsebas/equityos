import { describe, expect, test } from "bun:test";
import { indexRegistryAbi } from "@equityos/contracts-abi";
import type { Address } from "viem";
import { evaluateDraft } from "../../src/lib/studio/evaluate";
import type { ChecklistItem } from "../../src/lib/studio/preflight";
import { buildPublishPlan, type NetworkPolicy, type PublishPlan } from "../../src/lib/studio/publish";
import {
  acknowledgementEnds,
  buildPublishRequest,
  type PublishDecision,
  type PublishDecisionInput,
  publishPlanKey,
} from "../../src/lib/studio/request";
import type { TxState } from "../../src/lib/tx/machine";
import { ASSETS, CHAIN_ID, SALT, validDraft } from "./support";

const REGISTRY: Address = "0x4BD4D49A9C88f75FB97674488E23A7Fa59F9506c";
const CREATOR: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const deployment = { registry: REGISTRY, rebalanceLog: REGISTRY, deployBlock: 0n } as const;
const local: NetworkPolicy = { status: "available", deployment, requiresAcknowledgement: false };
const mainnet: NetworkPolicy = { status: "available", deployment, requiresAcknowledgement: true };

function plan(overrides: Partial<Parameters<typeof buildPublishPlan>[0]> = {}, name = "Test Index"): PublishPlan {
  const { valid } = evaluateDraft(validDraft({ name }), ASSETS);
  if (valid === null) throw new Error("expected a valid draft");
  return buildPublishPlan({ valid, chainId: CHAIN_ID, registry: REGISTRY, creator: CREATOR, salt: SALT, ...overrides });
}

const IDS: readonly ChecklistItem["id"][] = [
  "spec",
  "hash",
  "wallet",
  "network",
  "registry",
  "index_id",
  "simulation",
  "fee",
  "balance",
];
const done: ChecklistItem[] = IDS.map((id) => ({ id, label: id, state: "done", detail: "" }));

function input(overrides: Partial<PublishDecisionInput> = {}): PublishDecisionInput {
  return {
    plan: plan(),
    policy: local,
    acknowledgement: null,
    walletChainId: CHAIN_ID,
    checklist: done,
    busy: false,
    ...overrides,
  };
}

describe("buildPublishRequest", () => {
  test("returns exactly the createIndex call of the plan, on the plan's chain", () => {
    const p = plan();
    const decision = buildPublishRequest(input({ plan: p }));
    expect(decision).toEqual({
      ok: true,
      plan: p,
      request: {
        chainId: CHAIN_ID,
        account: CREATOR,
        address: REGISTRY,
        abi: indexRegistryAbi,
        functionName: "createIndex",
        args: p.args,
      },
    });
    if (decision.ok) {
      expect(decision.request.args[1]).toBe(p.specHex);
      expect(decision.request.args[0]).toBe(SALT);
    }
  });

  test("the chain of the request is the plan's, whatever the wallet reported earlier", () => {
    const sepolia = plan({ chainId: 84_532 });
    const decision = buildPublishRequest(input({ plan: sepolia, walletChainId: 84_532 }));
    expect(decision.ok && decision.request.chainId).toBe(84_532);
  });

  test("refuses without a plan", () => {
    expect(buildPublishRequest(input({ plan: null }))).toEqual({ ok: false, refusal: { reason: "no_plan" } });
  });

  test("refuses where the registry is not deployed", () => {
    expect(buildPublishRequest(input({ policy: { status: "not_deployed" } }))).toEqual({
      ok: false,
      refusal: { reason: "not_available" },
    });
  });

  test("refuses a plan for another registry than the deployment", () => {
    expect(buildPublishRequest(input({ plan: plan({ registry: OTHER }) }))).toEqual({
      ok: false,
      refusal: { reason: "registry_mismatch" },
    });
  });

  test("refuses while a transaction is in flight or after one was mined", () => {
    expect(buildPublishRequest(input({ busy: true }))).toEqual({ ok: false, refusal: { reason: "busy" } });
  });

  test("refuses when the wallet is on another chain or reports none", () => {
    expect(buildPublishRequest(input({ walletChainId: 8453 }))).toEqual({
      ok: false,
      refusal: { reason: "wrong_network", walletChainId: 8453 },
    });
    expect(buildPublishRequest(input({ walletChainId: null }))).toEqual({
      ok: false,
      refusal: { reason: "wrong_network", walletChainId: null },
    });
  });

  test("refuses unless every check is done, and names the ones that are not", () => {
    for (const state of ["todo", "blocked", "checking", "waiting"] as const) {
      const checklist = done.map((item) => (item.id === "simulation" ? { ...item, state } : item));
      expect(buildPublishRequest(input({ checklist }))).toEqual({
        ok: false,
        refusal: { reason: "checks_incomplete", items: ["simulation"] },
      });
    }
    expect(buildPublishRequest(input({ checklist: [] }))).toEqual({
      ok: false,
      refusal: { reason: "checks_incomplete", items: [] },
    });
  });

  test("on a network that requires it, refuses without the acknowledgement of this exact plan", () => {
    const p = plan({ chainId: 8453 });
    const onMainnet = { plan: p, policy: mainnet, walletChainId: 8453 };
    const missing: PublishDecision = { ok: false, refusal: { reason: "acknowledgement_missing" } };
    expect(buildPublishRequest(input({ ...onMainnet, acknowledgement: null }))).toEqual(missing);
    // Given for another draft, another salt or another account: void.
    for (const other of [
      plan({ chainId: 8453 }, "Another Index"),
      plan({ chainId: 8453, salt: `0x${"5b".repeat(32)}` }),
      plan({ chainId: 8453, creator: OTHER }),
    ]) {
      expect(buildPublishRequest(input({ ...onMainnet, acknowledgement: { planKey: publishPlanKey(other) } }))).toEqual(
        missing,
      );
    }
    const given = buildPublishRequest(input({ ...onMainnet, acknowledgement: { planKey: publishPlanKey(p) } }));
    expect(given.ok).toBe(true);
  });

  test("a network that does not require the acknowledgement ignores it", () => {
    expect(buildPublishRequest(input({ acknowledgement: null })).ok).toBe(true);
  });
});

describe("publishPlanKey", () => {
  test("changes with everything the transaction depends on", () => {
    const keys = new Set(
      [
        plan(),
        plan({ chainId: 84_532 }),
        plan({ registry: OTHER }),
        plan({ creator: OTHER }),
        plan({ salt: `0x${"5b".repeat(32)}` }),
        plan({}, "Another Index"),
      ].map(publishPlanKey),
    );
    expect(keys.size).toBe(6);
    expect(publishPlanKey(plan())).toBe(publishPlanKey(plan()));
  });
});

describe("acknowledgementEnds", () => {
  test("every attempt that ended without publishing withdraws the acknowledgement", () => {
    const hash = `0x${"a1".repeat(32)}` as const;
    const ends: TxState<null>[] = [
      { status: "rejected" },
      { status: "failed", failure: { kind: "unknown" } },
      { status: "reverted", hash },
      { status: "replaced", hash, replacement: hash, reason: "cancelled" },
      { status: "dropped", hash },
    ];
    for (const state of ends) expect(acknowledgementEnds(state)).toBe(true);
    const keeps: TxState<null>[] = [
      { status: "idle" },
      { status: "awaiting_signature" },
      { status: "submitted", hash, repriced: false },
      { status: "verifying", hash },
      { status: "confirmed", hash, result: null },
      { status: "unverified", hash, reason: "x" },
    ];
    for (const state of keeps) expect(acknowledgementEnds(state)).toBe(false);
  });
});

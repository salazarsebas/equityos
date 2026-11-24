import { describe, expect, test } from "bun:test";
import { indexRegistryAbi } from "@equityos/contracts-abi";
import type { Address } from "viem";
import { evaluateDraft } from "../../src/lib/studio/evaluate";
import type { ChecklistItem } from "../../src/lib/studio/preflight";
import type { OnchainIndex } from "../../src/lib/studio/preflight";
import {
  buildPublishPlan,
  buildVersionPlan,
  type NetworkPolicy,
  type PublishPlan,
  type VersionPlan,
} from "../../src/lib/studio/publish";
import {
  acknowledgementEnds,
  buildPublishRequest,
  decideAtClick,
  type PublishDecision,
  type PublishDecisionInput,
  publishPlanKey,
} from "../../src/lib/studio/request";
import type { TxState } from "../../src/lib/tx/machine";
import { ASSETS, CHAIN_ID, INDEX_ID, SALT, validDraft, versionTarget } from "./support";

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
    index: null,
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

describe("buildPublishRequest for a new version", () => {
  const target = versionTarget(CREATOR, REGISTRY);
  const INDEX: OnchainIndex = { creator: CREATOR, latestVersion: 1, deprecated: false };
  function versionPlan(name = "Test Index Two", creator = CREATOR): VersionPlan {
    const { valid } = evaluateDraft(validDraft({ name }), ASSETS);
    if (valid === null) throw new Error("expected a valid draft");
    return buildVersionPlan({ valid, target, creator });
  }
  const versionInput = (overrides: Partial<PublishDecisionInput> = {}) =>
    input({ plan: versionPlan(), index: INDEX, ...overrides });

  test("returns exactly the publishVersion call of the plan, with the expected version one above the base", () => {
    const p = versionPlan();
    const decision = buildPublishRequest(versionInput({ plan: p }));
    expect(decision).toEqual({
      ok: true,
      plan: p,
      request: {
        chainId: CHAIN_ID,
        account: CREATOR,
        address: REGISTRY,
        abi: indexRegistryAbi,
        functionName: "publishVersion",
        args: [INDEX_ID, 2, p.specHex, p.constituents.map(({ token }) => token), [3334, 3333, 3333]],
      },
    });
  });

  test("the function is the plan's: a new index is never sent as a version, nor the reverse", () => {
    const created = buildPublishRequest(input({ index: INDEX }));
    const versioned = buildPublishRequest(versionInput());
    expect(created.ok && created.request.functionName).toBe("createIndex");
    expect(versioned.ok && versioned.request.functionName).toBe("publishVersion");
    expect(versioned.ok && versioned.request.args[0]).toBe(INDEX_ID);
  });

  test("refuses the bytes of the latest version", () => {
    expect(buildPublishRequest(versionInput({ plan: versionPlan("Test Index") }))).toEqual({
      ok: false,
      refusal: { reason: "unchanged" },
    });
  });

  test("refuses an account that is not the creator", () => {
    expect(buildPublishRequest(versionInput({ plan: versionPlan("Test Index Two", OTHER) }))).toEqual({
      ok: false,
      refusal: { reason: "not_creator", creator: CREATOR },
    });
  });

  test("refuses a deprecated index", () => {
    expect(buildPublishRequest(versionInput({ index: { ...INDEX, deprecated: true } }))).toEqual({
      ok: false,
      refusal: { reason: "deprecated" },
    });
  });

  test("refuses when another version was published since the draft was loaded", () => {
    expect(buildPublishRequest(versionInput({ index: { ...INDEX, latestVersion: 2 } }))).toEqual({
      ok: false,
      refusal: { reason: "version_moved", latestVersion: 2 },
    });
  });

  test("refuses while the index has not been read", () => {
    expect(buildPublishRequest(versionInput({ index: null }))).toEqual({
      ok: false,
      refusal: { reason: "checks_incomplete", items: ["creator", "active", "version"] },
    });
  });

  test("the acknowledgement of a version is bound to its index and version", () => {
    const keys = new Set(
      [versionPlan(), { ...versionPlan(), version: 3 }, { ...versionPlan(), indexId: SALT }].map(publishPlanKey),
    );
    expect(keys.size).toBe(3);
    expect(publishPlanKey(versionPlan())).not.toBe(publishPlanKey(plan()));
  });
});

describe("decideAtClick", () => {
  const target = versionTarget(CREATOR, REGISTRY);
  const { valid } = evaluateDraft(validDraft({ name: "Test Index Two" }), ASSETS);
  if (valid === null) throw new Error("expected a valid draft");
  const p = buildVersionPlan({ valid, target, creator: CREATOR });
  const reviewed = input({ plan: p, index: { creator: CREATOR, latestVersion: 1, deprecated: false } });

  test("reads the index again, so a version published after the review is refused at the click", async () => {
    const reads: string[] = [];
    const decision = await decideAtClick(reviewed, async (read) => {
      reads.push(read.indexId);
      return { creator: CREATOR, latestVersion: 2, deprecated: false };
    });
    expect(reads).toEqual([INDEX_ID]);
    expect(decision).toEqual({ ok: false, refusal: { reason: "version_moved", latestVersion: 2 } });
  });

  test("decides with the state read at the click, not the one of the review", async () => {
    const stale = { ...reviewed, index: { creator: CREATOR, latestVersion: 5, deprecated: true } };
    const decision = await decideAtClick(stale, async () => ({
      creator: CREATOR,
      latestVersion: 1,
      deprecated: false,
    }));
    expect(decision.ok && decision.request.args[1]).toBe(2);
    expect(
      await decideAtClick(reviewed, async () => ({ creator: CREATOR, latestVersion: 1, deprecated: true })),
    ).toEqual({ ok: false, refusal: { reason: "deprecated" } });
  });

  test("a read that fails refuses", async () => {
    const decision = await decideAtClick(reviewed, async () => {
      throw new Error("unreachable");
    });
    expect(decision).toEqual({ ok: false, refusal: { reason: "index_unreadable" } });
  });

  test("a new index needs no read", async () => {
    const decision = await decideAtClick(input(), async () => {
      throw new Error("must not be called");
    });
    expect(decision.ok).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { evaluateDraft } from "../../src/lib/studio/evaluate";
import {
  type ChecklistInput,
  type Preflight,
  publishChecklist,
  type RegistryReads,
  runPreflight,
} from "../../src/lib/studio/preflight";
import { buildPublishPlan, buildVersionPlan, type NetworkPolicy } from "../../src/lib/studio/publish";
import { ASSETS, CHAIN_ID, SALT, validDraft, versionTarget } from "./support";

const REGISTRY: Address = "0x4BD4D49A9C88f75FB97674488E23A7Fa59F9506c";
const CREATOR: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const { valid } = evaluateDraft(validDraft(), ASSETS);
if (valid === null) throw new Error("expected a valid draft");
const plan = buildPublishPlan({ valid, chainId: CHAIN_ID, registry: REGISTRY, creator: CREATOR, salt: SALT });
const deployment = { registry: REGISTRY, rebalanceLog: REGISTRY, deployBlock: 0n } as const;
const local: NetworkPolicy = { status: "available", deployment, requiresAcknowledgement: false };

function reads(overrides: Partial<RegistryReads> = {}): RegistryReads & { calls: string[] } {
  const calls: string[] = [];
  const base: RegistryReads = {
    code: async () => "0x6080",
    computeIndexId: async () => plan.indexId,
    indexIds: async () => [],
    index: async () => ({ creator: CREATOR, latestVersion: 1, deprecated: false }),
    versionHash: async () => plan.specHash,
    simulate: async () => undefined,
    estimateGas: async () => 700_000n,
    maxFeePerGas: async () => 2_000_000_000n,
    balance: async () => 10n ** 18n,
    l1DataFee: async () => null,
    ...overrides,
  };
  const traced = Object.fromEntries(
    Object.entries(base).map(([name, read]) => [
      name,
      (...args: never[]) => {
        calls.push(name);
        return (read as (...args: never[]) => unknown)(...args);
      },
    ]),
  ) as unknown as RegistryReads;
  return { ...traced, calls };
}
const classify = () => ({ kind: "contract_error", name: "IndexAlreadyExists", args: [plan.indexId] }) as const;
const READY: Extract<Preflight, { status: "ready" }> = {
  status: "ready",
  index: null,
  identifier: "test-index-abcdef12",
  gas: 700_000n,
  maxFeePerGasWei: 2_000_000_000n,
  feeWei: 1_400_000_000_000_000n,
  l1FeeWei: null,
  totalFeeWei: 1_400_000_000_000_000n,
  balanceWei: 10n ** 18n,
};

describe("runPreflight", () => {
  test("a plan that passes every check is ready, with the fee as gas times the maximum fee per gas", async () => {
    const result = await runPreflight(reads(), plan, classify);
    expect(result).toEqual({ ...READY, identifier: `test-index-${plan.indexId.slice(2, 10)}` });
  });

  test("an L1 data fee is added to the execution fee", async () => {
    const result = await runPreflight(reads({ l1DataFee: async () => 600_000_000_000_000n }), plan, classify);
    expect(result).toMatchObject({
      feeWei: 1_400_000_000_000_000n,
      l1FeeWei: 600_000_000_000_000n,
      totalFeeWei: 2_000_000_000_000_000n,
    });
  });

  test("without code at the registry address nothing else is read", async () => {
    for (const code of [undefined, "0x"] as const) {
      const chain = reads({ code: async () => code });
      expect(await runPreflight(chain, plan, classify)).toEqual({ status: "no_code" });
      expect(chain.calls).toEqual(["code"]);
    }
  });

  test("an index id the registry derives differently stops before any simulation", async () => {
    const other = `0x${"cd".repeat(32)}` as const;
    const chain = reads({ computeIndexId: async () => other });
    expect(await runPreflight(chain, plan, classify)).toEqual({ status: "id_mismatch", onchainIndexId: other });
    expect(chain.calls).toEqual(["code", "computeIndexId"]);
  });

  test("the id comparison ignores letter case only", async () => {
    const upper = `0x${plan.indexId.slice(2).toUpperCase()}` as const;
    expect((await runPreflight(reads({ computeIndexId: async () => upper }), plan, classify)).status).toBe("ready");
  });

  test("a simulation that reverts is reported with its decoded failure and no gas is estimated", async () => {
    const chain = reads({
      simulate: async () => {
        throw new Error("execution reverted");
      },
    });
    expect(await runPreflight(chain, plan, classify)).toMatchObject({
      status: "simulation_failed",
      failure: { kind: "contract_error", name: "IndexAlreadyExists" },
    });
    expect(chain.calls).not.toContain("estimateGas");
  });
});

function input(overrides: Partial<ChecklistInput> = {}): ChecklistInput {
  return {
    valid,
    issueCount: 0,
    networkName: "Anvil",
    chainId: CHAIN_ID,
    policy: local,
    presence: "deployed",
    account: CREATOR,
    walletChainId: CHAIN_ID,
    preflight: READY,
    newVersion: null,
    ...overrides,
  };
}
const states = (overrides: Partial<ChecklistInput> = {}) =>
  Object.fromEntries(publishChecklist(input(overrides)).map(({ id, state }) => [id, state]));
describe("publishChecklist", () => {
  test("everything established: nine items done", () => {
    expect(Object.values(states())).toEqual(Array(9).fill("done"));
  });

  test("each precondition blocks on its own", () => {
    expect(states({ valid: null, issueCount: 2 })).toMatchObject({ spec: "todo", hash: "waiting" });
    expect(states({ account: null, preflight: null })).toMatchObject({
      wallet: "todo",
      network: "waiting",
      fee: "waiting",
    });
    expect(states({ walletChainId: 8453, preflight: null })).toMatchObject({ network: "todo", simulation: "waiting" });
    expect(states({ policy: { status: "not_deployed" }, presence: "not_deployed", preflight: null })).toMatchObject({
      registry: "blocked",
      index_id: "waiting",
    });
    expect(states({ presence: "no_code", preflight: null })).toMatchObject({ registry: "blocked" });
    expect(states({ presence: "unreadable", preflight: null })).toMatchObject({ registry: "blocked" });
    expect(states({ presence: "checking", preflight: "checking" })).toMatchObject({
      registry: "checking",
      fee: "checking",
    });
    expect(states({ preflight: { status: "no_code" } })).toMatchObject({ registry: "blocked", index_id: "waiting" });
    expect(states({ preflight: { status: "id_mismatch", onchainIndexId: "0x00" } })).toMatchObject({
      index_id: "blocked",
      simulation: "waiting",
    });
    expect(
      states({
        preflight: { status: "simulation_failed", identifier: "x", failure: { kind: "unknown" }, index: null },
      }),
    ).toMatchObject({ index_id: "done", simulation: "blocked", fee: "waiting", balance: "waiting" });
    expect(states({ preflight: "failed" })).toMatchObject({ index_id: "blocked", simulation: "blocked" });
    // The balance must cover twice the estimated fee, L1 data fee included.
    const twice = READY.totalFeeWei * 2n;
    expect(states({ preflight: { ...READY, balanceWei: twice - 1n } })).toMatchObject({ balance: "blocked" });
    expect(states({ preflight: { ...READY, balanceWei: twice } })).toMatchObject({ balance: "done" });
    const withL1 = { ...READY, l1FeeWei: 600_000_000_000_000n, totalFeeWei: 2_000_000_000_000_000n };
    expect(states({ preflight: { ...withL1, balanceWei: 3_999_999_999_999_999n } })).toMatchObject({
      balance: "blocked",
    });
    expect(states({ preflight: { ...withL1, balanceWei: 4_000_000_000_000_000n } })).toMatchObject({ balance: "done" });
  });

  test("details state what was read", () => {
    const items = Object.fromEntries(publishChecklist(input()).map(({ id, detail }) => [id, detail]));
    expect(items.fee).toBe("700,000 gas, execution fee at most 0.0014 ETH, no L1 data fee on this chain");
    expect(items.balance).toBe("1 ETH, at least 2 times the estimated fee (0.0028 ETH)");
    const withL1 = { ...READY, l1FeeWei: 600_000_000_000_000n, totalFeeWei: 2_000_000_000_000_000n, balanceWei: 0n };
    const l1 = Object.fromEntries(publishChecklist(input({ preflight: withL1 })).map(({ id, detail }) => [id, detail]));
    expect(l1.fee).toBe("700,000 gas, execution fee at most 0.0014 ETH, L1 data fee 0.0006 ETH, total 0.002 ETH");
    expect(l1.balance).toBe("0 ETH, less than 2 times the estimated fee (0.004 ETH)");
    expect(items.hash).toBe(valid.specHash);
    expect(items.spec).toContain(`${valid.specBytes.length} of 8,192 bytes`);
  });
});

describe("a new version", () => {
  const OTHER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const target = versionTarget(CREATOR, REGISTRY);
  const edited = evaluateDraft(validDraft({ name: "Test Index Two" }), ASSETS).valid;
  if (edited === null) throw new Error("expected a valid draft");
  const versionPlan = buildVersionPlan({ valid: edited, target, creator: CREATOR });
  const INDEX = { creator: CREATOR, latestVersion: 1, deprecated: false };

  test("is ready with the index as read, after the base version's hash was read back", async () => {
    const chain = reads({ versionHash: async () => target.base.specHash });
    expect(await runPreflight(chain, versionPlan, classify)).toMatchObject({ status: "ready", index: INDEX });
    expect(chain.calls).toEqual([
      "code",
      "index",
      "versionHash",
      "indexIds",
      "simulate",
      "estimateGas",
      "maxFeePerGas",
      "balance",
      "l1DataFee",
    ]);
    expect(chain.calls).not.toContain("computeIndexId");
  });

  test("a base the registry does not hold stops before any simulation", async () => {
    const chain = reads({ versionHash: async () => `0x${"cd".repeat(32)}` });
    expect(await runPreflight(chain, versionPlan, classify)).toEqual({ status: "base_mismatch", index: INDEX });
    expect(chain.calls).not.toContain("simulate");
  });

  test("the registry's own refusal is reported with the index, so the checklist can say which check fails", async () => {
    const moved = { ...INDEX, latestVersion: 2 };
    const chain = reads({
      index: async () => moved,
      versionHash: async () => target.base.specHash,
      simulate: async () => {
        throw new Error("execution reverted");
      },
    });
    const result = await runPreflight(chain, versionPlan, () => ({
      kind: "contract_error",
      name: "UnexpectedVersion",
      args: [2, 3],
    }));
    expect(result).toMatchObject({ status: "simulation_failed", index: moved, failure: { name: "UnexpectedVersion" } });
  });

  const ready = { ...READY, index: INDEX };
  const versionStates = (overrides: Partial<ChecklistInput> = {}) =>
    states({ newVersion: 2, preflight: ready, ...overrides });

  test("eleven items, each established from the index as read", () => {
    const items = publishChecklist(input({ newVersion: 2, preflight: ready }));
    expect(items.map(({ id }) => id)).toEqual([
      "spec",
      "hash",
      "wallet",
      "network",
      "registry",
      "creator",
      "active",
      "version",
      "simulation",
      "fee",
      "balance",
    ]);
    expect(items.every(({ state }) => state === "done")).toBe(true);
    expect(items.find(({ id }) => id === "simulation")?.detail).toBe(
      "publishVersion succeeded against the current state",
    );
  });

  test("another account, a deprecation, a moved version or another base each block their own item", () => {
    expect(versionStates({ account: OTHER })).toMatchObject({ creator: "blocked", active: "done", version: "done" });
    expect(versionStates({ preflight: { ...ready, index: { ...INDEX, deprecated: true } } })).toMatchObject({
      creator: "done",
      active: "blocked",
    });
    expect(versionStates({ preflight: { ...ready, index: { ...INDEX, latestVersion: 2 } } })).toMatchObject({
      version: "blocked",
    });
    expect(versionStates({ preflight: { status: "base_mismatch", index: INDEX } })).toMatchObject({
      version: "blocked",
      simulation: "waiting",
    });
    expect(versionStates({ preflight: "checking" })).toMatchObject({ creator: "checking", version: "checking" });
  });
});

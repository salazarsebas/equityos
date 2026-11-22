import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { evaluateDraft } from "../../src/lib/studio/evaluate";
import {
  type ChecklistInput,
  canPublish,
  type Preflight,
  publishChecklist,
  type RegistryReads,
  runPreflight,
} from "../../src/lib/studio/preflight";
import { buildPublishPlan, type NetworkPolicy } from "../../src/lib/studio/publish";
import { ASSETS, CHAIN_ID, SALT, validDraft } from "./support";

const REGISTRY: Address = "0x4BD4D49A9C88f75FB97674488E23A7Fa59F9506c";
const CREATOR: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const { valid } = evaluateDraft(validDraft(), ASSETS);
if (valid === null) throw new Error("expected a valid draft");
const plan = buildPublishPlan({ valid, chainId: CHAIN_ID, registry: REGISTRY, creator: CREATOR, salt: SALT });
const deployment = { registry: REGISTRY, rebalanceLog: REGISTRY, deployBlock: 0n } as const;
const local: NetworkPolicy = { status: "available", deployment, requiresAcknowledgement: false };
const mainnet: NetworkPolicy = { status: "available", deployment, requiresAcknowledgement: true };

function reads(overrides: Partial<RegistryReads> = {}): RegistryReads & { calls: string[] } {
  const calls: string[] = [];
  const base: RegistryReads = {
    code: async () => "0x6080",
    computeIndexId: async () => plan.indexId,
    indexIds: async () => [],
    simulate: async () => undefined,
    estimateGas: async () => 700_000n,
    maxFeePerGas: async () => 2_000_000_000n,
    balance: async () => 10n ** 18n,
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
const READY: Preflight = {
  status: "ready",
  identifier: "test-index-abcdef12",
  gas: 700_000n,
  maxFeePerGasWei: 2_000_000_000n,
  feeWei: 1_400_000_000_000_000n,
  balanceWei: 10n ** 18n,
};

describe("runPreflight", () => {
  test("a plan that passes every check is ready, with the fee as gas times the maximum fee per gas", async () => {
    const result = await runPreflight(reads(), plan, classify);
    expect(result).toEqual({ ...READY, identifier: `test-index-${plan.indexId.slice(2, 10)}` });
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
    ...overrides,
  };
}
const states = (overrides: Partial<ChecklistInput> = {}) =>
  Object.fromEntries(publishChecklist(input(overrides)).map(({ id, state }) => [id, state]));
const allowed = (overrides: Partial<ChecklistInput> = {}, acknowledged = false) => {
  const full = input(overrides);
  return canPublish(publishChecklist(full), full.policy, acknowledged);
};

describe("publishChecklist and canPublish", () => {
  test("everything established: nine items done, publishing allowed", () => {
    expect(Object.values(states())).toEqual(Array(9).fill("done"));
    expect(allowed()).toBe(true);
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
      states({ preflight: { status: "simulation_failed", identifier: "x", failure: { kind: "unknown" } } }),
    ).toMatchObject({ index_id: "done", simulation: "blocked", fee: "waiting", balance: "waiting" });
    expect(states({ preflight: "failed" })).toMatchObject({ index_id: "blocked", simulation: "blocked" });
    expect(states({ preflight: { ...READY, balanceWei: READY.feeWei - 1n } })).toMatchObject({ balance: "blocked" });
    expect(states({ preflight: { ...READY, balanceWei: READY.feeWei } })).toMatchObject({ balance: "done" });
  });

  test("publishing is refused whenever any item is not done", () => {
    const blockers: Partial<ChecklistInput>[] = [
      { valid: null },
      { account: null },
      { walletChainId: 1 },
      { presence: "no_code" },
      { presence: "checking" },
      { policy: { status: "not_deployed" } },
      { preflight: null },
      { preflight: "checking" },
      { preflight: "failed" },
      { preflight: { status: "id_mismatch", onchainIndexId: "0x00" } },
      { preflight: { status: "simulation_failed", identifier: "x", failure: { kind: "unknown" } } },
      { preflight: { ...READY, balanceWei: 0n } },
    ];
    for (const blocker of blockers) expect(allowed(blocker, true)).toBe(false);
    expect(canPublish([], local, true)).toBe(false);
  });

  test("on Base mainnet the acknowledgement is required as well, and only there", () => {
    expect(allowed({ policy: mainnet, chainId: 8453, walletChainId: 8453 }, false)).toBe(false);
    expect(allowed({ policy: mainnet, chainId: 8453, walletChainId: 8453 }, true)).toBe(true);
    expect(allowed({ policy: local }, false)).toBe(true);
  });

  test("details state what was read", () => {
    const items = Object.fromEntries(publishChecklist(input()).map(({ id, detail }) => [id, detail]));
    expect(items.fee).toBe("700,000 gas, at most 0.0014 ETH");
    expect(items.balance).toBe("1 ETH, enough for the fee");
    expect(items.hash).toBe(valid.specHash);
    expect(items.spec).toContain(`${valid.specBytes.length} of 8,192 bytes`);
  });
});

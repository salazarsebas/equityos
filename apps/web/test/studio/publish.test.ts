import { describe, expect, test } from "bun:test";
import { indexRegistryAbi } from "@equityos/contracts-abi";
import { specHash } from "@equityos/core";
import {
  type Address,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  type Hex,
  hexToBytes,
  keccak256,
  type Log,
  stringToHex,
} from "viem";
import { evaluateDraft } from "../../src/lib/studio/evaluate";
import {
  buildPublishPlan,
  checkPublishReceipt,
  networkPolicy,
  type OnchainVersion,
  type PublishPlan,
  predictIdentifier,
  predictIndexId,
  verifyPublication,
  verifyPublishedVersion,
} from "../../src/lib/studio/publish";
import { ASSETS, CHAIN_ID, SALT, validDraft } from "./support";

const REGISTRY: Address = "0x4BD4D49A9C88f75FB97674488E23A7Fa59F9506c";
const CREATOR: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function plan(overrides: Parameters<typeof validDraft>[0] = {}): PublishPlan {
  const { valid } = evaluateDraft(validDraft(overrides), ASSETS);
  if (valid === null) throw new Error("expected a valid draft");
  return buildPublishPlan({ valid, chainId: CHAIN_ID, registry: REGISTRY, creator: CREATOR, salt: SALT });
}

function log(address: Address, topics: Hex[], data: Hex): Log {
  return {
    address,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockHash: `0x${"01".repeat(32)}`,
    blockNumber: 7n,
    logIndex: 0,
    transactionHash: `0x${"02".repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  };
}

interface Emitted {
  indexId?: Hex;
  /** Index id of the VersionPublished event alone. */
  publishedIndexId?: Hex;
  creator?: Address;
  salt?: Hex;
  version?: number;
  specHash?: Hex;
  emitter?: Address;
}

function receiptLogs(p: PublishPlan, changed: Emitted = {}): Log[] {
  const indexId = changed.indexId ?? p.indexId;
  const creator = changed.creator ?? p.creator;
  const emitter = changed.emitter ?? p.registry;
  const created = log(
    emitter,
    encodeEventTopics({ abi: indexRegistryAbi, eventName: "IndexCreated", args: { indexId, creator } }) as Hex[],
    encodeAbiParameters([{ type: "bytes32" }], [changed.salt ?? p.salt]),
  );
  const published = log(
    emitter,
    encodeEventTopics({
      abi: indexRegistryAbi,
      eventName: "VersionPublished",
      args: {
        indexId: changed.publishedIndexId ?? indexId,
        version: changed.version ?? 1,
        specHash: changed.specHash ?? p.specHash,
      },
    }) as Hex[],
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint8" }, { type: "uint32" }, { type: "uint16" }],
      [creator, 2, p.specBytes.length, p.constituents.length],
    ),
  );
  return [created, published];
}

function stored(p: PublishPlan, changed: Partial<OnchainVersion> = {}): OnchainVersion {
  return { creator: p.creator, specHash: p.specHash, spec: p.specHex, constituents: p.constituents, ...changed };
}

describe("predictIndexId", () => {
  test("is keccak256(abi.encode(creator, salt)), as the registry derives it", () => {
    const expected = keccak256(`0x${CREATOR.slice(2).toLowerCase().padStart(64, "0")}${SALT.slice(2)}`);
    expect(predictIndexId(CREATOR, SALT)).toBe(expected);
    expect(predictIndexId(OTHER, SALT)).not.toBe(expected);
    expect(predictIndexId(CREATOR, `0x${"5b".repeat(32)}`)).not.toBe(expected);
  });
});

describe("predictIdentifier", () => {
  const id = (digits: string): Hex => `0x${digits.padEnd(64, "0")}`;

  test("uses eight digits unless an earlier index shares them", () => {
    expect(predictIdentifier([], id("a1b2c3d4e5"), "alpha")).toBe("alpha-a1b2c3d4");
    expect(predictIdentifier([id("ffff")], id("a1b2c3d4e5"), "alpha")).toBe("alpha-a1b2c3d4");
    expect(predictIdentifier([id("a1b2c3d4e6")], id("a1b2c3d4e5"), "alpha")).toBe("alpha-a1b2c3d4e5");
  });

  test("an index that is already in the registry keeps the prefix it has", () => {
    expect(predictIdentifier([id("a1b2c3d4e5"), id("a1b2c3d4e6")], id("a1b2c3d4e5"), "alpha")).toBe("alpha-a1b2c3d4");
  });
});

describe("buildPublishPlan", () => {
  test("the bytes sent are the canonical bytes that are shown and hashed", () => {
    const p = plan({ description: "Café → three names" });
    const [salt, spec, tokens, weightsBps] = p.args;
    expect(spec).toBe(p.specHex);
    expect(hexToBytes(spec)).toEqual(p.specBytes);
    expect(spec).toBe(stringToHex(p.canonicalText));
    expect(specHash(hexToBytes(spec))).toBe(p.specHash);
    expect(keccak256(spec)).toBe(p.specHash);
    expect(salt).toBe(SALT);
    expect(tokens).toEqual(p.constituents.map(({ token }) => token));
    expect(weightsBps).toEqual([3334, 3333, 3333]);
    expect(p.indexId).toBe(predictIndexId(CREATOR, SALT));
    expect(p).toMatchObject({ functionName: "createIndex", version: 1, slug: "test-index" });
  });

  test("the calldata of createIndex carries exactly those bytes", () => {
    const p = plan();
    const data = encodeFunctionData({ abi: indexRegistryAbi, functionName: p.functionName, args: p.args });
    const decoded = decodeFunctionData({ abi: indexRegistryAbi, data });
    expect(decoded.functionName).toBe("createIndex");
    expect(decoded.args?.[1]).toBe(p.specHex);
  });
});

describe("checkPublishReceipt", () => {
  const p = plan();
  const other = `0x${"cd".repeat(32)}` as const;

  test("accepts the events of the plan", () => {
    expect(checkPublishReceipt(p, receiptLogs(p))).toEqual({ ok: true, result: null });
  });

  test("rejects another index id, version, spec hash, creator or salt", () => {
    expect(checkPublishReceipt(p, receiptLogs(p, { indexId: other })).ok).toBe(false);
    // IndexCreated is right, VersionPublished is for another index.
    expect(checkPublishReceipt(p, receiptLogs(p, { publishedIndexId: other })).ok).toBe(false);
    expect(checkPublishReceipt(p, receiptLogs(p, { version: 2 })).ok).toBe(false);
    expect(checkPublishReceipt(p, receiptLogs(p, { specHash: other })).ok).toBe(false);
    expect(checkPublishReceipt(p, receiptLogs(p, { creator: OTHER })).ok).toBe(false);
    expect(checkPublishReceipt(p, receiptLogs(p, { salt: other })).ok).toBe(false);
  });

  test("ignores events of another contract, so they cannot stand in for the registry", () => {
    expect(checkPublishReceipt(p, receiptLogs(p, { emitter: OTHER })).ok).toBe(false);
    expect(checkPublishReceipt(p, [...receiptLogs(p, { emitter: OTHER, indexId: other }), ...receiptLogs(p)]).ok).toBe(
      true,
    );
  });

  test("rejects a receipt with no event, or with two publications", () => {
    expect(checkPublishReceipt(p, []).ok).toBe(false);
    expect(checkPublishReceipt(p, receiptLogs(p).slice(0, 1)).ok).toBe(false);
    expect(checkPublishReceipt(p, [...receiptLogs(p), ...receiptLogs(p)]).ok).toBe(false);
  });
});

describe("verifyPublishedVersion", () => {
  const p = plan();

  test("passes when the registry holds what was sent, with all five checks", () => {
    const result = verifyPublishedVersion(p, stored(p));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.checks.map(({ status }) => status)).toEqual(Array(5).fill("pass"));
  });

  test("each differing value is reported for itself", () => {
    const other = plan({ name: "Another Index" });
    // Other valid spec bytes, stored with their own correct hash: a conformant version, but not the one sent.
    const otherVersion = stored(p, { spec: other.specHex, specHash: other.specHash, constituents: other.constituents });
    expect(verifyPublishedVersion(other, stored(other)).ok).toBe(true);
    expect(verifyPublishedVersion(p, otherVersion)).toEqual({
      ok: false,
      reason: "The spec bytes stored by the registry are not the bytes that were shown and sent.",
    });
    // The bytes that were sent, but another recorded hash.
    expect(verifyPublishedVersion(p, stored(p, { specHash: other.specHash }))).toEqual({
      ok: false,
      reason: `The registry holds spec hash ${other.specHash}, not ${p.specHash}.`,
    });
    expect(verifyPublishedVersion(p, stored(p, { creator: OTHER }))).toEqual({
      ok: false,
      reason: `The registry records ${OTHER} as the creator, not ${CREATOR}.`,
    });
  });

  test("fails on another creator, other bytes, another hash or another composition", () => {
    const different = plan({ name: "Another Index" });
    expect(verifyPublishedVersion(p, stored(p, { creator: OTHER })).ok).toBe(false);
    expect(verifyPublishedVersion(p, stored(p, { spec: different.specHex })).ok).toBe(false);
    expect(verifyPublishedVersion(p, stored(p, { specHash: different.specHash })).ok).toBe(false);
    const swapped = p.constituents.map((constituent, i) => ({ ...constituent, weightBps: i === 0 ? 3333 : 3334 }));
    const wrong = verifyPublishedVersion(p, stored(p, { constituents: swapped }));
    expect(wrong).toMatchObject({ ok: false });
    if (!wrong.ok) expect(wrong.reason).toContain("C5");
  });

  test("fails for a spec that names another chain than the one it was read from", () => {
    const elsewhere = { ...p, chainId: 8453 };
    const result = verifyPublishedVersion(elsewhere, stored(p));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("C4");
  });
});

describe("verifyPublication", () => {
  const p = plan();
  const chain = (version: OnchainVersion) => ({ version: async () => version, indexIds: async () => [p.indexId] });

  test("succeeds only with matching events and a verified read-back, and reports the identifier", async () => {
    const result = await verifyPublication(p, { logs: receiptLogs(p), blockNumber: 7n }, chain(stored(p)));
    expect(result).toMatchObject({
      ok: true,
      result: { blockNumber: 7n, identifier: `test-index-${p.indexId.slice(2, 10)}`, plan: p },
    });
  });

  test("matching events are not enough when the stored version differs", async () => {
    const bad = stored(p, { spec: plan({ name: "Another Index" }).specHex });
    expect((await verifyPublication(p, { logs: receiptLogs(p), blockNumber: 7n }, chain(bad))).ok).toBe(false);
  });

  test("a verified read-back is not enough when the events differ", async () => {
    const logs = receiptLogs(p, { specHash: `0x${"cd".repeat(32)}` });
    expect((await verifyPublication(p, { logs, blockNumber: 7n }, chain(stored(p)))).ok).toBe(false);
  });
});

describe("networkPolicy", () => {
  const deployment = { registry: REGISTRY, rebalanceLog: REGISTRY, deployBlock: 100n } as const;

  test("the real map: nothing is published on Base or Base Sepolia, a local chain needs no acknowledgement", () => {
    expect(networkPolicy(8453)).toEqual({ status: "not_deployed" });
    expect(networkPolicy(84_532)).toEqual({ status: "not_deployed" });
    expect(networkPolicy(31_337)).toMatchObject({ status: "available", requiresAcknowledgement: false });
    expect(networkPolicy(1)).toEqual({ status: "not_deployed" });
  });

  test("once deployed, Base mainnet requires the acknowledgement and Base Sepolia does not", () => {
    const deployed = { 8453: deployment, 84532: deployment };
    expect(networkPolicy(8453, deployed)).toMatchObject({ status: "available", requiresAcknowledgement: true });
    expect(networkPolicy(84_532, deployed)).toMatchObject({ status: "available", requiresAcknowledgement: false });
    expect(networkPolicy(8453, { 8453: { ...deployment, deployBlock: null } })).toEqual({ status: "not_deployed" });
  });
});

import { BASE_MAINNET_CHAIN_ID, DEPLOYMENTS, type Deployment, indexRegistryAbi } from "@equityos/contracts-abi";
import { bytesToHex, type Constituent, type VerificationReport, verifyVersion } from "@equityos/core";
import {
  type Address,
  encodeAbiParameters,
  type Hex,
  hexToBytes,
  isAddressEqual,
  keccak256,
  type Log,
  parseEventLogs,
} from "viem";
import { createIndexDirectory, formatIdentifier } from "@/lib/registry/identifier";
import type { Verification } from "@/lib/tx/run";
import type { ValidDraft } from "./evaluate";

/** Whether a network accepts a publication from the Studio, decided before anything is read from it. */
export type NetworkPolicy =
  /** The contracts are not deployed on the chain, or the chain is not one the contracts target. */
  | { readonly status: "not_deployed" }
  | {
      readonly status: "available";
      readonly deployment: Deployment;
      /** Base mainnet: a real transaction that costs real ETH. Needs one explicit acknowledgement. */
      readonly requiresAcknowledgement: boolean;
    };

/**
 * Publishing is offered only where the deployment map records a deployment. Base Sepolia and a local node
 * need nothing more. Base mainnet also needs the acknowledgement. Whether code really is at the address is a
 * separate, live check.
 */
export function networkPolicy(
  chainId: number,
  deployments: Readonly<Record<number, Deployment>> = DEPLOYMENTS,
): NetworkPolicy {
  const deployment = Object.hasOwn(deployments, chainId) ? deployments[chainId] : undefined;
  if (deployment === undefined || deployment.deployBlock === null) return { status: "not_deployed" };
  return { status: "available", deployment, requiresAcknowledgement: chainId === BASE_MAINNET_CHAIN_ID };
}

/** `keccak256(abi.encode(creator, salt))`, the id `IndexRegistry` derives for an index. */
export function predictIndexId(creator: Address, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [creator, salt]));
}

/**
 * The identifier `<slug>-<prefix>` an index gets, given the ids created before it. An id that is already in
 * the registry keeps the prefix it has.
 */
export function predictIdentifier(existingIds: readonly Hex[], indexId: Hex, slug: string): string {
  const directory = createIndexDirectory();
  directory.append(existingIds);
  if (directory.positionOf(indexId) === undefined) directory.append([indexId]);
  const prefix = directory.prefixAt(directory.positionOf(indexId) ?? -1);
  return formatIdentifier(slug, prefix ?? indexId.slice(2));
}

/** Everything one `createIndex` call sends, and everything the review shows. One object, so they cannot differ. */
export interface PublishPlan {
  readonly chainId: number;
  readonly registry: Address;
  readonly creator: Address;
  readonly functionName: "createIndex";
  readonly salt: Hex;
  /** Predicted locally. Confirmed against `computeIndexId` on the registry before anything is sent. */
  readonly indexId: Hex;
  /** The version this call creates. `createIndex` always writes version 1. */
  readonly version: 1;
  readonly slug: string;
  readonly specBytes: Uint8Array;
  /** `specBytes` as the hex string that goes into the call. */
  readonly specHex: Hex;
  /** `specBytes` decoded as UTF-8: the canonical JSON as it is displayed and exported. */
  readonly canonicalText: string;
  readonly specHash: Hex;
  readonly constituents: readonly Constituent[];
  /** Arguments of `createIndex(salt, spec, tokens, weightsBps)`. */
  readonly args: readonly [Hex, Hex, readonly Address[], readonly number[]];
}

export function buildPublishPlan(input: {
  readonly valid: ValidDraft;
  readonly chainId: number;
  readonly registry: Address;
  readonly creator: Address;
  readonly salt: Hex;
}): PublishPlan {
  const { valid, chainId, registry, creator, salt } = input;
  const { specBytes, constituents } = valid;
  const specHex = bytesToHex(specBytes);
  return {
    chainId,
    registry,
    creator,
    functionName: "createIndex",
    salt,
    indexId: predictIndexId(creator, salt),
    version: 1,
    slug: valid.spec.slug,
    specBytes,
    specHex,
    canonicalText: new TextDecoder("utf-8", { fatal: true }).decode(specBytes),
    specHash: valid.specHash,
    constituents,
    args: [salt, specHex, constituents.map(({ token }) => token), constituents.map(({ weightBps }) => weightBps)],
  };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Compares the events of a receipt with the plan. A successful receipt must carry exactly one `IndexCreated`
 * and one `VersionPublished` from the registry, with the predicted index id, version 1 and the hash of the
 * bytes that were shown. Events of any other contract are ignored.
 */
export function checkPublishReceipt(plan: PublishPlan, logs: readonly Log[]): Verification<null> {
  const fromRegistry = logs.filter((log) => isAddressEqual(log.address, plan.registry));
  const created = parseEventLogs({ abi: indexRegistryAbi, logs: fromRegistry, eventName: "IndexCreated" });
  const published = parseEventLogs({ abi: indexRegistryAbi, logs: fromRegistry, eventName: "VersionPublished" });
  const [index] = created;
  const [version] = published;
  if (created.length !== 1 || index === undefined) {
    return {
      ok: false,
      reason: `The receipt has ${created.length} IndexCreated events from the registry, expected 1.`,
    };
  }
  if (published.length !== 1 || version === undefined) {
    const reason = `The receipt has ${published.length} VersionPublished events from the registry, expected 1.`;
    return { ok: false, reason };
  }
  if (!same(index.args.indexId, plan.indexId) || !same(version.args.indexId, plan.indexId)) {
    return {
      ok: false,
      reason: `The registry created index ${index.args.indexId}, not the predicted ${plan.indexId}.`,
    };
  }
  if (!same(index.args.creator, plan.creator) || !same(index.args.salt, plan.salt)) {
    return { ok: false, reason: "The creator or the salt in the IndexCreated event is not the one that was sent." };
  }
  if (version.args.version !== plan.version) {
    return { ok: false, reason: `The registry published version ${version.args.version}, expected ${plan.version}.` };
  }
  if (!same(version.args.specHash, plan.specHash)) {
    const reason = `The registry recorded spec hash ${version.args.specHash}, not ${plan.specHash}.`;
    return { ok: false, reason };
  }
  return { ok: true, result: null };
}

/** What the registry returns for one version, read after the transaction was mined. */
export interface OnchainVersion {
  readonly creator: Address;
  readonly specHash: Hex;
  /** The stored spec bytes. */
  readonly spec: Hex;
  readonly constituents: readonly { readonly token: Address; readonly weightBps: number }[];
}

/**
 * Establishes that the registry holds what was published: the same creator, the same bytes, the same hash, and
 * a version that passes the conformance checks C1 to C5 of `@equityos/core` on the values the chain returned.
 * Each comparison has its own reason, so a failure says which value differs.
 */
export function verifyPublishedVersion(plan: PublishPlan, onchain: OnchainVersion): Verification<VerificationReport> {
  if (!same(onchain.creator, plan.creator)) {
    return { ok: false, reason: `The registry records ${onchain.creator} as the creator, not ${plan.creator}.` };
  }
  if (!same(onchain.spec, plan.specHex)) {
    return { ok: false, reason: "The spec bytes stored by the registry are not the bytes that were shown and sent." };
  }
  if (!same(onchain.specHash, plan.specHash)) {
    return { ok: false, reason: `The registry holds spec hash ${onchain.specHash}, not ${plan.specHash}.` };
  }
  const report = verifyVersion({
    specBytes: hexToBytes(onchain.spec),
    specHash: onchain.specHash,
    constituents: onchain.constituents,
    chainId: plan.chainId,
  });
  const failed = report.checks.find(({ status }) => status !== "pass");
  if (!report.conformant || failed !== undefined) {
    return {
      ok: false,
      reason: `Check ${failed?.id ?? "C1"} did not pass on the published version: ${failed?.reason}.`,
    };
  }
  return { ok: true, result: report };
}

/** What is known once a publication is confirmed: all of it was read from the chain after the receipt. */
export interface PublishResult {
  readonly plan: PublishPlan;
  /** Canonical identifier of the index, from the ids the registry holds now. */
  readonly identifier: string;
  readonly blockNumber: bigint;
  /** Checks C1 to C5 on the version as the registry returned it. All pass. */
  readonly report: VerificationReport;
}

/**
 * Everything that has to hold before a publication is shown as successful: the events of the receipt match
 * the plan, and the version read back from the registry is the one that was sent and passes verification.
 * The receipt must already be known to have status "success".
 */
export async function verifyPublication(
  plan: PublishPlan,
  receipt: { readonly logs: readonly Log[]; readonly blockNumber: bigint },
  chain: {
    version(indexId: Hex, version: number): Promise<OnchainVersion>;
    indexIds(): Promise<readonly Hex[]>;
  },
): Promise<Verification<PublishResult>> {
  const events = checkPublishReceipt(plan, receipt.logs);
  if (!events.ok) return events;
  const verified = verifyPublishedVersion(plan, await chain.version(plan.indexId, plan.version));
  if (!verified.ok) return verified;
  const identifier = predictIdentifier(await chain.indexIds(), plan.indexId, plan.slug);
  return { ok: true, result: { plan, identifier, blockNumber: receipt.blockNumber, report: verified.result } };
}

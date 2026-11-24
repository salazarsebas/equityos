import type { Address, Hex } from "viem";
import { networkHandler } from "../../src/server/api/network";
import {
  buildNetworkMetrics,
  type ClassifiedAttestation,
  createNetworkService,
  type MetricsInput,
  type NetworkRead,
  type NetworkService,
  type Tier,
} from "../../src/server/network";
import type { EventScan, RegistryEvent } from "../../src/server/registry";
import { createRegistryReader } from "../../src/server/registry/reader";
import { loadRegistryReplay } from "../../src/server/registry/replay";

export const CREATOR: Address = "0x00000000000000000000000000000000000c0ffe";
export const TEAM: Address = "0x0000000000000000000000000000000000007ea3";
export const ALICE: Address = "0x00000000000000000000000000000000000a11ce";
export const BOB: Address = "0x0000000000000000000000000000000000000b0b";
export const INDEX_1: Hex = `0x${"1".repeat(64)}`;
export const INDEX_2: Hex = `0x${"2".repeat(64)}`;
export const TEAM_INDEX: Hex = `0x${"3".repeat(64)}`;
const DAY = 86_400n;
const START = 1_794_787_200n; // 2026-11-16 00:00:00 UTC

let block = 100n;
function origin(timestamp: bigint) {
  block += 1n;
  return {
    blockNumber: block,
    blockTimestamp: timestamp,
    transactionHash: `0x${block.toString(16).padStart(64, "0")}` as Hex,
    logIndex: 0,
  };
}

function created(indexId: Hex, creator: Address, timestamp = START): RegistryEvent[] {
  const at = origin(timestamp);
  return [
    { ...at, type: "index_created", indexId, creator, salt: `0x${"0".repeat(64)}` },
    {
      ...at,
      logIndex: 1,
      type: "version_published",
      indexId,
      version: 1,
      specHash: `0x${"a".repeat(64)}`,
      creator,
      composition: "static",
      specSize: 600,
      constituentCount: 3,
    },
  ];
}

function attestation(account: Address, indexId: Hex, tier: Tier, options: Partial<ClassifiedAttestation> = {}) {
  const event = { ...origin(START + DAY), type: "rebalance_recorded" as const, account, indexId, version: 1 };
  return {
    event,
    tier,
    reason: tier === "a" ? null : "no_constituent_flows",
    valueUsdE8: tier === "unmatched" ? null : 250_000_000n,
    linkedTransaction: null,
    tracking: tier === "a" ? { status: "within", maxDriftBps: 10, toleranceBps: 700 } : null,
    ...options,
  } satisfies ClassifiedAttestation;
}

/** Constructed events and classified attestations, with one excluded account. Test data only. */
export function metricsInput(): MetricsInput {
  const events: RegistryEvent[] = [
    ...created(INDEX_1, CREATOR),
    ...created(INDEX_2, CREATOR, START + 2n * DAY),
    ...created(TEAM_INDEX, TEAM),
    { ...origin(START + 3n * DAY), type: "index_deprecated", indexId: INDEX_2, creator: CREATOR },
    { ...origin(START + 3n * DAY), type: "index_deprecated", indexId: TEAM_INDEX, creator: TEAM },
  ];
  const classified = [
    attestation(ALICE, INDEX_1, "a"),
    attestation(ALICE, INDEX_1, "a", { tracking: { status: "outside", maxDriftBps: 900, toleranceBps: 700 } }),
    attestation(BOB, INDEX_1, "a", { tracking: { status: "not_assessed", reason: "not_static" } }),
    attestation(BOB, INDEX_2, "b"),
    attestation(ALICE, INDEX_2, "unmatched"),
    attestation(TEAM, INDEX_2, "a"),
    attestation(TEAM, TEAM_INDEX, "unmatched"),
  ];
  const scan: EventScan = {
    events: [...events, ...classified.map(({ event }) => event)],
    fromBlock: 50n,
    scannedToBlock: 500n,
    targetBlock: 500n,
    complete: true,
  };
  return {
    chainId: 31_337,
    scan,
    classified,
    usageToBlock: 500n,
    exclusions: [{ address: TEAM, label: "Team test account" }],
    labels: new Map([[INDEX_1, { identifier: "first-11111111", name: "First" }]]),
    computedAt: 1_800_000_000,
  };
}

/** The read a deployed registry with the constructed activity gives. */
export function constructedRead(): NetworkRead {
  const input = metricsInput();
  const { events, ...scan } = input.scan;
  return {
    status: "ok",
    chainId: input.chainId,
    registry: "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c",
    rebalanceLog: "0x593449aef0efc05528d3bc7be9eb8d99e39aa41c",
    scan,
    usageComplete: true,
    metrics: buildNetworkMetrics(input),
    classified: input.classified,
    exclusions: input.exclusions,
  };
}

/** A service that answers `read` with a fixed result, or fails with `error`. */
export function stubNetwork(result: NetworkRead | Error): () => NetworkService {
  const service: NetworkService = {
    read: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
  };
  return () => service;
}

/** Clock of the handlers over a recording. */
const RECORDING_READ_AT = 1_800_000_000;

export const EXCLUDED_SEED_ACCOUNT = "0x5eed00000000000000000000000000000000000e";

/** The real service over a recording of the local chain in `test/fixtures/<directory>`. */
export function recordedNetwork(directory = "registry") {
  const { config, client } = loadRegistryReplay(new URL(`../fixtures/${directory}`, import.meta.url).pathname);
  const service = createNetworkService({
    reader: createRegistryReader({ config, client }),
    config,
    client: () => client,
    exclusions: [{ address: EXCLUDED_SEED_ACCOUNT, label: "Local seed test account" }],
    now: () => RECORDING_READ_AT,
  });
  return networkHandler({ network: () => service, mode: () => "replay", now: () => RECORDING_READ_AT });
}

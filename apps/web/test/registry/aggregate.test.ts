import { expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { countPerDay, distinctCreators, type RegistryEvent } from "../../src/server/registry";

const INDEX: Hex = `0x${"11".repeat(32)}`;
const ALICE: Address = "0x00000000000000000000000000000000000000a1";
const BOB: Address = "0x00000000000000000000000000000000000000b0";

function origin(isoTime: string, logIndex = 0) {
  const blockTimestamp = BigInt(Date.parse(isoTime) / 1000);
  return { blockNumber: blockTimestamp, blockTimestamp, transactionHash: INDEX, logIndex };
}

const created = (isoTime: string, creator: Address): RegistryEvent => ({
  ...origin(isoTime),
  type: "index_created",
  indexId: INDEX,
  creator,
  salt: INDEX,
});
const rebalanced = (isoTime: string, account: Address): RegistryEvent => ({
  ...origin(isoTime),
  type: "rebalance_recorded",
  account,
  indexId: INDEX,
  version: 1,
});

const EVENTS: readonly RegistryEvent[] = [
  created("2026-03-01T00:00:00Z", ALICE),
  rebalanced("2026-03-01T12:00:00Z", BOB),
  created("2026-03-01T23:59:59Z", BOB),
  created("2026-03-02T00:00:00Z", ALICE),
  rebalanced("2026-03-05T08:00:00Z", ALICE),
  rebalanced("2026-03-05T09:00:00Z", ALICE),
];

test("countPerDay counts one event type per UTC day, in ascending order, without empty days", () => {
  expect(countPerDay(EVENTS, "index_created")).toEqual([
    { day: "2026-03-01", count: 2 },
    { day: "2026-03-02", count: 1 },
  ]);
  expect(countPerDay(EVENTS, "rebalance_recorded")).toEqual([
    { day: "2026-03-01", count: 1 },
    { day: "2026-03-05", count: 2 },
  ]);
  expect(countPerDay([...EVENTS].reverse(), "index_created")).toEqual(countPerDay(EVENTS, "index_created"));
  expect(countPerDay(EVENTS, "index_deprecated")).toEqual([]);
});

test("distinctCreators lists each creator once, in order of first index", () => {
  expect(distinctCreators(EVENTS)).toEqual([ALICE, BOB]);
  expect(distinctCreators(EVENTS.filter(({ type }) => type === "rebalance_recorded"))).toEqual([]);
});

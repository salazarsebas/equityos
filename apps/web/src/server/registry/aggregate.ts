import "server-only";
import type { Address } from "viem";
import type { RegistryEvent } from "./events";

const SECONDS_PER_DAY = 86_400n;

export interface DailyCount {
  /** UTC calendar day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly count: number;
}

/**
 * Number of events of one type per UTC day of their block timestamp, in ascending day order. Days without an
 * event are absent.
 */
export function countPerDay(events: readonly RegistryEvent[], type: RegistryEvent["type"]): DailyCount[] {
  const counts = new Map<bigint, number>();
  for (const event of events) {
    if (event.type !== type) continue;
    const day = event.blockTimestamp / SECONDS_PER_DAY;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, count]) => ({
      day: new Date(Number(day * SECONDS_PER_DAY) * 1000).toISOString().slice(0, 10),
      count,
    }));
}

/** The accounts that created at least one index, lowercase, in order of their first index. */
export function distinctCreators(events: readonly RegistryEvent[]): Address[] {
  const creators = new Set<Address>();
  for (const event of events) {
    if (event.type === "index_created") creators.add(event.creator);
  }
  return [...creators];
}

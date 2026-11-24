/**
 * A record of the executions sent from this browser, kept in `localStorage` only. No server stores it and it is
 * not a record of the account: another browser, a cleared storage or another device shows none of it. The
 * format version is part of the key. A value that is not JSON, or an entry of another shape, is dropped on read,
 * never repaired, so a corrupted store shows fewer entries and never breaks the page.
 */
import type { Address, Hex } from "viem";

export const HISTORY_STORAGE_KEY = "equityos.execution.history.v1";
/** Most entries kept, newest first. */
export const MAX_HISTORY_ENTRIES = 50;

/**
 * - `complete`: every call confirmed.
 * - `partial`: some calls confirmed and the sequence stopped.
 * - `none`: nothing confirmed.
 * - `unverified`: mined, but a check on the receipts did not pass.
 * - `unknown`: no final status was reported in time; it may still take effect.
 */
export type HistoryResult = "complete" | "partial" | "none" | "unverified" | "unknown";

export interface HistoryEntry {
  /** Unix milliseconds of the record, by the device clock. */
  readonly at: number;
  readonly chainId: number;
  readonly account: Address;
  readonly index: {
    readonly identifier: string;
    readonly name: string;
    readonly indexId: Hex;
    readonly version: number;
  };
  readonly planHash: Hex;
  readonly mode: "atomic" | "sequential";
  readonly result: HistoryResult;
  /** Transactions that reached the chain, in order, with what each did. */
  readonly transactions: readonly { readonly hash: Hex; readonly label: string }[];
  /** Hash of the transaction that carried the attestation, or `null` when none did. */
  readonly attestation: Hex | null;
  /**
   * Index of the transaction a sequential run stopped before, because a recheck refused or the page was left;
   * `null` otherwise. Entries written before this field existed read as `null`.
   */
  readonly stoppedBefore: number | null;
}

/** The parts of `Storage` used here, so that tests pass a map. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const RESULTS: readonly HistoryResult[] = ["complete", "partial", "none", "unverified", "unknown"];
const MAX_TEXT = 200;
const MAX_TRANSACTIONS = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function short(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
}

function isHash(value: unknown): value is Hex {
  return typeof value === "string" && HASH.test(value);
}

function entryOf(value: unknown): HistoryEntry | null {
  if (!isRecord(value) || !isRecord(value.index) || !Array.isArray(value.transactions)) return null;
  const { at, chainId, account, index, planHash, mode, result, transactions, attestation } = value;
  const stoppedBefore = value.stoppedBefore ?? null;
  const valid =
    typeof at === "number" &&
    Number.isSafeInteger(at) &&
    typeof chainId === "number" &&
    Number.isSafeInteger(chainId) &&
    chainId > 0 &&
    typeof account === "string" &&
    ADDRESS.test(account) &&
    short(index.identifier) &&
    short(index.name) &&
    isHash(index.indexId) &&
    typeof index.version === "number" &&
    Number.isSafeInteger(index.version) &&
    index.version >= 1 &&
    isHash(planHash) &&
    (mode === "atomic" || mode === "sequential") &&
    RESULTS.some((known) => known === result) &&
    transactions.length <= MAX_TRANSACTIONS &&
    transactions.every((item) => isRecord(item) && isHash(item.hash) && short(item.label)) &&
    (attestation === null || isHash(attestation)) &&
    (stoppedBefore === null ||
      (typeof stoppedBefore === "number" && Number.isSafeInteger(stoppedBefore) && stoppedBefore >= 0));
  if (!valid) return null;
  return {
    at,
    chainId,
    account: account as Address,
    index: {
      identifier: index.identifier as string,
      name: index.name as string,
      indexId: index.indexId as Hex,
      version: index.version as number,
    },
    planHash,
    mode,
    result: result as HistoryResult,
    transactions: transactions.map((item) => ({ hash: item.hash as Hex, label: item.label as string })),
    attestation: attestation as Hex | null,
    stoppedBefore: stoppedBefore as number | null,
  };
}

/** Every well-formed entry of a stored value, newest first. Anything else is dropped. */
export function parseHistory(text: string | null): HistoryEntry[] {
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return [];
  return parsed.entries
    .map(entryOf)
    .filter((entry): entry is HistoryEntry => entry !== null)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_HISTORY_ENTRIES);
}

/** The entries of one account, newest first. A storage that cannot be read gives none. */
export function readHistory(store: KeyValueStore | null, account: Address): HistoryEntry[] {
  try {
    const all = parseHistory(store?.getItem(HISTORY_STORAGE_KEY) ?? null);
    return all.filter((entry) => entry.account === account.toLowerCase());
  } catch {
    return [];
  }
}

/** Adds an entry, replacing the one of the same plan and account. Storage is a convenience: when it cannot be written, nothing is recorded and nothing fails. */
export function appendHistory(store: KeyValueStore | null, entry: HistoryEntry): void {
  if (store === null) return;
  try {
    const normalized: HistoryEntry = { ...entry, account: entry.account.toLowerCase() as Address };
    // One entry per plan: a later record of the same plan (its optional attestation) replaces the earlier one.
    const earlier = parseHistory(store.getItem(HISTORY_STORAGE_KEY)).filter(
      (other) => !(other.planHash === normalized.planHash && other.account === normalized.account),
    );
    const entries = [normalized, ...earlier].slice(0, MAX_HISTORY_ENTRIES);
    store.setItem(HISTORY_STORAGE_KEY, JSON.stringify({ entries }));
  } catch {
    // A full or blocked storage records nothing.
  }
}

/** `localStorage`, or `null` where the browser refuses access to it. */
export function browserStore(): KeyValueStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

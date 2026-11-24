/**
 * Checks on what a mined transaction or batch did, from its receipts. Pure. A receipt that says `success`
 * proves only that nothing reverted; these checks establish that it was the expected transaction and that
 * the tokens moved within the plan's bounds. A check that fails leaves the transaction `unverified`: mined, and
 * not presented as done.
 */
import { rebalanceLogAbi } from "@equityos/contracts-abi";
import { type Address, decodeEventLog, type Hex, isAddressEqual, parseAbi } from "viem";
import type { Verification } from "@/lib/tx/run";
import type { AttestationCall } from "./attestation";
import type { VerifiedCall } from "./verify";

/** A log as both transaction receipts and EIP-5792 call receipts carry it. */
export interface LogLike {
  readonly address: Address;
  readonly data: Hex;
  readonly topics: readonly Hex[];
}

/** The parts of a receipt the checks read. Both viem's transaction receipts and EIP-5792 call receipts have them. */
export interface ReceiptLike {
  readonly status: "success" | "reverted";
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly logs: readonly LogLike[];
}

/** A transaction receipt, which also names the sender and the contract called. */
export interface TransactionReceiptLike extends ReceiptLike {
  readonly from: Address;
  readonly to: Address | null;
}

/** A `RebalanceRecorded` event decoded from a receipt, emitted by the expected log contract. */
export interface RecordedAttestation {
  readonly log: Address;
  readonly account: Address;
  readonly indexId: Hex;
  readonly version: number;
  readonly transactionHash: Hex;
}

export interface ReceiptsCheck {
  readonly transactionHashes: readonly Hex[];
  /** Block of the last receipt: balances read at or after it include the effect. */
  readonly blockNumber: bigint;
  readonly attestation: RecordedAttestation | null;
}

/** Bounds the token transfers of a set of calls must respect, per token. */
interface TransferBounds {
  /** Most the account may send of each token: the exact amounts the swaps pull. */
  readonly maxOut: Map<string, bigint>;
  /** Least the account must receive of each token: the minimum amounts out. */
  readonly minIn: Map<string, bigint>;
}

/** The topics of a log as `decodeEventLog` takes them, or `null` for a log without topics. */
function topicsOf(log: LogLike): [Hex, ...Hex[]] | null {
  const [signature, ...rest] = log.topics;
  return signature === undefined ? null : [signature, ...rest];
}

/**
 * Only the `Transfer` event: `decodeEventLog` picks the event of the ABI by the log's signature, so an ABI with
 * other events (an `Approval`) would decode those too, under their own argument names.
 */
const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

/** The ERC-20 `Transfer` events of `logs`. A log that does not decode strictly as one is not one. */
function transfersIn(logs: readonly LogLike[]) {
  return logs.flatMap((log) => {
    const topics = topicsOf(log);
    if (topics === null) return [];
    try {
      const { args } = decodeEventLog({
        abi: transferAbi,
        eventName: "Transfer",
        data: log.data,
        topics,
        strict: true,
      });
      return [{ token: log.address, ...args }];
    } catch {
      return [];
    }
  });
}

/** The `RebalanceRecorded` events of `logs`, with the address that emitted each. */
function recordsIn(logs: readonly LogLike[]) {
  return logs.flatMap((log) => {
    const topics = topicsOf(log);
    if (topics === null) return [];
    try {
      const { args } = decodeEventLog({
        abi: rebalanceLogAbi,
        eventName: "RebalanceRecorded",
        data: log.data,
        topics,
        strict: true,
      });
      return [{ emitter: log.address, ...args }];
    } catch {
      return [];
    }
  });
}

function key(address: string): string {
  return address.toLowerCase();
}

function boundsOf(calls: readonly VerifiedCall[]): TransferBounds {
  const maxOut = new Map<string, bigint>();
  const minIn = new Map<string, bigint>();
  for (const call of calls) {
    if (call.kind !== "swap") continue;
    maxOut.set(key(call.tokenIn), (maxOut.get(key(call.tokenIn)) ?? 0n) + call.amountIn);
    minIn.set(key(call.tokenOut), (minIn.get(key(call.tokenOut)) ?? 0n) + call.minAmountOut);
  }
  return { maxOut, minIn };
}

/**
 * Compares the `Transfer` events of the receipts with the bounds of the swaps: for each token, the account sent
 * at most what the swaps pull and received at least their minimum. Returns the first token out of bounds.
 */
function transferViolation(receipts: readonly ReceiptLike[], account: Address, calls: readonly VerifiedCall[]) {
  const { maxOut, minIn } = boundsOf(calls);
  const sent = new Map<string, bigint>();
  const received = new Map<string, bigint>();
  const logs = receipts.flatMap((receipt) => receipt.logs);
  for (const transfer of transfersIn(logs)) {
    const token = key(transfer.token);
    if (isAddressEqual(transfer.from, account)) sent.set(token, (sent.get(token) ?? 0n) + transfer.value);
    if (isAddressEqual(transfer.to, account)) received.set(token, (received.get(token) ?? 0n) + transfer.value);
  }
  for (const [token, limit] of maxOut) {
    // A token the plan sells and also receives (USDC, in a plan that sells and buys) is bounded by its net flow.
    const net = (sent.get(token) ?? 0n) - (received.get(token) ?? 0n);
    if ((minIn.has(token) ? net : (sent.get(token) ?? 0n)) > limit) return `sent_above_plan:${token}`;
  }
  for (const [token, minimum] of minIn) {
    const net = (received.get(token) ?? 0n) - (sent.get(token) ?? 0n);
    const spent = maxOut.get(token) ?? 0n;
    // Net of what the plan itself spends of the token, the account received at least the minimum.
    if (net + spent < minimum) return `received_below_minimum:${token}`;
  }
  return null;
}

/** The `RebalanceRecorded` events of the receipts emitted by `log`. */
function attestationsIn(receipts: readonly ReceiptLike[], log: Address): RecordedAttestation[] {
  return receipts.flatMap((receipt) =>
    recordsIn(receipt.logs)
      .filter((record) => isAddressEqual(record.emitter, log))
      .map((record) => ({
        log: record.emitter,
        account: record.account,
        indexId: record.indexId,
        version: record.version,
        transactionHash: receipt.transactionHash,
      })),
  );
}

/** Exactly one `RebalanceRecorded` from the log, for the account, the index and the version of the plan. */
function attestationViolation(found: readonly RecordedAttestation[], account: Address, expected: AttestationCall) {
  const [only, ...others] = found;
  if (only === undefined || others.length > 0) return "attestation_count";
  const matches =
    isAddressEqual(only.account, account) &&
    only.indexId.toLowerCase() === expected.indexId.toLowerCase() &&
    only.version === expected.version;
  return matches ? null : "attestation_mismatch";
}

const REASONS: Record<string, string> = {
  status: "A receipt of the batch does not report success.",
  empty: "The wallet reported the batch as done without any receipt.",
  from: "The transaction was not sent from the connected account.",
  to: "The transaction was not addressed to the contract of the call.",
  attestation_count: "The receipts do not contain exactly one attestation event from the rebalance log.",
  attestation_mismatch: "The attestation event names another account, index or version than the plan.",
};

function reasonText(code: string): string {
  if (code.startsWith("sent_above_plan:")) {
    return `The account sent more of ${code.slice(16)} than the swaps pull, by the Transfer events of the receipts.`;
  }
  if (code.startsWith("received_below_minimum:")) {
    return `The account received less of ${code.slice(23)} than the minimum amounts out, by the Transfer events of the receipts.`;
  }
  return REASONS[code] ?? "A check on the receipts failed.";
}

function settle(
  receipts: readonly ReceiptLike[],
  attestation: RecordedAttestation | null,
): Verification<ReceiptsCheck> {
  if (receipts.length === 0) return { ok: false, reason: reasonText("empty") };
  let blockNumber = 0n;
  for (const receipt of receipts) if (receipt.blockNumber > blockNumber) blockNumber = receipt.blockNumber;
  return {
    ok: true,
    result: { transactionHashes: receipts.map((receipt) => receipt.transactionHash), blockNumber, attestation },
  };
}

/**
 * Checks the receipts of an atomic batch: every receipt succeeded, the token transfers respect the swaps'
 * bounds, and, when the attestation was part of the batch, it was recorded once for this account. The sender
 * of a batch receipt can be a bundler, so it is not compared; the attestation's `account` is `msg.sender` of
 * the log, which proves the calls ran from the user's account.
 */
export function checkBatchReceipts(
  receipts: readonly ReceiptLike[],
  expected: {
    readonly account: Address;
    readonly calls: readonly VerifiedCall[];
    readonly attestation: AttestationCall | null;
  },
): Verification<ReceiptsCheck> {
  if (receipts.length === 0) return { ok: false, reason: reasonText("empty") };
  if (receipts.some((receipt) => receipt.status !== "success")) return { ok: false, reason: reasonText("status") };
  const transfers = transferViolation(receipts, expected.account, expected.calls);
  if (transfers !== null) return { ok: false, reason: reasonText(transfers) };
  if (expected.attestation === null) return settle(receipts, null);
  const found = attestationsIn(receipts, expected.attestation.to);
  const violation = attestationViolation(found, expected.account, expected.attestation);
  return violation === null ? settle(receipts, found[0] ?? null) : { ok: false, reason: reasonText(violation) };
}

/**
 * Checks the receipt of one transaction of the sequential path: success, sent from the account, addressed to
 * the call's contract, and for a swap, transfers within its bounds; for the attestation, its event.
 */
export function checkTransactionReceipt(
  receipt: TransactionReceiptLike,
  expected: {
    readonly account: Address;
    readonly to: Address;
    readonly call: VerifiedCall | null;
    readonly attestation: AttestationCall | null;
  },
): Verification<ReceiptsCheck> {
  if (receipt.status !== "success") return { ok: false, reason: reasonText("status") };
  if (!isAddressEqual(receipt.from, expected.account)) return { ok: false, reason: reasonText("from") };
  if (receipt.to === null || !isAddressEqual(receipt.to, expected.to)) return { ok: false, reason: reasonText("to") };
  if (expected.call !== null) {
    const transfers = transferViolation([receipt], expected.account, [expected.call]);
    if (transfers !== null) return { ok: false, reason: reasonText(transfers) };
  }
  if (expected.attestation === null) return settle([receipt], null);
  const found = attestationsIn([receipt], expected.attestation.to);
  const violation = attestationViolation(found, expected.account, expected.attestation);
  return violation === null ? settle([receipt], found[0] ?? null) : { ok: false, reason: reasonText(violation) };
}

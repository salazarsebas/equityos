import { describe, expect, test } from "bun:test";
import { indexRegistryAbi } from "@equityos/contracts-abi";
import { encodeErrorResult, parseAbi } from "viem";
import { classifyTxError, decodeRevertData, findRevertData, txFailureMessage } from "../../src/lib/tx/errors";

const INDEX_ID = `0x${"ab".repeat(32)}` as const;
const CALLER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const exists = encodeErrorResult({ abi: indexRegistryAbi, errorName: "IndexAlreadyExists", args: [INDEX_ID] });
const wrap = (inner: unknown) =>
  Object.assign(new Error("outer"), { name: "ContractFunctionExecutionError", cause: inner });

describe("decodeRevertData", () => {
  test("decodes every custom error the publish path can hit, with its arguments", () => {
    expect(decodeRevertData(indexRegistryAbi, exists)).toEqual({
      kind: "contract_error",
      name: "IndexAlreadyExists",
      args: [INDEX_ID],
    });
    const notCreator = encodeErrorResult({ abi: indexRegistryAbi, errorName: "NotCreator", args: [INDEX_ID, CALLER] });
    expect(decodeRevertData(indexRegistryAbi, notCreator)).toEqual({
      kind: "contract_error",
      name: "NotCreator",
      args: [INDEX_ID, CALLER],
    });
    const version = encodeErrorResult({ abi: indexRegistryAbi, errorName: "UnexpectedVersion", args: [2, 3] });
    expect(decodeRevertData(indexRegistryAbi, version)).toMatchObject({ name: "UnexpectedVersion", args: [2, 3] });
    const deprecated = encodeErrorResult({ abi: indexRegistryAbi, errorName: "IndexIsDeprecated", args: [INDEX_ID] });
    expect(decodeRevertData(indexRegistryAbi, deprecated)).toMatchObject({ name: "IndexIsDeprecated" });
    const sum = encodeErrorResult({ abi: indexRegistryAbi, errorName: "InvalidWeightSum", args: [9_999n] });
    expect(decodeRevertData(indexRegistryAbi, sum)).toMatchObject({ name: "InvalidWeightSum", args: [9_999n] });
  });

  test("a plain reason and a panic are reverts with their text", () => {
    const abi = parseAbi(["error Error(string)", "error Panic(uint256)"]);
    const reason = encodeErrorResult({ abi, errorName: "Error", args: ["nope"] });
    expect(decodeRevertData(indexRegistryAbi, reason)).toEqual({ kind: "revert", reason: "nope" });
    const panic = encodeErrorResult({ abi, errorName: "Panic", args: [17n] });
    expect(decodeRevertData(indexRegistryAbi, panic)).toEqual({ kind: "revert", reason: "panic 17" });
  });

  test("data no error of the ABI matches is a revert without a reason", () => {
    expect(decodeRevertData(indexRegistryAbi, "0xdeadbeef")).toEqual({ kind: "revert", reason: null });
  });
});

describe("findRevertData", () => {
  test("finds the data wherever a library or a node put it", () => {
    expect(findRevertData(wrap({ data: exists }))).toBe(exists);
    expect(findRevertData(wrap(wrap({ code: 3, data: { data: exists } })))).toBe(exists);
    expect(findRevertData(wrap({ raw: exists, data: { errorName: "Wrong" } }))).toBe(exists);
    expect(findRevertData(wrap({ data: "not hex" }))).toBeNull();
    expect(findRevertData("failed")).toBeNull();
  });
});

describe("classifyTxError", () => {
  test("a rejection wins over everything else", () => {
    expect(classifyTxError(indexRegistryAbi, wrap({ code: 4001, data: exists }))).toEqual({ kind: "user_rejected" });
    const named = Object.assign(new Error("x"), { name: "UserRejectedRequestError" });
    expect(classifyTxError(indexRegistryAbi, named)).toEqual({ kind: "user_rejected" });
  });

  test("revert data is decoded with the given ABI, not taken from a decoding made elsewhere", () => {
    const error = wrap({ name: "ContractFunctionRevertedError", data: { errorName: "SomethingElse" }, raw: exists });
    expect(classifyTxError(indexRegistryAbi, error)).toMatchObject({
      kind: "contract_error",
      name: "IndexAlreadyExists",
    });
  });

  test("classifies the wallet and node conditions", () => {
    expect(classifyTxError(indexRegistryAbi, { code: -32002 })).toEqual({ kind: "wallet_busy" });
    expect(classifyTxError(indexRegistryAbi, wrap({ name: "ChainMismatchError" }))).toEqual({ kind: "chain_mismatch" });
    expect(classifyTxError(indexRegistryAbi, new Error("Insufficient funds for gas * price + value"))).toEqual({
      kind: "insufficient_funds",
    });
    expect(classifyTxError(indexRegistryAbi, wrap({ name: "ContractFunctionRevertedError" }))).toEqual({
      kind: "revert",
      reason: null,
    });
    expect(classifyTxError(indexRegistryAbi, new Error("socket hang up"))).toEqual({ kind: "unknown" });
  });
});

describe("txFailureMessage", () => {
  test("never repeats raw error text and always says nothing was sent", () => {
    for (const failure of [
      { kind: "user_rejected" },
      { kind: "contract_error", name: "EmptySpec", args: [] },
      { kind: "revert", reason: null },
      { kind: "revert", reason: "nope" },
      { kind: "insufficient_funds" },
      { kind: "wallet_busy" },
      { kind: "chain_mismatch" },
      { kind: "unknown" },
    ] as const) {
      expect(txFailureMessage(failure)).toEndWith("Nothing was sent.");
    }
  });
});

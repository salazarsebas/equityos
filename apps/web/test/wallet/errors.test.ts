import { describe, expect, test } from "bun:test";
import { isMethodUnsupported, walletErrorMessage, walletErrorSignature } from "../../src/lib/wallet/errors";

const rpcError = (code: number, name = "Error") => Object.assign(new Error("raw wallet text"), { code, name });

describe("walletErrorSignature", () => {
  test("collects codes and names along the chain of causes", () => {
    const error = Object.assign(new Error("outer", { cause: rpcError(4001, "UserRejectedRequestError") }), {
      name: "ConnectorError",
    });
    const { codes, names } = walletErrorSignature(error);
    expect([...codes]).toEqual([4001]);
    expect([...names]).toEqual(["ConnectorError", "UserRejectedRequestError"]);
  });

  test("stops on a cycle and ignores what is not an object", () => {
    const loop: { code: number; cause?: unknown } = { code: 1 };
    loop.cause = loop;
    expect([...walletErrorSignature(loop).codes]).toEqual([1]);
    expect(walletErrorSignature("failed").codes.size).toBe(0);
    expect(isMethodUnsupported(walletErrorSignature(null))).toBe(false);
  });
});

describe("walletErrorMessage", () => {
  test("a declined request says so and states what did not change", () => {
    expect(walletErrorMessage(rpcError(4001), "switch")).toBe(
      "The request was declined in the wallet. The network was not changed.",
    );
    expect(walletErrorMessage(rpcError(4001), "connect")).toBe(
      "The request was declined in the wallet. No wallet was connected.",
    );
    expect(walletErrorMessage({ name: "UserRejectedRequestError" }, "connect")).toContain("declined");
  });

  test("a wallet that cannot switch is told apart from one that did not", () => {
    const cannot = "This wallet cannot change network from here. Select Base in the wallet itself.";
    expect(walletErrorMessage(rpcError(4200), "switch")).toBe(cannot);
    expect(walletErrorMessage(rpcError(-32601), "switch")).toBe(cannot);
    expect(walletErrorMessage(rpcError(4902), "switch")).toBe(cannot);
    expect(walletErrorMessage({ name: "SwitchChainNotSupportedError" }, "switch")).toBe(cannot);
    expect(walletErrorMessage(new Error("boom"), "switch")).toBe(
      "The wallet did not change network. Select Base in the wallet itself.",
    );
  });

  test("a request already waiting in the wallet is named", () => {
    expect(walletErrorMessage(rpcError(-32002), "connect")).toContain("already has a request waiting");
  });

  test("never shows the raw text of the wallet", () => {
    for (const action of ["connect", "switch"] as const) {
      for (const error of [rpcError(4001), rpcError(4200), rpcError(-32603), new Error("raw wallet text"), null]) {
        expect(walletErrorMessage(error, action)).not.toContain("raw wallet text");
      }
    }
    expect(walletErrorMessage({ name: "ProviderNotFoundError" }, "connect")).toContain("not found in the browser");
    expect(walletErrorMessage(undefined, "connect")).toBe(
      "The wallet did not connect. Try again or choose another wallet.",
    );
  });
});

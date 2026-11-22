import type { Page } from "@playwright/test";
import { type Address, decodeFunctionData, encodeFunctionResult, type Hex, multicall3Abi, parseAbi } from "viem";

/** The first account of the standard development mnemonic. It holds nothing of value on any network. */
export const TEST_ACCOUNT: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

export interface MockWallet {
  /** Chain the wallet starts on, as a number. */
  readonly chainId: number;
  /** Answer of `wallet_getCapabilities`, keyed by hex chain id. `null` makes the method unsupported. */
  readonly capabilities?: Record<string, unknown> | null;
  /** Makes `wallet_switchEthereumChain` fail as a wallet does when the user declines. */
  readonly rejectSwitch?: boolean;
}

/**
 * Installs a wallet in the page before any script runs: an EIP-1193 provider announced through EIP-6963 under
 * the name "Test Wallet". It answers the account, chain and capability methods and nothing that signs or sends.
 * Its state is kept in `sessionStorage`, so it survives a reload the way an extension does.
 */
export async function installMockWallet(page: Page, wallet: MockWallet): Promise<void> {
  await page.addInitScript(
    ({ account, chainId, capabilities, rejectSwitch }) => {
      const KEY = "mock-wallet";
      const stored = sessionStorage.getItem(KEY);
      const state: { connected: boolean; chainId: number } = stored
        ? JSON.parse(stored)
        : { connected: false, chainId };
      const save = () => sessionStorage.setItem(KEY, JSON.stringify(state));
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      const emit = (event: string, payload: unknown) => {
        for (const listener of listeners.get(event) ?? []) listener(payload);
      };
      const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });

      const provider = {
        async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
          switch (method) {
            case "eth_requestAccounts":
              state.connected = true;
              save();
              return [account];
            case "eth_accounts":
              return state.connected ? [account] : [];
            case "eth_chainId":
              return `0x${state.chainId.toString(16)}`;
            case "wallet_switchEthereumChain": {
              if (rejectSwitch) throw rpcError(4001, "User rejected the request.");
              const [target] = params as [{ chainId: string }];
              state.chainId = Number(target.chainId);
              save();
              emit("chainChanged", target.chainId);
              return null;
            }
            case "wallet_getCapabilities":
              if (capabilities === null) throw rpcError(4200, "Unsupported method");
              return capabilities;
            case "wallet_revokePermissions":
              state.connected = false;
              save();
              return null;
            default:
              throw rpcError(4200, `Unsupported method: ${method}`);
          }
        },
        on(event: string, listener: (payload: unknown) => void) {
          listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
        },
        removeListener(event: string, listener: (payload: unknown) => void) {
          listeners.get(event)?.delete(listener);
        },
      };

      const icon =
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='5' fill='%231d3fbf'/%3E%3Cpath d='M7 12h10M12 7v10' stroke='%23fff' stroke-width='2'/%3E%3C/svg%3E";
      const detail = Object.freeze({
        info: {
          uuid: "6f1f8f0c-5e0a-4d0e-9f43-1d6f4a8f2b11",
          name: "Test Wallet",
          icon,
          rdns: "org.equityos.testwallet",
        },
        provider,
      });
      const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    },
    {
      account: TEST_ACCOUNT,
      chainId: wallet.chainId,
      capabilities:
        wallet.capabilities === undefined ? { "0x2105": { atomic: { status: "supported" } } } : wallet.capabilities,
      rejectSwitch: wallet.rejectSwitch ?? false,
    },
  );
}

const balanceOfAbi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

interface RpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params?: readonly unknown[];
}

/**
 * Answers the browser's Base mainnet JSON-RPC requests, so that no test reaches a network. Balances are served
 * through Multicall3 `aggregate3`, the one contract call the app makes from the browser: `balances` maps a
 * lowercase token address to base units, and a token that is not in it has a zero balance.
 *
 * @returns the methods that were requested, in order
 */
export async function mockBaseRpc(page: Page, balances: Readonly<Record<string, bigint>>): Promise<string[]> {
  const methods: string[] = [];

  function answer({ method, params }: RpcRequest): Hex {
    methods.push(method);
    if (method === "eth_chainId") return "0x2105";
    if (method !== "eth_call") throw new Error(`Unexpected JSON-RPC method in a test: ${method}`);
    const [{ data }] = params as [{ data: Hex }];
    const { args } = decodeFunctionData({ abi: multicall3Abi, data });
    const calls = args[0] as readonly { target: Address; callData: Hex }[];
    const results = calls.map(({ target, callData }) => {
      decodeFunctionData({ abi: balanceOfAbi, data: callData });
      const balance = balances[target.toLowerCase()] ?? 0n;
      return { success: true, returnData: encodeFunctionResult({ abi: balanceOfAbi, result: balance }) };
    });
    return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
  }

  await page.route("https://mainnet.base.org/**", async (route) => {
    const body: RpcRequest | RpcRequest[] = route.request().postDataJSON();
    const respond = (request: RpcRequest) => ({ jsonrpc: "2.0", id: request.id, result: answer(request) });
    await route.fulfill({ json: Array.isArray(body) ? body.map(respond) : respond(body) });
  });
  return methods;
}

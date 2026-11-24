import type { Page } from "@playwright/test";
import { type Address, decodeFunctionData, encodeFunctionResult, type Hex, multicall3Abi, parseAbi } from "viem";
import { REFERENCE_FEEDS } from "../src/lib/market/feeds";

/** The first account of the standard development mnemonic. It holds nothing of value on any network. */
export const TEST_ACCOUNT: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

export interface MockWallet {
  /** Chain the wallet starts on, as a number. */
  readonly chainId: number;
  /** Answer of `wallet_getCapabilities`, keyed by hex chain id. `null` makes the method unsupported. */
  readonly capabilities?: Record<string, unknown> | null;
  /** Makes `wallet_switchEthereumChain` fail as a wallet does when the user declines. */
  readonly rejectSwitch?: boolean;
  /**
   * JSON-RPC endpoint of a local Anvil node. When set, `eth_sendTransaction` is forwarded to it and Anvil signs
   * for its own unlocked development account: this provider holds no key and signs nothing itself.
   */
  readonly signer?: string;
  /** Makes `eth_sendTransaction` and `wallet_sendCalls` fail as a wallet does when the user declines. */
  readonly rejectSend?: boolean;
  /**
   * Gas limit, as a hex quantity, given to a transaction that has none, so that Anvil mines a transaction that
   * reverts instead of refusing it at estimation, as a wallet does when the user confirms it anyway.
   */
  readonly sendGas?: Hex;
  /** Milliseconds the wallet waits before it sends each transaction, as a person takes time to confirm. */
  readonly sendDelayMs?: number;
}

/**
 * Installs a wallet in the page before any script runs: an EIP-1193 provider announced through EIP-6963 under
 * the name "Test Wallet". It answers the account, chain and capability methods. It signs nothing: a transaction
 * is refused unless `signer` names a local Anvil node, which then signs it for its unlocked development account.
 * Its state is kept in `sessionStorage`, so it survives a reload the way an extension does.
 *
 * With a `signer`, it also answers `wallet_sendCalls` (EIP-5792) for an atomic batch: it refuses a request
 * without `atomicRequired` or for another chain, takes an Anvil snapshot, sends the calls in order from the
 * account and reverts to the snapshot if any of them reverts, so that the batch takes effect entirely or not at
 * all. A `dataSuffix` capability is appended to every call it sends, as a wallet appends it to the transaction it
 * builds. Each request is recorded under `mock-wallet-batches` in `sessionStorage` for the test to read.
 */
export async function installMockWallet(page: Page, wallet: MockWallet): Promise<void> {
  await page.addInitScript(
    ({ account, chainId, capabilities, rejectSwitch, signer, rejectSend, sendGas, sendDelayMs }) => {
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
      const forward = async (method: string, params: unknown[]): Promise<unknown> => {
        if (signer === null) throw rpcError(4200, `Unsupported method: ${method}`);
        const response = await fetch(signer, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const body: { result?: unknown; error?: { code: number; message: string; data?: unknown } } =
          await response.json();
        if (body.error) throw Object.assign(rpcError(body.error.code, body.error.message), { data: body.error.data });
        return body.result;
      };
      const withGas = (transaction: Record<string, unknown>) =>
        sendGas === null || transaction.gas !== undefined ? transaction : { ...transaction, gas: sendGas };
      const BATCHES = "mock-wallet-batches";
      let queue: Promise<unknown> = Promise.resolve();

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
            case "eth_sendTransaction": {
              if (rejectSend) throw rpcError(4001, "User rejected the request.");
              const [transaction] = params as [Record<string, unknown>];
              // One request at a time, in the order they arrive, as a wallet queues its confirmations: the node
              // then gives each transaction its own nonce.
              const sent = queue.then(async () => {
                if (sendDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, sendDelayMs));
                return forward(method, [withGas(transaction)]);
              });
              queue = sent.catch(() => undefined);
              return sent;
            }
            case "wallet_sendCalls": {
              if (rejectSend) throw rpcError(4001, "User rejected the request.");
              if (signer === null) throw rpcError(4200, "Unsupported method: wallet_sendCalls");
              const [request] = params as [
                {
                  chainId: string;
                  from: string;
                  atomicRequired: boolean;
                  calls: { to: string; data?: string; value?: string }[];
                  capabilities?: { dataSuffix?: { value: string } };
                },
              ];
              const recorded: unknown[] = JSON.parse(sessionStorage.getItem(BATCHES) ?? "[]");
              sessionStorage.setItem(BATCHES, JSON.stringify([...recorded, request]));
              if (request.atomicRequired !== true) throw rpcError(5700, "This wallet only sends atomic batches.");
              if (Number(request.chainId) !== state.chainId) throw rpcError(5710, "Unsupported chain id.");
              const suffix = request.capabilities?.dataSuffix?.value.slice(2) ?? "";
              const snapshot = await forward("evm_snapshot", []);
              const receipts: { status: string }[] = [];
              const undo = async (error: unknown) => {
                await forward("evm_revert", [snapshot]);
                throw error;
              };
              for (const call of request.calls) {
                const hash = await forward("eth_sendTransaction", [
                  withGas({
                    from: request.from,
                    to: call.to,
                    data: `${call.data ?? "0x"}${suffix}`,
                    value: call.value,
                  }),
                ]).catch(undo);
                const receipt = (await forward("eth_getTransactionReceipt", [hash]).catch(undo)) as { status: string };
                receipts.push(receipt);
                if (receipt.status !== "0x1") break;
              }
              const succeeded = receipts.every((receipt) => receipt.status === "0x1");
              if (!succeeded) await forward("evm_revert", [snapshot]);
              const id = `0x${crypto.randomUUID().replaceAll("-", "")}`;
              sessionStorage.setItem(
                `mock-wallet-batch:${id}`,
                JSON.stringify({
                  status: succeeded ? 200 : 500,
                  receipts: succeeded ? receipts : [],
                  chainId: request.chainId,
                }),
              );
              return { id };
            }
            case "wallet_getCallsStatus": {
              const [id] = params as [string];
              const stored = sessionStorage.getItem(`mock-wallet-batch:${id}`);
              if (stored === null) throw rpcError(5730, "Unknown bundle id.");
              const batch = JSON.parse(stored) as { status: number; receipts: unknown[]; chainId: string };
              return {
                version: "2.0.0",
                id,
                chainId: batch.chainId,
                atomic: true,
                status: batch.status,
                receipts: batch.receipts,
              };
            }
            // Test control, not a wallet method: changes the chain without telling the page, as a wallet whose
            // network is changed in another tab or window may do before the page hears of it.
            case "test_setChainSilently": {
              const [target] = params as [number];
              state.chainId = target;
              save();
              return null;
            }
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
      signer: wallet.signer ?? null,
      rejectSend: wallet.rejectSend ?? false,
      sendGas: wallet.sendGas ?? null,
      sendDelayMs: wallet.sendDelayMs ?? 0,
    },
  );
}

const readAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/** Number of the latest block the mock reports: a Base mainnet height, after Multicall3 was deployed there. */
const BLOCK_NUMBER = "0x3abe17e";

/** USDC on Base mainnet, lowercase: 6 decimals. Every other token in these tests has 8. */
const USDC_TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

interface RpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params?: readonly unknown[];
}

/**
 * Answers the browser's Base mainnet JSON-RPC requests, so that no test reaches a network. Balances are served
 * through Multicall3 `aggregate3`, the one contract call the app makes from the browser: `balances` maps a
 * lowercase token address to base units, and a token that is not in it has a zero balance. The execution review's
 * reads are answered too: `decimals()` (6 for USDC, 8 for any other token), and the pinned feeds, which answer
 * their description and `options.prices` with a round a minute before the latest block, whose timestamp is
 * `options.blockTimestamp`.
 *
 * @returns the methods that were requested, in order
 */
export async function mockBaseRpc(
  page: Page,
  balances: Readonly<Record<string, bigint>>,
  options: {
    /** Timestamp of the latest block, Unix seconds. */
    readonly blockTimestamp?: number;
    /** Answer of the pinned feed of each token, by lowercase token. A feed of a token not in it fails to read. */
    readonly prices?: Readonly<Record<string, bigint>>;
  } = {},
): Promise<string[]> {
  const blockTimestamp = options.blockTimestamp ?? 1_800_000_000;
  const feedOf = new Map([...REFERENCE_FEEDS].map(([token, feed]) => [feed.proxy.toLowerCase(), { token, feed }]));
  const methods: string[] = [];

  function answer({ method, params }: RpcRequest): unknown {
    methods.push(method);
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_blockNumber") return BLOCK_NUMBER;
    if (method === "eth_getBlockByNumber") {
      return {
        number: BLOCK_NUMBER,
        hash: `0x${"11".repeat(32)}`,
        parentHash: `0x${"22".repeat(32)}`,
        timestamp: `0x${blockTimestamp.toString(16)}`,
        gasLimit: "0x1c9c380",
        gasUsed: "0x0",
        transactions: [],
      };
    }
    if (method !== "eth_call") throw new Error(`Unexpected JSON-RPC method in a test: ${method}`);
    const [{ data }] = params as [{ data: Hex }];
    const { args } = decodeFunctionData({ abi: multicall3Abi, data });
    const calls = args[0] as readonly { target: Address; callData: Hex }[];
    const results = calls.map(({ target, callData }) => {
      const { functionName } = decodeFunctionData({ abi: readAbi, data: callData });
      const address = target.toLowerCase();
      const feed = feedOf.get(address);
      const price = feed === undefined ? undefined : options.prices?.[feed.token];
      const ok = (returnData: Hex) => ({ success: true, returnData });
      switch (functionName) {
        case "balanceOf":
          return ok(encodeFunctionResult({ abi: readAbi, functionName, result: balances[address] ?? 0n }));
        case "decimals":
          return ok(encodeFunctionResult({ abi: readAbi, functionName, result: address === USDC_TOKEN ? 6 : 8 }));
        case "description":
          return feed === undefined
            ? { success: false, returnData: "0x" as Hex }
            : ok(encodeFunctionResult({ abi: readAbi, functionName, result: feed.feed.description }));
        case "latestRoundData": {
          if (price === undefined) return { success: false, returnData: "0x" as Hex };
          const updatedAt = BigInt(blockTimestamp - 60);
          return ok(
            encodeFunctionResult({ abi: readAbi, functionName, result: [7n, price, updatedAt, updatedAt, 7n] }),
          );
        }
      }
      throw new Error(`Unexpected contract call in a test: ${functionName}`);
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

/**
 * Moves the test wallet to another chain without emitting `chainChanged`, so the page still believes the old
 * chain. Only `installMockWallet` providers understand the call.
 */
export async function setChainSilently(page: Page, chainId: number): Promise<void> {
  await page.evaluate(async (target) => {
    const provider = await new Promise<{ request(args: { method: string; params: unknown[] }): Promise<unknown> }>(
      (resolve) => {
        window.addEventListener(
          "eip6963:announceProvider",
          (event) => resolve((event as CustomEvent<{ provider: never }>).detail.provider),
          { once: true },
        );
        window.dispatchEvent(new Event("eip6963:requestProvider"));
      },
    );
    await provider.request({ method: "test_setChainSilently", params: [target] });
  }, chainId);
}

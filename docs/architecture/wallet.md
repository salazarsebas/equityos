# Wallet connection

How the web app connects to a wallet, what it reads through it and what it never does. Everything described here
is implemented in `apps/web`: pure logic in `src/lib/wallet`, components and hooks in `src/components/wallet`, the
page in `src/app/wallet`.

This layer connects and reads. It does not send a transaction, request a signature or ask for an approval:
no code path in the app calls `sendTransaction`, `writeContract`, `sendCalls` or `signMessage`.

## What the app never does

- It never sees, stores or asks for a private key or a recovery phrase. Keys stay in the wallet.
- It never asks a wallet to sign or send anything without an explicit action by the user on a control that says
  what will happen. Connecting requests the public address only.
- It never requests an unlimited token approval. Flows that need an approval will request the exact amount.
- It never treats the connection as authentication. The cookie that remembers a connection is a claim by the
  browser: it decides what is rendered and nothing else.
- It never blocks reading. Every page works without a wallet, and any address can be looked up without one.

## Stack

| Package                            | Role                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `wagmi`, `@wagmi/core`             | Connection state, connectors, React hooks. `@wagmi/core` for `hydrate`. |
| `viem`                             | Chains, ABI encoding, JSON-RPC transport. One version in the workspace. |
| `@tanstack/react-query`            | Cache of reads: balances, capabilities, the status endpoint.            |
| `@base-org/account`                | SDK behind the Base Account connector. Loaded on first use.             |
| `@walletconnect/ethereum-provider` | Provider behind the WalletConnect connector. Loaded on first use.       |

There is no third-party connect dialog. The dialog, the account control and the menu are built from the design
system components.

EquityOS is not affiliated with the vendor of any wallet or SDK listed here. It uses their public interfaces.

## Chains and endpoints

`resolveNetworks` in `src/lib/wallet/chains.ts` returns the chains a wallet can be on, Base mainnet first:

| Chain        | Id    | Endpoint variable                  | Fallback                   |
| ------------ | ----- | ---------------------------------- | -------------------------- |
| Base         | 8453  | `NEXT_PUBLIC_BASE_RPC_URL`         | `https://mainnet.base.org` |
| Base Sepolia | 84532 | `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` | `https://sepolia.base.org` |
| Anvil        | 31337 | `NEXT_PUBLIC_ANVIL_RPC_URL`        | `http://127.0.0.1:8545`    |

The Anvil chain exists only when `NODE_ENV` is `development`. The fallbacks are public endpoints, rate limited and
best effort: a deployment must set the first two variables. A value that is not an http(s) URL throws when the
configuration is created, so a mistyped endpoint fails at once instead of falling back silently. These variables
are separate from the server's `BASE_RPC_URL` because they are compiled into the browser bundle.

Balances and reference prices are always those of Base mainnet, whatever chain the wallet is on. A wallet on a
chain that is not in the table is in the wrong network state: the account control marks it with a warning icon
and offers "Switch to Base", which calls `switchChain`. A wallet that declines, or that cannot switch from a
site, gets one sentence saying what happened and that nothing changed (`walletErrorMessage`). Raw wallet error
text is never shown.

## Connectors

`walletConnectors` in `src/lib/wallet/connectors.ts` is the only module that imports wallet SDKs.

| Connector      | When it is offered                                                                            |
| -------------- | --------------------------------------------------------------------------------------------- |
| Injected       | One entry per wallet that announces itself through EIP-6963, under its own name and icon.     |
| Browser wallet | The legacy `window.ethereum` provider, only when it exists and no wallet announced itself.    |
| Base Account   | Always. The connector is `baseAccount` from `wagmi/connectors`.                               |
| WalletConnect  | Only when `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set. Otherwise it is not rendered at all. |

`listWalletOptions` decides the list and its order. A wallet icon is rendered only when it is an image data URI,
which is what EIP-6963 requires, so the dialog never requests a remote image.

## Server rendering

The configuration follows the wagmi SSR guide for the App Router: `ssr: true`, cookie storage, and the cookie
turned into initial state on the server with `cookieToInitialState`.

1. The root layout calls `readWalletState` (`src/server/wallet-state.ts`), which reads the wagmi cookie of the
   request. `storedAccount` extracts the account from it, trusting nothing about its shape.
2. `WalletBootProvider` carries that state to the client. It holds data only and imports no wallet library.
3. The server renders a stand-in for each region that uses the wallet. In the top bar it is the same
   `AccountButton` the real control renders, showing the stored account. A connected visitor therefore gets
   their account in the first HTML: there is no disconnected state that corrects itself, and no hydration
   mismatch, because the server and the first client render both draw the stand-in from the same cookie state.
4. The regions themselves (`AccountControl`, `WalletView`) are loaded with `next/dynamic` and `ssr: false`. Each
   wraps itself in `WalletRuntime`, which creates the one wagmi configuration and query cache of the page on
   first use and calls `hydrate` with the cookie state. `hydrate` puts the state in place synchronously, so the
   first render of the region shows the same account as the stand-in, and then verifies it against the wallet.
5. A click on the stand-in before the control has loaded is remembered and replayed, and keyboard focus is handed
   over, so the stand-in is never a dead control.

Consequences worth knowing:

- Reading the cookie in the root layout makes every page render on request. No page is prerendered at build time.
- Wallet code is not in the first load of any page. It is fetched after the page is interactive. This is also
  why the regions are browser-only: the server bundle of `@base-org/account` does not build in this app.
- A visitor with no stored connection triggers no reconnection, so no wallet SDK is loaded for them until they
  open the dialog and choose that wallet. For a visitor with a stored connection, wagmi asks every configured
  connector whether it has a session, which loads the SDKs in the background.
- The cookies are `equityos.wallet.store` and `equityos.wallet.recentConnectorId`. They hold the connector, the
  accounts and the chain: public data.

A new region that needs the wallet follows the same pattern: a client component loaded with `ssr: false` that
renders `WalletRuntime` around its content, and a stand-in drawn from `useWalletBoot`.

## Capability detection

`useWalletCapabilities` reports whether the connected wallet can execute several calls as one atomic batch
through `wallet_sendCalls` (EIP-5792), for the connected account on the connected chain. It asks the wallet with
wagmi's `useCapabilities` (`wallet_getCapabilities`) and hands the answer, or the error, to pure functions in
`src/lib/wallet/capabilities.ts`.

| Mode         | Meaning for the user                  | Decided when                                                                             |
| ------------ | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `atomic`     | One confirmation for several steps    | `atomic.status` is `supported` or `ready`, or the legacy `atomicBatch.supported` is true |
| `sequential` | One confirmation per step             | `atomic` is `unsupported` or absent, or the wallet does not implement the method         |
| `unknown`    | Not determined, treated as sequential | No answer yet, a malformed answer, or a request that failed for another reason           |

Each result carries a `reason` that says which of these cases applied. Details:

- `ready` means the wallet batches once the user approves an account upgrade that the wallet itself proposes.
  It is reported as `atomic` with the reason `atomic_ready`, and the wallet page says so in words.
- The EIP states that a chain without the `atomic` capability does not support batching. That is `sequential`.
- An answer is keyed by chain id. Hex keys in any case and the numeric keys viem produces are accepted, and
  capabilities under `0x0` apply to every chain unless the entry of the chain overrides them.
- Two documented variants of real wallets are read: the status string under `atomic.supported` instead of
  `atomic.status`, and the pre-final capability name `atomicBatch` with a boolean `supported`.
- Support is never assumed. Anything that does not match a known shape is `unknown`.
- A wallet that answers `4200` or `-32601` does not implement the method and cannot batch: `sequential`. Any
  other failure says nothing about the wallet: `unknown`.

The unit tests feed the functions the example answer of the EIP and documented answers of two wallets.

## Reading balances

`useTokenBalances` reads the balances of an account for USDC and a given list of tokens on Base mainnet in one
Multicall3 call. Amounts are `bigint` base units paired with the decimals of the token. A token whose read fails
has a `null` balance, which is rendered as missing and never as zero.

- A read is reused for 30 seconds and is not repeated when the window regains focus.
- There is no polling. `refetchOnBlock` re-reads when a new block is seen, for a consumer that must follow the
  chain. Nothing uses it yet, and the wallet page offers a "Refresh balances" button instead.
- The states are `idle` (no account), `loading`, `error` (nothing to show) and `ready`, which carries the time
  of the read and whether the latest refresh failed.

USDC on Base mainnet is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, the address Circle publishes in its list of
USDC contract addresses. Its `symbol()` and `decimals()` answer `USDC` and `6`.

`summarizeBalances` values each balance at its reference price with `mulDivDown`, in USD scaled by 1e8, and
splits held from zero balances. No reference feed is mapped for USDC, so it is listed as a quantity without a
value, and the total says how many balances it leaves out. A value is an indication, not an executable price.

## Execution availability

`useExecutionAvailability` reads `GET /api/v1/status` and returns `executionAvailable` with a reason:
`restricted_jurisdiction`, `jurisdiction_unknown` or `not_released` from the endpoint, `checking` while the
answer is being read, and `status_unavailable` when it cannot be read or understood. The last two are
unavailable, because the gate fails closed. `EXECUTION_UNAVAILABLE_MESSAGES` has one sentence per reason.

Future actions that send a transaction are disabled with that sentence. Today it is shown as one line in the
connect dialog and in the account menu. It never gates connecting or reading.

## The wallet page

`/wallet` shows, for the connected account, its address, wallet, network, what batching means in confirmations,
and its balances of USDC and the index-eligible assets valued at reference prices. Zero balances are behind a
control. `/wallet?address=0x...` shows the balances of any address without a wallet. The address is validated on
the server, a wrong EIP-55 checksum is rejected, and a lookup page is marked `noindex`. The lookup form is a plain
GET form.

The asset list and the reference prices come from the server's market data layer, the same data
`GET /api/v1/assets?eligible=true` returns. Balances are read by the browser.

## Tests

- `apps/web/test/wallet`: unit tests of all pure logic and of the account button markup.
- `apps/web/e2e/wallet.e2e.ts`: Playwright against the production build. `e2e/wallet-support.ts` injects an
  EIP-1193 provider announced through EIP-6963 and answers the browser's JSON-RPC requests, so the tests reach no
  network. They cover the dialog, the full connect flow, the wrong network state, a declined switch, the stored
  connection in the first HTML after a reload, disconnecting, the wallet page and the 375 px layout.

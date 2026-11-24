# Sending an execution plan

The portfolio page can ask the user's wallet to sign the calls of an executable plan: exact approvals, swaps
through the aggregator router and, where the rebalance log is deployed, an attestation. This page describes that
write path, what protects each step and what remains trusted. The server side, which builds and checks the plan,
is in [Executable plan and pre-trade checks](../architecture/execution.md); what is verified of the provider's
calldata is in [Aggregator calldata](aggregator-calldata.md). The user-facing flow is in
[Portfolio and drift](../product/portfolio.md#executing-from-your-wallet).

This path has not been reviewed by an external party, and the contracts it can call have not been audited.

## What is at stake

The calls move the user's tokens. Calldata that is wrong or hostile could send bought tokens to someone else,
pull more than planned, accept any price, or approve a spender for more than the swap. A send at the wrong
moment could execute a stale quote, on the wrong network, from the wrong account, or a second time.

## The trust boundary

The browser does not sign calldata it has not verified itself. The server's checks protect what the server
returns; the browser takes nothing from the answer on trust and verifies it again, with the same pure module the
server uses, against the account that will sign.

| Step | What happens                                                                                       | Safeguard                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | The gate is read from `GET /api/v1/status`                                                         | Where execution is unavailable, the prepare action is not rendered and the reason is shown. The gate fails closed                                             |
| 2    | "Prepare to execute" posts the comparison to `POST /api/v1/portfolio/execution-plan`               | Offered only to the connected account that owns the compared address. Preparing signs and sends nothing                                                       |
| 3    | The answer is parsed strictly (`lib/execution/response.ts`)                                        | Every amount is a decimal string within uint256, every address and hash has its length; anything else is refused as malformed                                 |
| 4    | The plan is verified in the browser (`lib/execution/verify.ts`)                                    | See [Client verification](#client-verification). Every failure is listed; any failure means no send button                                                    |
| 5    | `planHash` is recomputed from the calls as received and compared with the server's                 | A mismatch is its own refusal, shown with both hashes                                                                                                         |
| 6    | The attestation is decided (`lib/execution/attestation.ts`)                                        | Built only where the deployment map records `RebalanceLog`, there is code at its address, and the index was read from the registry the log validates against  |
| 7    | A frozen snapshot is taken (`lib/execution/snapshot.ts`)                                           | What the review shows and what a click sends come from the same frozen object. A refetch cannot change it                                                     |
| 8    | Each warning is acknowledged on its own                                                            | Acknowledgements are bound to the plan hash: they are void for any other plan                                                                                 |
| 9    | `buildExecutionRequest` decides at render time                                                     | The button's click handler exists only when the decision is `ok`                                                                                              |
| 10   | The click reads the latest block of the plan's chain and the current connection, and decides again | The expiry is measured by chain time read at the click, never by the device clock. A refusal at this point is shown and nothing is sent                       |
| 11   | The wallet is called with exactly the request returned                                             | Atomic: one `sendCalls` with `atomicRequired`. Sequential: one `sendTransaction` at a time, each with `chainId`, so wagmi asks the wallet for its chain first |
| 12   | Receipts are checked (`lib/execution/receipts.ts`)                                                 | Only a checked receipt is `confirmed`. Otherwise the call is `unverified`, `reverted`, `replaced` or not found, and said so                                   |
| 13   | Balances are read again on the chain and drift is recomputed                                       | The result is what the chain holds now, not what the plan expected                                                                                            |

### Client verification

`verifyExecutionPlan` refuses the plan unless all of the following hold. It runs on the parsed answer, the
connected account, the network this build accepts for the plan's chain and the constituents of the compared
version.

- The plan is `ready` and `executable`, with calls, totals, an expiry and a hash, and no check is `block`,
  `skipped` or `not_simulated`.
- The plan's chain is one this build sends on. A production build accepts Base mainnet (8453) only. A development
  build also accepts the local Anvil chain (31337), with the same router, executor and USDC addresses
  (`lib/execution/networks.ts`).
- The plan was built for the connected account, and names the pinned router.
- Every leg swaps a constituent of the compared version against USDC in its direction, at most one leg per token,
  with a quote and a non-zero amount.
- The calls are the approvals, then one swap per sell, then one per buy, in leg order, and nothing else.
- Each approval is exactly `approve(router, total swapped of the token)` on that token, without value: never more,
  never unlimited, at most one per token.
- Each swap passes `verifyQuote` against its leg and the account: router, function, exact encoding without
  trailing bytes, executor, flags, executor data layout and recipient, no value, tokens, amount pulled, receiver,
  no fee, no permit, and a minimum at least the slippage tolerance under the quote.
- The decoded minimum equals the leg's and the call's stated minimum, the decoded deadline equals the leg's, and
  it is no earlier than the plan's expiry and at most 15 seconds after it.
- The totals at minimum amounts out, recomputed from the decoded swaps, equal the answer's.

The review shows the decoded values: the minimum, the amounts, the spender, the deadline. A field of the JSON next
to the calldata is never displayed as what is signed.

## The send decision

`buildExecutionRequest(snapshot, account, walletChainId, capabilities, acknowledgements, now, gate)`
(`lib/execution/request.ts`) is the only place that decides whether a click may send, and what. It refuses, in
this order:

| Refusal                     | When                                                                   |
| --------------------------- | ---------------------------------------------------------------------- |
| `no_plan`                   | There is no snapshot                                                   |
| `execution_unavailable`     | The jurisdiction gate withholds execution                              |
| `busy`                      | A request is with the wallet or the chain, or this snapshot was used   |
| `verification_failed`       | The client verification found any failure, with the failures           |
| `hash_mismatch`             | The recomputed `planHash` differs from the server's                    |
| `wrong_account`             | No account, or another account than the plan's                         |
| `wrong_network`             | The wallet reports another chain than the plan's                       |
| `chain_time_unknown`        | The latest block could not be read                                     |
| `expired`                   | The latest block's timestamp is at or after `expiresAt`                |
| `warnings_not_acknowledged` | A warning of the plan is not acknowledged for this plan, with the keys |

Otherwise it returns the exact request. A wallet whose capabilities are `atomic` gets one `sendCalls` with every
call in order, the attestation last when there is one, and `forceAtomic: true`, which viem sends as
`atomicRequired: true`: a wallet that cannot execute the batch atomically must refuse it rather than split it.
Every other wallet, an `unknown` one included, gets the ordered list of transactions. The decision is pure and
exhaustively unit tested (`apps/web/test/execution/request.test.ts`).

A snapshot is used once. After anything reached the chain, the only way forward is "Get a new plan". After a
request that ended with nothing sent (declined, refused by the wallet), the same verified plan can be signed again.

## The two paths

### Atomic

wagmi `sendCalls` sends the batch with EIP-5792 `wallet_sendCalls`; `waitForCallsStatus` waits for its final
status. The batch is `confirmed` only when the wallet reports a 2xx status, there is at least one receipt, every
receipt succeeded, the `Transfer` events of the receipts show the account sent at most what the swaps pull and
received at least their minimums, per token, and, when the attestation was in the batch, exactly one
`RebalanceRecorded` from the log names the account, the index and the version. The sender of a batch receipt can
be a bundler, so it is not compared; the attestation's `account` is the log's `msg.sender`, which ties the batch
to the user's account.

### Sequential

Each transaction is sent only after the previous one confirmed: mined with `status: success`, sent from the
account, addressed to the call's contract, and for a swap, within its transfer bounds. Before each transaction the
expiry by chain time, the account and the network are read again; a refusal stops the run before anything more is
sent. The run stops at the first transaction that does not confirm.

## Partial execution

A sequential run that stops reports exactly which transactions confirmed, which one failed and how, and which
were never sent, then the balances read again from the chain. An approval that confirmed without its swap stays in
place for its exact amount toward the router; the page says so. Swaps that confirmed are not undone: the position
shown is the account's real position. No later transaction of the plan is sent, and the attestation is not
offered.

## The attestation

`RebalanceLog.recordRebalance(indexId, version)` emits `RebalanceRecorded(msg.sender, indexId, version)`. It moves
no token. It is included only where the deployment map of `@equityos/contracts-abi` records a deployment
(`deployBlock` not `null`), the code at the address is read and present, and the index was read from the same
chain and registry the log validates against: on a mismatch the log would revert, or name another index with the
same id, and in an atomic batch that would revert the swaps too. Today the map records no deployment on Base, so
on Base mainnet the attestation is omitted and the review says why.

- **Atomic**: the attestation is the last call of the batch, so it lands with the swaps or not at all.
- **Sequential**: it is a separate, optional transaction, offered with an explanation only after every swap
  confirmed, and never required. It has no expiry: it names a version and does not depend on the quotes.

## Builder Code (ERC-8021)

When `NEXT_PUBLIC_BUILDER_CODE` is set, transactions carry its ERC-8021 attribution suffix; when it is not, nothing
is appended. The suffix is schema 0: the code in ASCII, its length in one byte, the schema id `0x00` and the
16-byte marker `0x80218021802180218021802180218021`, as `Attribution.toDataSuffix({ codes })` of `ox/erc8021`
encodes it (`lib/execution/builder-code.ts`, tested against that encoding). A configured code that is not printable
ASCII of 1 to 64 characters without a comma or space stops preparation, so a typo can never attribute
transactions to another code or be dropped silently.

- **Sequential**: the suffix is appended to the calldata of every transaction, after verification and outside the
  plan hash, which covers the calls as verified.
- **Atomic**: the suffix is passed as the `dataSuffix` capability with `optional: true`, as the Builder Code
  documentation describes for `wallet_sendCalls`. The wallet appends it to the transaction it builds; a wallet that
  does not support the capability sends the batch without it. The calls themselves are unchanged.

Appending bytes to the router's calldata is safe only if the router and the tokens ignore trailing calldata.
This was established read-only on Base mainnet, before any suffix was appended in the app: the live test
`apps/web/test/execution/live.test.ts` ("the router and the tokens accept the ERC-8021 suffix") simulates, with
`eth_simulateV1` from an account holding USDC, an approval of USDC, a buy of NVDAc through the pinned router, an
approval of NVDAc (a B20 token) and a sell of what the buy returned, once without and once with the suffix
appended to every call. On block 61,583,437 every call succeeded both ways and returned the same data, including
each swap's return amount. The test is skipped unless `LIVE_TESTS=1` and runs again whenever it is run.

## No raw error text

Wallet and node errors are classified by code and decoded revert data (`lib/tx/errors.ts`), and a rejection in the
wallet is a calm state that says nothing was sent. A mined revert is reported as reverted: the receipt is read with
viem's `waitForTransactionReceipt`, which returns a reverted receipt, rather than wagmi's, which throws on one and
would have made a mined revert look like a transaction that was never found.

## Local history

The executions sent from a browser are recorded in its `localStorage` under `equityos.execution.history.v1`:
time, chain, account, index and version, plan hash, mode, result, transaction hashes and the attestation's hash.
Nothing is sent to a server, and the page says the list is stored only in this browser. A corrupted value is read
as fewer entries and never breaks the page; a storage that cannot be written records nothing.

## What remains trusted

- **The router contract.** Its verified source enforces the amount pulled, the receiver and the minimum out. It
  has an owner who can whitelist executors and rescue funds held by the router. Exposure is limited to the exact
  approval and the swap in flight.
- **The provider's executor.** Its source is not published. The router hands it the tokens of the swap in flight
  and checks the result against the minimum; its route is not decoded beyond the recipient and the deadline.
- **The RPC endpoints.** The browser reads chain time, the log's code, receipts and balances through the endpoint
  configured for the chain. A dishonest endpoint can misreport time, receipts or balances. It cannot change what
  the wallet signs, and the router still enforces the minimum and the route deadline onchain.
- **The wallet.** It shows and signs the calls, and for an atomic batch it decides how the batch is executed and
  whether it appends the Builder Code. A compromised browser or wallet is out of scope: the page that verifies the
  calls is the page that sends them, and the wallet's confirmation screen is the independent check.
- **The server's reads that are not repeated.** The balances before the plan and the pre-trade checks (pauses,
  policies, multiplier windows, simulation) are the server's, at one block. The browser does not repeat them;
  onchain, a swap that would return less than its minimum reverts.

## Tests

- `apps/web/test/execution`: the strict parser, the client verification of the recorded server answer and of a
  plan with each field changed, the send decision with every refusal and both request shapes, the attestation
  decision, the Builder Code encoding, the receipt checks, the sequential runner and its stop on the first failure,
  the history store and the drift after.
- `apps/web/e2e/execute.e2e.ts`: the review states without a chain, with mocked answers: a ready plan whose button
  enables only after the warning is acknowledged and whose decline is a calm state, a blocked plan, a plan expired
  by chain time, a hash mismatch, calldata that does not verify, a server that builds no plan, and a restricted
  region where the review cannot be reached.
- `apps/web/e2e-chain/rebalance.e2e.ts`: on Anvil, an atomic batch with the attestation, its decoded event, the
  Builder Code capability, the balances and drift after; and a sequential wallet whose second swap reverts onchain,
  reported as partial execution, with the chain checked for exactly three confirmed transactions, one reverted and
  one never sent.

### What the chain tests mock, and why production verification is not weakened

The server of the chain suite replays recorded market data and quotes nothing, so each test answers the plan
request itself with a plan in the server's exact shape, built for the local node's state
(`apps/web/e2e/execution-plans.ts`). On the node, `apps/web/e2e-chain/execution-chain.ts` installs, with
`anvil_setCode`, the contracts of `contracts/test/mocks/ExecutionMocks.sol` at the Base mainnet addresses the
verification pins: an ERC-20 at USDC and at each constituent, a router with the real router's `swap` function and
structs at the router address, and an executor at the executor address that pays the token and amount its data
names to the recipient at the recorded word, before the deadline at the recorded word. The router pulls exactly
the amount, runs the executor and reverts below the minimum, as the real router does. Nothing of the real
executor's routing is reproduced.

Because the mocks sit at the pinned addresses, no address is added to any allowlist. The only difference between
a production and a development build is that the development build also accepts plans for chain 31337, where
only `anvil_setCode` can put code at those addresses. The test wallet emulates an atomic batch by taking an Anvil
snapshot, sending the calls in order and reverting to the snapshot if one fails; it exists only in the test
support code, holds no key and signs nothing itself.

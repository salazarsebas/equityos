# Executable plan and pre-trade checks

The execution layer turns a reference-price rebalance plan into the exact calls a wallet would make on Base
mainnet, and checks them. It lives in `apps/web/src/server/execution`, is guarded by `import "server-only"`, and
is served by `POST /api/v1/portfolio/execution-plan` ([API](../api/execution.md)).

It reads and computes. **Nothing in it signs or sends a transaction**: no code path calls `writeContract`,
`sendTransaction`, `sendCalls` or `signMessage`, and it holds no key. The calls it returns are data. The portfolio
page verifies them again in the browser and asks the user's own wallet to sign them: see
[Sending from the wallet](#sending-from-the-wallet) and [Sending an execution plan](../security/execution-sending.md).

An executable plan is arithmetic and checks. It is not a recommendation and not an instruction to trade.

## Inputs and outputs

| Input            | Source                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------- |
| Reference plan   | `planRebalance` of `@equityos/core`, for the same comparison as `GET /portfolio/plan`     |
| Account          | The address in the request. It is the sender and the recipient of every swap              |
| Reference prices | The market data layer, with their staleness class                                         |
| Quotes           | KyberSwap aggregator API for Base, through the `QuoteProvider` interface                  |
| Token state      | Base mainnet, read at one block: pause, policies, multiplier schedule, balance, allowance |
| Jurisdiction     | `classifyJurisdiction` of the request headers                                             |

The output is either `blocked`, with every check that ran and the ones that block, or `ready`, with the ordered
calls, totals at the minimum amounts out, an expiry and `planHash`. A deposit is not an input: execution spends
what the account holds.

Execution is on Base mainnet only (chain 8453). The index registry can be on another chain; that does not
matter here, because a version names Base mainnet token addresses.

## Flow

Stages run in order. A stage runs only when the earlier ones let the plan proceed, so a restricted request or a
closed market never reaches the quote provider.

1. **Rate limit of the address.** More than 3 plans at once, then one every 20 seconds, is a 429.
2. **Jurisdiction.** A restricted request is blocked before anything else.
3. **Reference plan.** A blocked plan, a plan without legs, or one with more than 5 legs is blocked. Then the
   freshness of the reference price of each leg.
4. **Provider budget.** Two provider requests per leg are taken from the instance budget before the first one is
   sent. Without them the request is a 503 `provider_rate_limited`.
5. **Quotes.** Two legs at a time: a route, then a build. Every answer is verified (see
   [Calldata verification](#calldata-verification)) and the deviation from the reference is computed.
6. **Pre-trade read.** One Multicall3 request at the latest block, then one at the same block for the policy
   registry, for USDC and every token of the plan.
7. **Checks** on that read, and the funding check on the minimum amounts out.
8. **Calls.** Approvals, then sells, then buys.
9. **Simulation** of the calls at the block of the read.
10. **Expiry.** From the first quote and the decoded route deadlines.

The whole request has a deadline of 20 seconds. Past it the answer is a 503 `deadline_exceeded`, and the provider
requests in flight are aborted.

## Quote provider

`QuoteProvider` (`provider.ts`) has one method, `quote(request, context)`, which returns a provider quote or a
typed failure and never throws for an expected state. KyberSwap is the one implementation (`kyberswap.ts`);
another aggregator can be added behind the same interface, and every quote of every provider goes through the
same verification.

KyberSwap is called keyless at `https://aggregator-api.kyberswap.com/base/api/v1`: `GET /routes` with the pair
and the exact amount in, then `POST /route/build` with the route summary it returned, the account as `sender`
and `recipient`, the slippage tolerance in basis points and a deadline. The only identifying header is
`x-client-id`, from `KYBERSWAP_CLIENT_ID` (default `equityos`).

| Behavior        | Rule                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------ |
| Timeout         | 8 seconds per request, and the 20 second deadline of the request being served                    |
| Retry           | At most one, at once, only after a transport failure, a timeout or a 5xx, and only within budget |
| 429             | Never retried, never waited on: the plan fails at once with the provider's wait in `Retry-After` |
| 4xx             | Not retried. Code 4008 is `no_route`, any other is `provider_rejected` with the code             |
| Unexpected body | `provider_malformed`, never retried, nothing defaulted. Amounts must be decimal strings          |
| Route mismatch  | A route for another pair or amount than requested is refused before the build                    |

### Rate limits

| Limit             | Value                                | Why                                                                             |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| Per address       | 3 at once, then one every 20 seconds | A plan lives 120 seconds: a person who quotes again after expiry never meets it |
| Provider requests | 10 at once, one more per second      | The provider's keyless limit was 10 requests per 10 seconds                     |
| Legs per plan     | 5                                    | Two requests per leg: a plan fits in one provider window                        |
| Concurrency       | 2 legs at a time                     | The budget is taken before quoting, so concurrency cannot exceed it             |

The limits are token buckets in the memory of each server instance (`limits.ts`). Several instances each admit
the same rates, so together they can exceed the provider's limit; a shared store (Redis, or the platform's rate
limiter) would make the budget hold for the deployment. The address is the one the hosting platform reports in
`x-real-ip` or `x-forwarded-for`, which can be forged when the server is reachable without the platform proxy.

## Calldata verification

`verifyQuote` (`apps/web/src/lib/execution/calldata.ts`) decides whether provider calldata may be used. The
module is pure and browser-safe, so the client that sends a plan runs the same verification again. Every rule is
an allowlist of what the provider returned for Base in every answer recorded, and anything else is refused with a
typed reason:

| Check         | Rule                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Router        | `to` is `0x6131b5fae19ea4f9d964eac0408e4408b66337b5`. Any other address is refused (`router_not_allowed`)                                             |
| Function      | `swap` (`0xe21fd0e9`) only. The router's `swapGeneric` and `swapSimpleMode` were never returned (`unknown_selector`)                                  |
| Encoding      | The calldata is exactly the encoding of what it decodes to: no trailing bytes (`calldata_mismatch`)                                                   |
| Executor      | `callTarget` and the only `srcReceivers` entry are `0x8f10b468b06c6fd214b65f87778827f7d113f996`, and `approveTarget` is zero (`executor_not_allowed`) |
| Flags         | `0x200`, the only value recorded (`flags_not_allowed`)                                                                                                |
| Executor data | Starts with the recorded header; its 9th word is the account and its 17th the deadline (`executor_data_unrecognized`)                                 |
| Value         | No native value                                                                                                                                       |
| Tokens        | `srcToken` and `dstToken` are the requested pair                                                                                                      |
| Amount        | `amount`, the single `srcAmounts` entry and the provider's `amountIn` equal the requested amount                                                      |
| Receiver      | `dstReceiver` is the account                                                                                                                          |
| Fees, permit  | No fee receiver, no fee amount, an empty permit                                                                                                       |
| Minimum out   | Above zero, at most the quote, and at least `floor(quote * (10000 - slippage) / 10000)`                                                               |

The router is the `MetaAggregationRouterV2` listed for Base in the provider's contract documentation, returned by
the API for Base, verified on Sourcify for chain 8453 and answering `WETH()` with the Base WETH predeploy. The
executor is the `AggregationExecutorProxy` listed for Base on the same page and deployed at that address. The
executor's source is not published, so the layout of its data is known only from the answers: in 9 builds across
6 tokens, amounts from 1 to 100,000 USDC and routes through pools and market makers, it began with the same
20-byte header and carried the recipient and the requested deadline at the same words. A different layout is
refused.

The minimum amount out and the deadline are the ones decoded from the calldata, which the router and the executor
enforce onchain. Neither is taken from a field of the JSON answer.

## Checks

Every check returns a result as data: `check`, `status`, `reason`, the token and leg it concerns, and a short
machine-readable `detail`. `pass` and `warn` let the plan proceed. `block` stops it. `not_simulated` stops it
unless the request sets `allowUnsimulated`. `skipped` means a prerequisite failed.

| Check                  | Scope            | Blocks when                                                                                | Protects against                                             |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `jurisdiction`         | plan             | The request is restricted, or its country is unknown in production                         | Execution for restricted requests                            |
| `reference_plan`       | plan             | The plan is blocked, has no leg, or more than 10                                           | Quoting a plan that is not one                               |
| `reference_freshness`  | leg              | The reference is `last_close` or `unavailable`. `delayed` warns                            | Bounding a trade by a price that is hours old                |
| `quote`                | leg              | No route, a provider failure, or calldata that does not verify                             | Foreign calldata, wrong router, wrong receiver, weak minimum |
| `price_deviation`      | leg              | The executable price is further than the band from the reference, either way               | Thin pools, broken routes, a wrong reference                 |
| `transfers_not_paused` | token, USDC      | `isPaused(TRANSFER)` of the token, or `paused()` of USDC                                   | Approving and swapping into a revert                         |
| `policy_authorized`    | token, USDC      | The account is not authorized to send or receive, or the router as executor                | `PolicyForbids` reverts, blocklisted accounts                |
| `multiplier_window`    | token            | A multiplier update takes effect within 24 hours                                           | Trading across a corporate action                            |
| `allowance`            | token sold       | The allowance cannot be read                                                               | Approving an amount computed from nothing                    |
| `balance`              | token sold, USDC | A sell exceeds the balance, or the buys exceed USDC held plus the minimum out of the sells | Buys funded by proceeds that may not arrive                  |
| `simulation`           | plan             | A call reverts, or returns less than its minimum. `not_simulated` when it could not run    | Sequences that fail onchain                                  |
| `plan_expiry`          | plan             | The plan is already past its expiry when it is answered                                    | Stale quotes                                                 |

### Defaults and bounds

| Setting            | Default       | Bound    | Why                                                                                                                                                                                         |
| ------------------ | ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slippageBps`      | 50            | 0 to 200 | Equal to the default reserve of a plan: when executable prices are near the reference, sells whose minimum is 50 bps under their quote still fund buys sized with a 50 bps reserve          |
| `maxDeviationBps`  | 150           | 0 to 500 | Applied to the quoted and to the minimum-out price, so it bounds the worst outcome: 100 bps of quote deviation (feed lag up to 50 bps, a pool fee, some impact) plus the 50 bps of slippage |
| Freshness          | `live` passes | fixed    | `delayed` warns: in an open session a delayed value is within the 0.5% publication threshold of its source. `last_close` and `unavailable` block                                            |
| Multiplier window  | 24 hours      | fixed    | Longer than any plan lives by orders of magnitude, and covers the feed freeze around a corporate action                                                                                     |
| Plan lifetime      | 120 seconds   | fixed    | Time to review and confirm an approval and a few swaps. It is also the deadline asked of the provider, so a swap sent later reverts onchain                                                 |
| Deadline tolerance | 15 seconds    | fixed    | A route deadline may exceed the plan's expiry by at most this, for clock skew; a later one blocks                                                                                           |
| `allowUnsimulated` | `false`       |          | A plan whose sequence could not be simulated is blocked unless the caller explicitly accepts it, and is never `executable`                                                                  |

A wider band off-hours is not offered: a closed market is blocked by the freshness check.

### Deviation

For each leg, with `usdc` the USDC amount and `tokens` the token amount of the swap (sell: USDC out and the exact
quantity in; buy: the exact USDC in and the quantity out):

```
executable = usdc * 100 * 10^decimals        reference = tokens * priceE8
deviationBps = (executable - reference) * 10000 / reference, rounded away from zero
```

It is computed twice: with the quoted amount out (`deviationBps`) and with the minimum amount out
(`minimumDeviationBps`), and both must be within the band. It is signed: positive when the executable price is
above the reference, which receives more for a sell and pays more for a buy. A sell's minimum is a lower price
than its quote and a buy's a higher one, so the minimum is the worst price the swap accepts. Rounding away from
zero means a deviation is never reported smaller than it is. The reported number is clamped at 1,000,000 bps;
the check uses the exact value.

### Policy

B20 transfers consult three policy slots of the token: the sender (`from`), the receiver (`to`) and the
executor (`msg.sender`). `policyId(scope)` of the token gives the policy, and `isAuthorized(policyId, account)`
of the policy registry at `0x8453000000000000000000000000000000000002` answers for an account. The scopes are
pinned as the keccak256 of their names, which is what `TRANSFER_SENDER_POLICY()` and the two others return; a
unit test recomputes them and the live test reads them back from the tokens.

The account is checked as sender and receiver of every token of the plan, and the router as executor, because
it calls `transferFrom` on the account's tokens. For USDC, which is not a B20 token, `isBlacklisted` of the
account and of the router stands for the same check. The transfers that the router's executor and the pools
make along a route are not checked one by one; the simulation covers them.

### Funding and approvals

Buys are funded by the USDC the account holds plus the **minimum** amounts out of the sells, never their
quoted amounts. A plan whose buys need more is blocked with `needed/available` in the detail.

An approval is for exactly the total the plan swaps of a token, toward the router, and is included only when the
current allowance is below that total. Never more, never unlimited. An allowance that already covers the swap gets
no approval call; one above the plan, unlimited included, is the warning `allowance` `above_plan` with the amount,
so that the user is told the router may pull more than this plan if it is ever called with other calldata.

### Warnings

`warnings` lists every check that passed with a warning: a `delayed` reference, an allowance above the plan, and
the development jurisdiction. A warning does not make a plan non-executable, and a client shows each one and asks
for an acknowledgement before sending.

## Simulation

The calls are simulated from the account at the block of the pre-trade read.

- **`eth_simulateV1`** when the endpoint serves it: the whole sequence runs in order on one simulated block,
  each call on the state the previous ones left, with validation off so that gas price and nonce do not matter.
  The public Base endpoint serves it. A transport failure of this request is retried once.
- **`eth_call`** when the endpoint answers that it does not serve `eth_simulateV1`, or the request failed twice:
  each call runs alone on the state of the block. Only calls whose approval and input balance are already in
  place can run alone; the others are not simulated. Allowances are not overridden: the tokens are precompiles
  whose storage layout is not published, so an override would not model the chain.

`simulationMethod` in the answer says which ran. **Only a simulated sequence passes.** Calls run alone are
`not_simulated`, with the reason `calls_simulated_alone` when every call ran and `sequence_not_supported` when
some could not: either blocks by default, and with `allowUnsimulated` the plan is `ready` but never `executable`.
A revert blocks whatever the method, with the call index and the decoded error name (`PolicyForbids`,
`ContractPaused`, `InsufficientBalance`, `InsufficientAllowance`, `InvalidReceiver`, `Error`, `Panic`, or
`unknown`).

Limits: a simulation is of one block. The chain moves before a transaction lands, the provider's route can
depend on quotes from market makers that expire, and a simulation does not see what an issuer does after the
read. It reduces the chance of a revert; it does not remove it.

## What a ready plan guarantees

- Every swap call is addressed to the allowlisted router, calls an allowed function, and carries a minimum
  amount out that the router enforces and that is at least the requested tolerance under the quote.
- Every swap delivers to the account, pulls exactly the planned amount, and pays no fee to anyone.
- Approvals never exceed what is swapped of the token.
- At the read block, no token was paused, the account and router were authorized, no multiplier update was
  due within 24 hours, balances covered the plan at minimum amounts out, and (with `eth_simulateV1`) the whole
  sequence succeeded.
- Every swap carries a route deadline no later than `expiresAt` plus 15 seconds; after it the swap reverts.
- `planHash` is keccak256 of `abi.encode("equityos.execution-plan/1", chainId, account, expiresAt, (to, value, data)[])`
  over the calls in order.

### What a client that sends the plan must do

The server's checks protect only what the server returns. A client that sends the calls verifies them again
with `apps/web/src/lib/execution/calldata.ts` (`verifyQuote` for each swap, `isExactApproval` for each approval),
recomputes `planHash` from the calls it is about to send and `expiresAt` and sends nothing when it differs, refuses
to send after `expiresAt` measured by chain time, and asks for an acknowledgement of every warning. The portfolio
page is such a client; the next section summarizes how.

## Sending from the wallet

The browser side lives in `apps/web/src/lib/execution` (pure) and `apps/web/src/app/portfolio/execute`
(components and wallet calls). Its safeguards, step by step, are in
[Sending an execution plan](../security/execution-sending.md).

1. **Verification in the browser.** `verifyExecutionPlan` parses nothing on trust: it decodes every call, checks it
   against the plan's legs and the connected account with the module above, checks that the legs trade
   constituents of the compared version, recomputes the totals at minimum amounts out, and recomputes `planHash`.
   Any failure, or a hash that differs from the server's, means nothing can be signed.
2. **One send decision.** `buildExecutionRequest` returns the exact wallet request or a typed refusal: no plan,
   execution unavailable, busy, verification failed, hash mismatch, wrong account, wrong network, chain time
   unknown, expired by chain time, or warnings not acknowledged. The button's click handler exists only when it
   allows, and the click decides again with the latest block's timestamp read at that moment.
3. **Two paths.** A wallet that executes batches atomically (EIP-5792) gets one `sendCalls` with every call in
   order and `atomicRequired`, the attestation last. Any other wallet gets one transaction at a time, each sent
   only after the previous one confirmed and after the expiry, the account and the network are read again; the
   run stops at the first failure and reports what confirmed, what failed and what was not sent.
4. **Receipts.** A call is confirmed only when its receipt succeeded, was sent from the account to the expected
   contract (sequential), and its token transfers stay within the plan's bounds; the attestation's event is
   decoded and compared with the account, index and version.
5. **Attestation.** `RebalanceLog.recordRebalance(indexId, version)` is added only where the deployment map
   records the log, it has code, and the index was read from the registry it validates against. Atomic: in the
   batch. Sequential: an optional transaction offered after every swap confirmed.
6. **Builder Code.** With `NEXT_PUBLIC_BUILDER_CODE` set, the ERC-8021 suffix is appended to each sequential
   transaction, and passed as the optional `dataSuffix` capability of an atomic batch. Without it, nothing is
   appended. A read-only simulation on Base mainnet showed that the router and the tokens accept the trailing
   bytes.
7. **After.** Balances are read again on the chain, drift is recomputed against the index with the comparison's
   reference prices, and the run is recorded in the browser's local storage only.

## What it does not guarantee

- **The quoted amounts.** Only the minimum is enforced. A swap returns at least its minimum and can return less
  than its quote.
- **Execution.** Prices, balances, pauses and policies can change after the read. A swap that would return
  less than its minimum reverts; an approval already sent stays in place for the exact amount.
- **The route.** The executor data the router runs is the provider's. What is verified is what the router
  enforces around it (tokens, amount pulled, receiver, fee, minimum out), the executor it runs, and the recipient
  and deadline the executor data carries.
- **Gas.** `gasEstimate` is the provider's estimate and is not verified.
- **The executor data beyond two words.** The recipient and the deadline are read at their recorded positions;
  the rest of the route is not decoded.
- **Suitability.** A plan is arithmetic toward a published methodology. It says nothing about whether to trade.

## Tests

Unit tests run without a network (`apps/web/test/execution`, `apps/web/test/api/execution.test.ts`):

- `kyberswap.test.ts`: the client on answers recorded from the live API (`test/fixtures/execution/kyberswap.json`,
  recorded 2026-11-24 for three legs, route hops trimmed), headers, retries, rate limits, malformed answers.
- `calldata.test.ts`: the allowlists against every recorded answer, and verification of the recorded calldata
  and of variants of it with each field changed: router, selector, trailing bytes, executor, approval target,
  source receivers, flags, executor data layout, recipient, deadline, amounts, fees, permit and minimum.
- `checks.test.ts`: each check's pass, warn and block paths, deviation sign and rounding, the jurisdiction rule.
- `plan.test.ts`: whole plans on a node in memory: the order of calls, exact approvals, totals, `planHash`, each
  blocking path, the simulation retry and fallback, the deadline and expiry, the provider budget, a 429, the
  request deadline, bounded concurrency and the warnings.
- `apps/web/test/api/execution.test.ts`: the endpoint, its body validation, the per-address limit, the provider
  budget, the 429 and the deadline as HTTP answers.
- `properties.test.ts`: over 300 seeded plans, a ready plan never approves more than it swaps and never spends
  more USDC than it holds plus the minimum out of its sells.

`test/execution/live.test.ts` quotes real legs, reads a real account and simulates a real plan, read-only:

```sh
cd apps/web
LIVE_TESTS=1 bun test test/execution/live.test.ts
```

It is skipped unless `LIVE_TESTS=1` and does not run in CI.

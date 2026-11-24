# Executable plan and pre-trade checks

The execution layer turns a reference-price rebalance plan into the exact calls a wallet would make on Base
mainnet, and checks them. It lives in `apps/web/src/server/execution`, is guarded by `import "server-only"`, and
is served by `POST /api/v1/portfolio/execution-plan` ([API](../api/execution.md)).

It reads and computes. **Nothing in it signs or sends a transaction**: no code path calls `writeContract`,
`sendTransaction`, `sendCalls` or `signMessage`, and it holds no key. The calls it returns are data for a client
to show, and for a later step to send through the user's wallet.

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

1. **Jurisdiction.** A restricted request is blocked before anything else.
2. **Reference plan.** A blocked plan, a plan without legs, or one with more than 10 legs is blocked. Then the
   freshness of the reference price of each leg.
3. **Quotes.** One leg after the other: a route, then a build, from the provider. Every answer is verified (see
   [Calldata verification](#calldata-verification)) and the deviation from the reference is computed.
4. **Pre-trade read.** One Multicall3 request at the latest block, then one at the same block for the policy
   registry, for USDC and every token of the plan.
5. **Checks** on that read, and the funding check on the minimum amounts out.
6. **Calls.** Approvals, then sells, then buys.
7. **Simulation** of the calls at the block of the read.
8. **Expiry.** The plan is blocked if its quotes are already older than its lifetime.

## Quote provider

`QuoteProvider` (`provider.ts`) has one method, `quote(request)`, which returns a provider quote or a typed
failure and never throws for an expected state. KyberSwap is the one implementation (`kyberswap.ts`); another
aggregator can be added behind the same interface, and every quote of every provider goes through the same
verification.

KyberSwap is called keyless at `https://aggregator-api.kyberswap.com/base/api/v1`: `GET /routes` with the pair
and the exact amount in, then `POST /route/build` with the route summary it returned, the account as `sender`
and `recipient`, the slippage tolerance in basis points and a deadline. The only identifying header is
`x-client-id`, from `KYBERSWAP_CLIENT_ID` (default `equityos`).

| Behavior        | Rule                                                                                    |
| --------------- | --------------------------------------------------------------------------------------- |
| Timeout         | 8 seconds per request                                                                   |
| Retry           | At most one, only after a transport failure, a timeout, a 5xx or a 429                  |
| Rate limit      | A 429 waits for `x-ratelimit-reset-after`, at most 10 seconds, before its one retry     |
| 4xx             | Not retried. Code 4008 is `no_route`, any other is `provider_rejected` with the code    |
| Unexpected body | `provider_malformed`, never retried, nothing defaulted. Amounts must be decimal strings |
| Route mismatch  | A route for another pair or amount than requested is refused before the build           |

The provider limited keyless clients to 10 requests per 10 seconds when this was written, and each leg takes
two, which is why a plan has at most 10 legs.

## Calldata verification

`verifyQuote` (`router.ts`) decides whether provider calldata may be used. The provider is a third party, so
its answer is accepted only when all of the following hold:

| Check           | Rule                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| Router          | `to` is `KYBERSWAP_ROUTER`, `0x6131b5fae19ea4f9d964eac0408e4408b66337b5`. Any other address is refused       |
| Function        | The selector is `swap` (`0xe21fd0e9`), `swapGeneric` (`0x59e50fed`) or `swapSimpleMode` (`0x8af033fb`)       |
| Value           | No native value                                                                                              |
| Tokens          | `srcToken` and `dstToken` are the requested pair                                                             |
| Amount          | `amount` and the provider's `amountIn` equal the requested amount, and `srcAmounts` sum to it                |
| Receiver        | `dstReceiver` is the account                                                                                 |
| Fees and permit | No fee receiver, no fee amount, an empty permit                                                              |
| Flags           | Neither partial fill (`0x01`) nor extra ETH (`0x02`)                                                         |
| Minimum out     | `minReturnAmount` is above zero, at most the quote, and at least `floor(quote * (10000 - slippage) / 10000)` |

The router address is the `MetaAggregationRouterV2` listed for Base in the provider's contract documentation,
returned by the API for Base, verified on Sourcify for chain 8453, and answering `WETH()` with the Base WETH
predeploy. The provider documents a newer router on Base as well; it is not allowlisted, and calldata addressed
to it is refused.

The minimum amount out is the one decoded from the calldata, which is the amount the router enforces onchain:
a swap that would return less reverts. It is never taken from a field of the JSON answer.

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

| Setting            | Default       | Bound    | Why                                                                                                                                                                                                                                                              |
| ------------------ | ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slippageBps`      | 50            | 0 to 200 | Equal to the default reserve of a plan: when executable prices are near the reference, sells whose minimum is 50 bps under their quote still fund buys sized with a 50 bps reserve. Above 2% a minimum stops bounding what a user receives                       |
| `maxDeviationBps`  | 100           | 0 to 500 | A current reference can trail its market by 50 bps (the feed publishes on a 0.5% move), and a small swap adds a pool fee and some price impact. Gaps of about 60 bps were seen between pools and a frozen weekend feed, which the freshness check blocks instead |
| Freshness          | `live` passes | fixed    | `delayed` warns: in an open session a delayed value is within the 0.5% publication threshold of its source. `last_close` and `unavailable` block, because there is no current reference to bound a trade with                                                    |
| Multiplier window  | 24 hours      | fixed    | Longer than any plan lives by orders of magnitude, and covers the feed freeze around a corporate action                                                                                                                                                          |
| Plan lifetime      | 60 seconds    | fixed    | The provider advises not to reuse a route for more than 5 to 10 seconds; 60 seconds leaves time to review and sign, and every swap still carries its minimum                                                                                                     |
| Quote deadline     | 300 seconds   | fixed    | Passed to the provider so that several wallet confirmations fit                                                                                                                                                                                                  |
| `allowUnsimulated` | `false`       |          | A plan whose sequence could not be simulated is blocked unless the caller explicitly accepts it                                                                                                                                                                  |

A wider band off-hours is not offered: a closed market is blocked by the freshness check.

### Deviation

For each leg, with `usdc` the USDC amount and `tokens` the token amount of the swap (sell: the quoted USDC out
and the exact quantity in; buy: the exact USDC in and the quoted quantity out):

```
executable = usdc * 100 * 10^decimals        reference = tokens * priceE8
deviationBps = (executable - reference) * 10000 / reference, rounded away from zero
```

It is signed: positive when the executable price is above the reference, which receives more for a sell and
pays more for a buy. It is computed from the quoted amount, not the minimum; the worst case a swap can settle at
is the deviation band plus the slippage tolerance. Rounding away from zero means a deviation is never reported
smaller than it is. The reported number is clamped at 1,000,000 bps; the check uses the exact value.

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
current allowance is below that total. Never more, never unlimited. An allowance that already covers the swap
gets no approval call.

## Simulation

The calls are simulated from the account at the block of the pre-trade read.

- **`eth_simulateV1`** when the endpoint serves it: the whole sequence runs in order on one simulated block,
  each call on the state the previous ones left, with validation off so that gas price and nonce do not matter.
  The public Base endpoint serves it.
- **`eth_call`** otherwise: each call runs alone on the state of the block. Only calls whose approval and input
  balance are already in place can run alone; the others are `not_simulated`. Allowances are not overridden:
  the tokens are precompiles whose storage layout is not published, so an override would not model the chain.

`simulationMethod` in the answer says which ran. Single calls are never reported as a simulated sequence: they
pass with the warning `calls_simulated_alone` when every call ran, and are `not_simulated` otherwise, which blocks
by default. A revert blocks whatever the method, with the call index and the decoded error name (`PolicyForbids`,
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
- `planHash` is keccak256 of `abi.encode("equityos.execution-plan/1", chainId, account, (to, value, data)[])`
  over the calls in order. A client recomputes it from the calls it is about to send.

## What it does not guarantee

- **The quoted amounts.** Only the minimum is enforced. A swap returns at least its minimum and can return less
  than its quote.
- **Execution.** Prices, balances, pauses and policies can change after the read. A swap that would return
  less than its minimum reverts; an approval already sent stays in place for the exact amount.
- **The route.** The executor data the router runs is the provider's and is not decoded. What is verified is
  what the router enforces around it: tokens, amount pulled, receiver, fee and minimum out.
- **Gas.** `gasEstimate` is the provider's estimate and is not verified.
- **The deadline.** It is passed to the provider and enforced, if at all, inside the executor data.
- **Suitability.** A plan is arithmetic toward a published methodology. It says nothing about whether to trade.

## Tests

Unit tests run without a network (`apps/web/test/execution`, `apps/web/test/api/execution.test.ts`):

- `kyberswap.test.ts`: the client on answers recorded from the live API (`test/fixtures/execution/kyberswap.json`,
  recorded 2026-11-24 for three legs, route hops trimmed), headers, retries, rate limits, malformed answers.
- `router.test.ts`: the allowlist, the selectors, and verification of the recorded calldata and of variants of
  it with each field changed.
- `checks.test.ts`: each check's pass, warn and block paths, deviation sign and rounding, the jurisdiction rule.
- `plan.test.ts`: whole plans on a node in memory: the order of calls, exact approvals, totals, `planHash`, and
  each blocking path, simulation fallback included.
- `properties.test.ts`: over 300 seeded plans, a ready plan never approves more than it swaps and never spends
  more USDC than it holds plus the minimum out of its sells.

`test/execution/live.test.ts` quotes real legs, reads a real account and simulates a real plan, read-only:

```sh
cd apps/web
LIVE_TESTS=1 bun test test/execution/live.test.ts
```

It is skipped unless `LIVE_TESTS=1` and does not run in CI.

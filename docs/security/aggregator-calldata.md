# Aggregator calldata

An executable plan contains swap calldata written by a third party, the KyberSwap aggregator API. This page
states what EquityOS verifies about it before it reaches a user, and what it cannot verify. The flow is in
[Executable plan and pre-trade checks](../architecture/execution.md).

EquityOS is not affiliated with KyberSwap. It calls its public API without a key.

## What is at stake

A swap call runs with the user's approval of the router. Calldata that is wrong or hostile could:

- send the bought tokens to someone else;
- pull more of the user's tokens than planned;
- pay part of the swap to a fee receiver;
- accept any price, by setting no meaningful minimum amount out;
- call a function of the router other than a swap, or another contract altogether;
- carry native value or a permit that grants more than the plan needs.

EquityOS holds no key and signs nothing. The risk is that a user signs what the plan shows, which is why the
browser verifies every call again before it offers to send it ([Sending an execution plan](execution-sending.md)).

## What is verified

Every quote, from any provider, passes `verifyQuote` (`apps/web/src/lib/execution/calldata.ts`) or is refused
with a typed reason. The module is pure and browser-safe: the server runs it before a plan is built, and the client
that sends a plan runs it again on the calls it sends. The checks are deterministic and run on the decoded
calldata, not on the JSON fields the provider reports next to it. Every rule is an allowlist of what the provider
returned for Base in every recorded answer, so a change at the provider blocks execution until it is reviewed.

| Property      | Verification                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Target        | `to` equals the pinned router, `0x6131b5fae19ea4f9d964eac0408e4408b66337b5` on Base                                                 |
| Function      | `swap` only, by selector, and the calldata is exactly the encoding of what it decodes to                                            |
| Executor      | `callTarget` and the only source receiver are the pinned executor, `0x8f10b468b06c6fd214b65f87778827f7d113f996`; no approval target |
| Flags         | `0x200`, the only value recorded                                                                                                    |
| Executor data | The recorded layout, with the user's address as recipient and a readable deadline                                                   |
| Native value  | Zero                                                                                                                                |
| Tokens        | The requested pair, in the requested direction                                                                                      |
| Amount pulled | `amount` and the single `srcAmounts` entry equal the planned amount                                                                 |
| Recipient     | `dstReceiver` is the user's address                                                                                                 |
| Fees          | No fee receiver and no fee amount                                                                                                   |
| Permit        | Empty                                                                                                                               |
| Minimum out   | At least the requested tolerance under the quote, recomputed here, and enforced by the router                                       |
| Deadline      | No later than the plan's expiry plus 15 seconds; it shortens the expiry when it is sooner                                           |

Around the calls:

- **Approvals are exact.** Each approval is for the total the plan swaps of the token, toward the router, and
  only when the current allowance is lower. Never unlimited. An existing allowance above the plan, unlimited
  included, is reported as a warning with its amount.
- **The sequence is simulated, or the plan is not executable.** With `eth_simulateV1`, the approvals and swaps run
  in order from the user's address on one simulated block at the block of the checks; a revert or an amount out
  below the minimum blocks the plan. When the endpoint does not serve `eth_simulateV1`, or fails twice in
  transport, calls are run alone with `eth_call`. That is not a simulation of the sequence: the plan is blocked
  (`not_simulated`), and a caller that accepts unsimulated execution gets a plan with `executable: false`.
- **Funding counts minimums only.** Buys are funded by USDC held plus the minimum out of the sells.
- **The worst price is bounded.** The deviation band applies to the minimum-out price as well as to the quote.
- **`planHash`** binds the calls and `expiresAt`: the next step can refuse to send anything other than the calls
  the user saw, and anything after the expiry.

The router address was checked against the provider's contract documentation, the address its API returns for
Base, its verified source on Sourcify (chain 8453) and an onchain read. The executor is listed for Base on the same
documentation page and has code at its address; its source is not published. Tests pin both against the recorded
answers; the live test reads their code from the chain. A provider that starts returning another router, executor,
function, flags value or executor data layout is refused until the allowlist is changed on purpose.

## What is not verified

- **The route.** Beyond the recipient and the deadline, the executor data (`targetData`) is the provider's and is
  not decoded. Which pools, market makers and intermediate tokens a swap uses is taken on trust. What bounds it is
  what the router enforces: the amount pulled from the user, the recipient and the minimum out.
- **The executor.** Its source is not published. The router hands it the user's tokens for the swap in flight and
  checks the result against the minimum.
- **The quote.** `quotedAmountOut` is the provider's estimate. Only the minimum is guaranteed, by the router.
- **Gas.** The estimate is the provider's.
- **The router itself.** Its code is verified source, not audited by EquityOS. It has an owner, who can
  whitelist executors and rescue funds held by the router. A user's exposure is limited to the exact approval
  and the swap in flight.
- **Availability.** The API is keyless and rate limited, with no service commitment. A 429 fails the request at
  once with 503 `provider_rate_limited`; other failures block the leg with `provider_unavailable` or
  `provider_rejected`. No other source is substituted.

## Trust assumptions

- The pinned router enforces `dstReceiver`, `amount` and `minReturnAmount` as its verified source does, and the
  executor enforces the deadline it carries.
- The Base mainnet endpoint answers the pre-trade read and the simulation truthfully. A dishonest endpoint can
  make a plan look safe; the user's wallet then shows the call it signs, and the router still enforces the
  minimum.
- The B20 policy registry and token precompiles behave as the B20 interface documents.

## Operational notes

- Each request quotes up to 5 legs, two provider requests each, taken from a per-instance budget of 10 per 10
  seconds before the first is sent. Each address may ask for 3 plans at once, then one every 20 seconds. Both
  limits are per server instance; a deployment should also limit the route in front of the app.
- A request has 20 seconds; past that it answers 503 `deadline_exceeded` and aborts its provider requests.
- An unexpected failure is logged as one line: the API path, the code, the error classes and the host of an
  upstream URL reduced to its last two labels. No error message or URL is logged, since an RPC URL can carry a key.
- `KYBERSWAP_CLIENT_ID` identifies the deployment to the provider. It is not a secret.

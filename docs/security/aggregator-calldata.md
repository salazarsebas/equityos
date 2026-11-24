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

Nothing in the plan is signed or sent by EquityOS. The risk is that a user signs what the plan shows.

## What is verified

Every quote, from any provider, passes `verifyQuote` (`apps/web/src/server/execution/router.ts`) or is refused
with a typed reason. The checks are deterministic and run on the decoded calldata, not on the JSON fields the
provider reports next to it.

| Property      | Verification                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------- |
| Target        | `to` equals the pinned router, `0x6131b5fae19ea4f9d964eac0408e4408b66337b5` on Base           |
| Function      | One of the three swap functions of the router, by selector, decoded with the router's ABI     |
| Native value  | Zero                                                                                          |
| Tokens        | The requested pair, in the requested direction                                                |
| Amount pulled | `amount` and the sum of `srcAmounts` equal the planned amount                                 |
| Recipient     | `dstReceiver` is the user's address                                                           |
| Fees          | No fee receiver and no fee amount                                                             |
| Permit        | Empty                                                                                         |
| Flags         | No partial fill and no extra ETH                                                              |
| Minimum out   | At least the requested tolerance under the quote, recomputed here, and enforced by the router |

Around the calls:

- **Approvals are exact.** Each approval is for the total the plan swaps of the token, toward the router, and
  only when the current allowance is lower. Never unlimited.
- **The sequence is simulated** from the user's address at the block of the checks. A revert or an amount out
  below the minimum blocks the plan.
- **Funding counts minimums only.** Buys are funded by USDC held plus the minimum out of the sells.
- **`planHash`** binds the calls: the next step can refuse to send anything other than the calls the user saw.

The router address was checked against the provider's contract documentation, the address its API returns for
Base, its verified source on Sourcify (chain 8453) and an onchain read. A test pins it against the recorded
answers; the live test reads it from the chain. A provider that starts returning another router is refused
until the allowlist is changed on purpose.

## What is not verified

- **The route.** The executor data that the router runs (`targetData`, `executorData`) is the provider's and is
  not decoded. Which pools, market makers and intermediate tokens a swap uses is taken on trust. What bounds it
  is what the router enforces: the amount pulled from the user, the recipient and the minimum out.
- **The quote.** `quotedAmountOut` is the provider's estimate. Only the minimum is guaranteed, by the router.
- **The deadline.** It is requested from the provider and, if enforced, is enforced inside the executor data.
- **Gas.** The estimate is the provider's.
- **The router itself.** Its code is verified source, not audited by EquityOS. It has an owner, who can
  whitelist executors and rescue funds held by the router. A user's exposure is limited to the exact approval
  and the swap in flight.
- **Availability.** The API is keyless and rate limited, with no service commitment. When it is down or
  refuses, the leg is blocked with `provider_unavailable`, `provider_rate_limited` or `provider_rejected`; no
  other source is substituted.

## Trust assumptions

- The pinned router enforces `dstReceiver`, `amount` and `minReturnAmount` as its verified source does.
- The Base mainnet endpoint answers the pre-trade read and the simulation truthfully. A dishonest endpoint can
  make a plan look safe; the user's wallet then shows the call it signs, and the router still enforces the
  minimum.
- The B20 policy registry and token precompiles behave as the B20 interface documents.

## Operational notes

- Each request quotes up to 10 legs, two provider requests each. A deployment should rate limit the endpoint,
  so that a caller cannot exhaust the provider's limit for everyone or cause quotes that are never used.
- `KYBERSWAP_CLIENT_ID` identifies the deployment to the provider. It is not a secret.

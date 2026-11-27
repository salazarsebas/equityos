# Bounded executor

**Status: a design and a test simulation. Not deployed on any network, not audited, and not part of the
product.** Every trade EquityOS proposes today is signed by the user in their own wallet, one plan at a time
([Execution](execution.md)). This page describes what a contract that rebalances for a user without a signature
per trade would have to enforce, and why it is not shipped.

## The problem

Following an index means rebalancing when it drifts. With a signature per plan, nothing happens while the user
is away. Automating it means granting some party authority to trade the user's tokens later, without seeing each
trade. The question is how small that authority can be made.

A token allowance alone is too broad: it lets the spender move the tokens anywhere. A spend permission that caps
what a spender pulls per period bounds what leaves the wallet, not what comes back. What a rebalance needs is
narrower: swap between USDC and the constituents of one index version, through one known router, at a price
close to a trusted reference, up to a notional amount per period, with the proceeds returned to the user in the
same transaction.

## The design

The user grants a **mandate** to a contract, the executor, and approves the executor for the tokens it may sell.
A **keeper**, an account the user names, calls the executor to make each swap. The executor makes the swap only
when every bound of the mandate holds, and otherwise reverts.

| Mandate field                                | Meaning                                                    |
| -------------------------------------------- | ---------------------------------------------------------- |
| `indexId`, `version`                         | The pinned version whose constituents may be traded        |
| `keeper`                                     | The only account that may call for a swap                  |
| `expiresAt`                                  | After this time the mandate is void                        |
| `maxDeviationBps`                            | The worst price accepted, under the reference; at most 500 |
| `maxStalenessSeconds`                        | The oldest reference round accepted                        |
| `maxNotionalPerPeriodUsdE8`, `periodSeconds` | The reference value that may be traded per period          |

Each swap is checked and made in this order:

| Check                                                                                                                             | What it prevents                                     |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| The caller is the user's keeper, and the mandate exists and has not expired                                                       | Anyone else trading for the user                     |
| The index is not deprecated                                                                                                       | Trading for an index its creator withdrew            |
| One side is USDC and the other a constituent of the pinned version                                                                | Swapping into an arbitrary token                     |
| The reference is a positive, complete round from the token's feed, fixed at construction, no older than the mandate allows        | Trading on a stale or invalid price                  |
| The swap's minimum out is within `maxDeviationBps` under the reference, rounded against the user                                  | A minimum that accepts any price                     |
| The reference value of the swap fits in what is left of the period's notional cap                                                 | Unbounded churn of the user's holdings               |
| Pull exactly the input from the user; approve the router for exactly that amount; call the router, which is fixed at construction | Exposure beyond the swap in flight                   |
| Reset the approval; require that the router spent all of the input                                                                | A standing approval on the router, input left behind |
| Measure what came back; require at least the minimum; send all of it to the user                                                  | Proceeds kept by the executor or sent elsewhere      |

The executor holds nothing between calls and guards against reentrancy. The user can revoke the mandate at any
time, and should revoke the token approvals too.

With these bounds, the most a mandate can lose in one period, against the reference, is about its notional cap
times its deviation band: 500 USD at 1% is 5 USD a day.

## What it cannot bound

- **The reference.** The bound is relative to the feed. A wrong feed price is a wrong bound.
- **Timing within the band.** The keeper chooses when to trade. Any swap within the band and the cap is allowed,
  including one the methodology would not make: the executor does not recompute the plan onchain. The cap is what
  bounds churn.
- **The router.** It is trusted to execute the swap; the executor only checks what it spent and what came back.
- **Token rules.** Tokenized stocks on Base check a policy for the sender, the receiver and the caller of a
  transfer. The executor would have to be authorized as the caller, and a policy change can stop it.
- **The executor itself.** Approvals stand between swaps. A bug in the executor exposes every balance the user
  approved it for, which is the main reason it is not shipped.

## Why it is not shipped

1. Standing approvals to a contract are a different risk from signing one plan. That contract needs an external
   audit before it holds any approval on mainnet, and it has not had one.
2. A keeper is infrastructure that has to run, be monitored and be paid for, and its key is a new secret.
3. The bounds above stop the worst outcomes, not every outcome a user would object to. Choosing the cap and the
   band needs evidence from real use.

Until then the design stays a document and a simulation that runs only in tests.

## The simulation

`contracts/test/simulation/BoundedExecutorSimulation.sol` implements the design above. It lives under
`contracts/test`, so it is compiled only for tests: no deployment script references it, the coverage and static
analysis gates do not include it, and its header says it is a simulation. Its tests,
`contracts/test/BoundedExecutorSimulation.t.sol`, run it against the real `IndexRegistry` with mock tokens, feeds
and a mock router, and show each bound refusing what it should:

- a sell and a buy within the band pay the user everything the router returned, and leave the executor empty with
  its approval reset;
- a minimum below the band, and a router that pays less than the minimum, pays someone else, leaves input behind
  or calls back into the executor, all revert;
- another caller than the keeper, no mandate, a revoked or expired mandate, a deprecated index, a token outside
  the pinned version and a pair without USDC all revert, and the pinned version is used even after a newer one;
- a stale, zero, future, incomplete or wrongly scaled reference round reverts;
- the notional cap stops the sixth 100 USD sale of a 500 USD day, and the next period starts afresh;
- a fuzz test shows that no swap pays less than the band and that the executor never holds a token after a call.

```sh
forge test --root contracts --match-contract BoundedExecutorSimulationTest
```

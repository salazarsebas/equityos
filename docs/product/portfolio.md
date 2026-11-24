# Portfolio and drift

The page `/portfolio` compares the holdings of one address on Base with one published version of an index. It
reads, computes and shows. For the connected owner of the address, where execution is available, it can also
prepare an executable plan and ask the owner's wallet to sign it: see
[Executing from your wallet](#executing-from-your-wallet). The site never signs or sends anything itself.

## What is compared

| Side          | What it is                                                                          |
| ------------- | ----------------------------------------------------------------------------------- |
| The target    | The constituents and target weights of a conformant version, read from the registry |
| The holdings  | `balanceOf` of USDC and of every listed tokenized stock, read from Base mainnet     |
| The valuation | Each balance at its reference price, with the calculation `equityos.calc/1`         |

The numbers come from `GET /api/v1/portfolio` and `GET /api/v1/portfolio/plan` ([API](../api/portfolio.md)),
which apply `@equityos/core` exactly as the [calculation specification](../architecture/calculation.md) states.
A version that fails verification is refused with the check it fails: it has no target weights to compare with.

## Why nothing is stored

Following an index is not a record kept anywhere. There is no account and no database: the comparison is
computed again on every visit from the chain, the registry and the reference feeds. The whole state is in the
link:

```
/portfolio?address=0x...&index=<identifier>[&version=n][&plan=buy_only&deposit=<USD>]
```

A connected wallet fills `address` when the link has none, and the link then carries it. Any address can be
looked up without connecting. The browser remembers, in local storage under a versioned key, the last index each
address was compared with in that browser, and nothing else.

## Reading drift

- **Current weight** is the share of a constituent in the value of the constituents only. USDC and tokens outside
  the index are not in it, so the current weights sum to 100.00% and compare directly with the target weights.
- **Drift** is current weight minus target weight, in percentage points: `+15.00` means 15 points above target.
  Being above or below target is neither good nor bad, so the bars use the neutral tone inside the threshold and
  the warning tone from the threshold on, never the colors of a return. The short ticks mark the threshold on each
  side of zero, and every bar of the table shares one scale.
- **Largest drift** is compared with the drift threshold of the spec, in words: "Within threshold" or "Above
  threshold by X pp". A drift equal to the threshold reaches it.
- The table lists every constituent, held or not, largest drift first. A constituent the address does not hold
  shows a balance of 0.
- **Outside this index** lists the other index-eligible tokens the address holds. They are not counted in any
  value, weight or drift, and no plan sells them.
- **USDC not invested** is the USDC the address holds, valued at an assumed 1.00 USD.

When a reference price is unavailable, the totals, weights and drift are not shown, and the page says which
token blocks them: a partial sum is never presented as the total. A delayed price carries a clock marker, and a
closed market tags the table: values then use the last close.

## The plan preview

The plan is the rebalance plan of the methodology for this address, at reference prices.

- **Rebalance** sells constituents above their target value and buys those below it.
- **Buy only** never sells. It can add a deposit, typed in USD and parsed exactly from the decimal text to an
  integer scaled by 1e8: an amount with more than 6 decimals, finer than one USDC base unit, is refused, never
  rounded. A deposit through the API below one USDC base unit (`depositUsdE8` under 100) adds nothing and the plan
  is the plan without a deposit.

The preview shows the legs (side, asset, quantity, reference value), the largest drift before and after, the USDC
left after the legs and every finding in plain words with its code. A blocked plan shows its blockers and no leg;
a first replication too small to buy every constituent states the amount from which it can.

The preview is arithmetic toward the published target weights at reference prices. It contains no executable
quote, no slippage and no gas, so executable prices will differ, and it is not an instruction to trade. For each
constituent whose transfers are paused by its issuer the statement adds a line saying that a leg in it cannot be
executed while the pause lasts (`transferWarnings` of the plan).

## Executing from your wallet

Below the preview, "Execute from your wallet" leads to the exact calls a wallet would sign. It is offered only
when the plan has legs, the region is one where execution is available (from `GET /api/v1/status`; otherwise the
reason is shown and nothing more), and the connected wallet is the compared address. Otherwise it says what is
missing: a wallet to connect, or a connected wallet that is another address.

1. **Prepare to execute.** Requests the executable plan for the same comparison and mode
   ([API](../api/execution.md)). It quotes each leg with a third-party aggregator and checks it against the chain.
   A deposit typed in the preview is not part of it: an executable plan spends what the address holds. Preparing
   signs and sends nothing.
2. **Review.** Built once from a frozen snapshot of the plan, verified in this browser, which also reads the
   decimals of every token and each leg's reference feed on the chain itself. It shows the index id and version,
   then each call in order with what it does, decoded from its calldata: an approval with its exact amount and
   spender, a swap with its side, amount in, minimum out, the provider's quote marked as not guaranteed, the
   reference price read in this browser and how far the minimum is from it, the route deadline, and the router; the
   attestation call when there is one, or why there is none. An allowance toward the router already above what
   the plan swaps is shown with how to reduce it. Then the totals (minimum USDC from sells, maximum USDC spent by
   buys, USDC held when checked, expected balances at minimum amounts out), every pre-trade check with its result,
   a checkbox for each warning, the plan hash computed here, the expiry with a countdown by the device clock (the
   expiry itself is checked against the latest block at signing), whether the wallet batches, and three fixed
   statements: executable prices differ from reference prices; nothing here is advice; you sign every call in
   your own wallet.
3. **Sign.** The button says what happens: "Sign 6 calls in your wallet" for a wallet that batches, "Sign 5
   transactions in your wallet, one at a time" for one that does not. It is disabled with the reason until every
   warning is acknowledged, and it is absent for a blocked plan, a plan this browser refused, a plan whose hash
   does not match, and an expired plan, which offer "Get a new plan" instead.
4. **Progress and result.** Declining in the wallet is a calm state: nothing was sent, and the review can be used
   again. A batch either takes effect entirely or not at all. One transaction at a time stops at the first one that
   does not confirm, and the page lists what confirmed, what failed and what was not sent, notes that confirmed
   approvals stay in place for their exact amounts, and shows the position read from the chain. After every
   swap confirmed one at a time, recording the rebalance onchain is offered as one more, optional transaction.
5. **After.** The balances are read again on the chain and the drift is recomputed against the index with the
   comparison's reference prices: largest drift before and after, and each balance and drift before and after.
   Transaction hashes link to the explorer of the network.

"Executions from this browser" lists earlier executions of the account on the plan's network, with their hashes
linked to that network's explorer, the index version, the result and where a run stopped. It is stored only in this browser's local storage, under a versioned key, and the page says so.

Execution is on Base mainnet. The rebalance log is not deployed there, so no attestation is recorded on Base, and
the review says so.

## Without JavaScript

The form is a GET form and works without JavaScript: the link it produces is the comparison. The comparison
itself is rendered in the browser from the API, so without JavaScript the page shows where the same data can be
read as JSON.

## Test data

The browser tests run the page against the recorded registry, the recorded Base mainnet block and four accounts
with constructed balances (`apps/web/test/fixtures/market/balances.json`): on target, above the threshold with
holdings outside the index, empty, and USDC only. The page says, in its replay notice, that these balances are
constructed and not read from any chain.

A server that replays recorded market data builds no executable plan. The browser tests of the execution review
answer the plan request themselves, and the chain tests execute plans on a local Anvil node against mock contracts
installed at the pinned addresses; both are described in
[Sending an execution plan](../security/execution-sending.md#tests).

# Portfolio and drift

The page `/portfolio` compares the holdings of one address on Base with one published version of an index. It
reads, computes and shows. It does not send, sign, quote or prepare a transaction.

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
  the accent tone from the threshold on, never the colors of a return. The short ticks mark the threshold on each
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
Executing is not available on this site: the page states why, from `GET /api/v1/status`, and offers no control
that trades.

## Without JavaScript

The form is a GET form and works without JavaScript: the link it produces is the comparison. The comparison
itself is rendered in the browser from the API, so without JavaScript the page shows where the same data can be
read as JSON.

## Test data

The browser tests run the page against the recorded registry, the recorded Base mainnet block and four accounts
with constructed balances (`apps/web/test/fixtures/market/balances.json`): on target, above the threshold with
holdings outside the index, empty, and USDC only. The page says, in its replay notice, that these balances are
constructed and not read from any chain.

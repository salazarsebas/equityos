# Portfolio, drift and rebalance plan `equityos.calc/1`

This page specifies the part of `equityos.calc/1` that turns the constituents of a published index version, the
holdings of one wallet and reference prices into numbers: position values, current weights, drift, whether the
rebalance rule of the spec makes a rebalance due, and the legs that move the wallet toward the target weights.
It is detailed enough to write a second implementation that produces the same numbers.

The reference implementation is `@equityos/core` (`packages/core/src/portfolio.ts` and
`packages/core/src/rebalance.ts`). It is pure: it reads no chain, file or clock, time is an input, and every
operation is on integers. Test vectors are published in `packages/core/vectors/rebalance-plans.json`.

A plan is arithmetic toward a published target at reference prices. It is not a recommendation, and it is not a
quote: see [What the plan does not know](#what-the-plan-does-not-know).

## Units

| Quantity          | Unit                                                             | Type     |
| ----------------- | ---------------------------------------------------------------- | -------- |
| Token balance     | Token base units: `10^decimals` base units are one token         | `bigint` |
| Reference price   | USD per whole token scaled by 1e8 (`priceE8`)                    | `bigint` |
| Value             | USD scaled by 1e8 (`...UsdE8`)                                   | `bigint` |
| Quote amount      | Base units of the quote asset: 6 decimals, 1,000,000 is one unit | `bigint` |
| Weight and drift  | Basis points, 10,000 bps is 100%                                 | `number` |
| Time and duration | Unix seconds, seconds                                            | `number` |

Basis points, counts and seconds are safe integers. No step uses floating point.

## Inputs

| Input          | Content                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| `constituents` | `token`, `weightBps`, `decimals` for every constituent of the target version |
| `holdings`     | `token`, `balance`, `decimals` for tokens the wallet holds, in any order     |
| `prices`       | `token`, `priceE8`, `status` for reference prices, in any order              |
| `quoteBalance` | Quote asset counted toward the replication, in quote base units              |

`constituents` come from `computeConstituents` plus the decimals recorded for each token in the asset list. An
index has at most 64 constituents. `holdings` carry the decimals the token reports. `status` is the staleness
class of the market data layer: `live`, `delayed`, `last_close` or `unavailable`.

Prices come from outside the calculation, so `status` is read against an allow-list. Only `live`, `delayed` and
`last_close` carry a value. A price whose status is `unavailable`, absent or anything else is reported as
`unavailable`, and its `priceE8` is never read, whatever it holds.

The optional input `blockOnLastClose` (default `false`) decides how a closed market is reported. See
[A closed market](#a-closed-market).

The quote asset is USDC. **Stated assumption:** one whole unit of the quote asset is valued at exactly 1 USD,
so one quote base unit is worth exactly 100 units of USD scaled by 1e8. The assumption is carried in every
valuation as `quotePriceE8`. The quote asset has no reference price input, so a depeg is not visible to this
calculation.

## Definitions

| Term              | Definition                                                                      |
| ----------------- | ------------------------------------------------------------------------------- |
| Position value    | `floor(balance * priceE8 / 10^decimals)` of one constituent                     |
| Invested value    | Sum of the position values of the constituents                                  |
| Quote value       | `quoteBalance * 100`, exact                                                     |
| Deployable value  | Invested value plus quote value. In a plan, also the deposit and the exits sold |
| Current weight    | Share of a constituent in the invested value, in bps. The weights sum to 10,000 |
| Uninvested share  | `floor(quoteValue * 10000 / deployableValue)`: cash to deploy, in bps           |
| Outside the index | A token the wallet holds that is not a constituent. Reported, never counted     |
| Target weight     | `weightBps` of the constituent in the published version                         |
| Drift             | `currentWeightBps - targetWeightBps`, signed: positive above target             |
| Maximum drift     | Largest absolute drift of a constituent                                         |
| Turnover          | Half the sum of the absolute drifts                                             |
| Target value      | `floor(deployableValue * targetWeightBps / 10000)` of one constituent           |
| Delta             | Target value minus position value: positive to buy, negative to sell            |
| Leg               | One swap between a token and the quote asset                                    |
| Reserve           | Share of the available funds that buys leave unspent, `reserveBps`              |
| Minimum leg value | Reference value below which a leg is not proposed, `minLegValueUsdE8`           |

## Valuation

`valuePortfolio` returns one position per constituent in ascending token order, the holdings outside the index,
the totals and the findings.

### The denominator

There are two totals, and each number says which one it uses.

- **Current weights use the invested value**: constituents only. The quote asset and tokens outside the index
  are not in the denominator. The weights of the constituents therefore sum to exactly 10,000 and compare
  directly with the target weights, which also sum to 10,000. A wallet whose constituents are in the target
  proportions has zero drift whatever cash sits next to them.
- **Cash to deploy is reported apart**: `quoteBalance`, `quoteValueUsdE8` and `cashShareBps`, the share of the
  deployable value held in the quote asset. `cashShareBps` is not a weight and is not part of the 10,000.
- **Targets of a plan use the deployable value**, because deploying the cash is what a plan does.

The alternative, one denominator that includes cash, makes every constituent of a wallet with uninvested cash
read as below target and turns drift into a measure of how much cash is waiting. The rebalance rule of the spec
is about the proportions of the constituents, so drift measures only that.

### Weights

With `V` the invested value and `v` the value of a constituent:

1. Every constituent gets `floor(v * 10000 / V)` bps.
2. The basis points still missing, fewer than the number of constituents, are given one each by largest
   remainder `v * 10000 mod V`, ties broken by ascending token address.

This is the rule of the spec weights. The result sums to exactly 10,000 and does not depend on input order.
When `V` is zero no weight is defined: every `weightBps` is `null`. Zero is not substituted.

### Missing data

A constituent needs a usable price even when its balance is zero, because a plan has to size a buy with it. A
price is usable when its status is `live`, `delayed` or `last_close` and it is above zero. A constituent without
a usable price, or whose holding reports other decimals than the constituent, has no value, and then the
invested value, the deployable value and every weight are `null`. The values of the other positions are still
returned.

A token outside the index is valued when it has a usable price and has a `null` value otherwise. It produces no
finding and takes no part in any total.

## Drift

`computeDrift(positions, driftThresholdBps)` returns, for each constituent,
`driftBps = currentWeightBps - targetWeightBps`, and:

- `maxAbsDriftBps` and `maxDriftToken`: the largest absolute drift and its token, the lowest address on a tie.
- `turnoverBps`: half the sum of the absolute drifts. Current and target weights both sum to 10,000, so the
  drifts sum to zero, the sum of their absolute values is even and the half is exact. It is the share of the
  invested value that has to change hands to reach the target weights.
- `thresholdReached`: `maxAbsDriftBps >= driftThresholdBps`. The spec defines `rebalance.driftThresholdBps` as
  the deviation that makes a rebalance due, so a drift equal to the threshold reaches it.

Drift is `null` when the weights are `null`.

## Rebalance eligibility

`rebalanceEligibility` applies `rebalance` of the spec (`trigger: "drift"`, `driftThresholdBps`,
`minIntervalSeconds`) to a valuation, the time of the last rebalance (or none) and `now`. The checks run in
this order and the first that applies is the result:

| Order | Condition                                        | Result                                                  |
| ----- | ------------------------------------------------ | ------------------------------------------------------- |
| 1     | The invested value is `null`                     | Not due: `valuation_blocked`, with the blockers         |
| 2     | The invested value is zero                       | Due: `first_replication`                                |
| 3     | `maxAbsDriftBps < driftThresholdBps`             | Not due: `below_threshold`, with both numbers           |
| 4     | `lastRebalanceAt + minIntervalSeconds - now > 0` | Not due: `min_interval_not_elapsed`, `secondsRemaining` |
| 5     | Otherwise                                        | Due: `drift_threshold_reached`                          |

A data problem comes first: a wallet that holds nothing is not called a first replication while a constituent
has no usable price. A first replication is decided by value, not by balances, so a wallet holding base units
too small to have a value is a first replication and is never left without an answer.

A rebalance is due once exactly `minIntervalSeconds` have elapsed. A last rebalance recorded after `now` has
not elapsed. Without a last rebalance, check 4 is skipped.

The rule states when the methodology calls for a rebalance. It does not gate `planRebalance`: a plan can be
computed at any time, and adding quote asset to a replication is not a rebalance under the rule.

## Rebalance plan

`planRebalance` takes the valuation inputs and:

| Input              | Default     | Meaning                                                           |
| ------------------ | ----------- | ----------------------------------------------------------------- |
| `mode`             | none        | `rebalance` sells and buys. `buy_only` never sells                |
| `depositUsdE8`     | `0`         | Quote asset added before execution and not part of `quoteBalance` |
| `exitTokens`       | none        | Tokens that left the index in the target version                  |
| `reserveBps`       | `50`        | Share of the funds that buys leave unspent, 0 to 2000             |
| `minLegValueUsdE8` | `100000000` | Reference value below which a leg is skipped (1.00 USD)           |

The result is one of two shapes, told apart by `status`:

- `status: "blocked"` has `blockers`, `warnings` and `valuation`. It has no `legs` property at all, so code
  that reads legs without checking the status does not compile and does not find any.
- `status: "ready"` has `warnings`, `valuation`, the targets, `legs`, `skipped` and the projection.

Every leg goes through the quote asset. A sell is exact in token quantity: the plan states the quantity to sell
and the proceeds at the reference price. A buy is exact in quote amount: the plan states the amount of quote
asset to spend and the quantity it buys at the reference price. Both are the amounts a wallet controls, so no
later step has to round them.

### Steps

1. **Available quote**: `quoteBalance + floor(depositUsdE8 / 100)` quote base units.
2. **Tokens to exit** (`rebalance` mode): every token of `exitTokens` that the wallet holds sells its whole
   balance. The leg value is `floor(balance * priceE8 / 10^decimals)` and its proceeds are `floor(value / 100)`.
   An exit that fails the minimum (step 8) is skipped and takes no further part.
3. **Deployable value**: invested value, plus `availableQuote * 100`, plus the values of the exits that are
   sold.
4. **Target value** of each constituent: `floor(deployable * targetWeightBps / 10000)`.
5. **Full sells** (`rebalance` mode). A constituent above its target would sell
   `floor((value - target) * 10^decimals / priceE8)` base units, with value and proceeds as in step 2. A sell
   that fails the minimum is skipped.
6. **Buys.** The full budget is `floor((availableQuote + all proceeds) * (10000 - reserveBps) / 10000)`. A
   constituent below its target wants `floor((target - value) / 100)` quote base units. When the sum wanted
   exceeds the budget, the share of each buy is `floor(wanted * budget / sumWanted)`; otherwise it is the
   amount wanted. A buy of share `q` buys `floor(q * 100 * 10^decimals / priceE8)` base units and spends what
   that quantity costs: `ceil(ceil(quantity * priceE8 / 10^decimals) / 100)` quote base units, never more than
   `q`. A buy that fails the minimum is skipped, and then the remaining buys are capped as described in
   [A skipped buy](#a-skipped-buy).
7. **Sells are scaled to the buys.** With `spent` the sum the buys spend, the sells have to raise
   `needed = ceil(spent * 10000 / (10000 - reserveBps)) - availableQuote - exit proceeds`. When `needed` is
   zero or less, no constituent is sold (`not_needed`). When it is below the proceeds of the full sells, each
   sell is scaled: see [Sells follow the buys](#sells-follow-the-buys). Tokens to exit are always sold in full.
8. **Minimum**: a leg whose token quantity or quote amount is zero is skipped as `zero_quantity`. A remaining
   leg whose value is below `minLegValueUsdE8` is skipped as `below_minimum`. A leg worth exactly the minimum is
   proposed.
9. **Projection**: every proposed leg applied at its reference price. Balances, values, weights and drift of the
   constituents are computed as in a valuation, and the quote asset left is
   `availableQuote + proceeds - amounts spent`.

`legs` is the execution order: every sell in ascending token order, then every buy in ascending token order.
Sells come first because they fund the buys. `skipped` is in the same order.

### Rounding rules

Every rounding leaves value unspent. None spends value that is not there.

| Step                    | Direction                    | Why                                                            |
| ----------------------- | ---------------------------- | -------------------------------------------------------------- |
| Position value          | Down                         | A position is never shown as worth more than its balance is    |
| Weight                  | Down, then largest remainder | The weights sum to exactly 10,000                              |
| Uninvested share        | Down                         | A single displayed ratio, never above the exact one            |
| Deposit to quote units  | Down                         | A fraction of a quote base unit cannot be transferred          |
| Target value            | Down                         | The targets never sum to more than the deployable value        |
| Sell quantity           | Down                         | A sell never takes a constituent below its target value        |
| Sell value and proceeds | Down                         | Proceeds that may not arrive are not counted as funds for buys |
| Buy budget              | Down                         | The reserve is never smaller than asked                        |
| Buy amount wanted       | Down                         | A buy never takes a constituent above its target value         |
| Share of a scaled buy   | Down                         | The buys never sum to more than the budget                     |
| Cap of a buy            | Down                         | A capped buy never ends above its target weight                |
| Buy token quantity      | Down                         | The plan never expects more tokens than the amount spent buys  |
| Buy amount spent        | Up, from the quantity        | The amount covers the quantity bought, and no more             |
| Proceeds needed         | Up                           | The buys stay within the budget after the reserve              |
| Scaled sell quantity    | Up, at most the full sell    | The sells raise at least what the buys spend                   |
| Minimum portfolio value | Up                           | The stated value is enough                                     |

The amount a buy spends is the one place where an amount handed to a leg is rounded up, and it is rounded up
from a quantity that was first rounded down from the share of the buy, so it never exceeds that share. Without
it a buy of a coarse token would spend its whole share for the base units it can actually buy: 1,999 USDC for
one unit of a whole-unit token at 1,250.00 USD. The leg spends 1,250 USDC and 749 USDC stay in the wallet.

### Reserve

The buys can spend at most the buy budget: the quote available plus the proceeds of the sells, less
`reserveBps` of that sum. The reserve stays in the quote asset and appears in the projected quote balance.

The default is 50 bps. The reference feeds publish a new value when the price deviates by 0.5%, so a reference
price can trail the market by up to 50 bps while still being current, and a buy sized on it can cost that much
more by the time it executes. The reserve is a buffer for that movement. It is not an estimate of slippage,
fees or gas.

The maximum is 2000 bps (20%); a larger value is an input error. A caller that expects prices to move by more
than a fifth between plan and execution has no usable reference, and the answer to that is a blocker, not a
larger buffer. A reserve near 100% would turn a plan into sales that buy nothing.

When the budget is smaller than what the buys want, every buy is scaled by the same ratio, so each constituent
below target closes the same fraction of its shortfall. The alternative of filling the constituent with the
widest shortfall first concentrates the plan in fewer, larger legs and makes the result depend on which
constituent happens to be widest; the pro rata rule has no ordering in it.

### Minimum leg value

Every leg is one swap with a cost that does not shrink with its size: a network fee, a signature, the minimum
price increment of a pool. Below some size a leg costs a material share of what it moves. A leg whose reference
value is below `minLegValueUsdE8` is therefore not proposed. It is listed in `skipped` with the value it was
sized for and the reason, and it stays visible.

The default is 1.00 USD. A caller that knows the real cost of a swap passes its own value, and `0` disables the
rule.

### A skipped buy

What a skipped buy would have spent is not given to the other buys. Giving it to them, or simply letting them
go ahead, would push a wallet off target: with targets of 90/10, holdings of 9.00 and 1.00 USD and a deposit of
10 USD, the buy of the smaller constituent is 0.995 USD and is skipped; buying only the larger one would move
the wallet from 9000/1000 to 9472/528.

So when at least one buy is skipped, the remaining buys are capped: **no bought constituent may end above its
target weight of the projected invested value**. With `N` the sum of the values of the constituents that are
not capped (as they would be after the full sells and the uncapped buys) and `W` the sum of the weights of the
capped ones, a capped constituent of weight `w` may hold `floor(w * N / (10000 - W))`. A constituent is capped
when its planned value exceeds that share. Capping lowers the total, so the check repeats until no constituent
exceeds its share, at most once per constituent. A cap can leave a buy under the minimum; it is then skipped
with reason `above_target_weight` and the caps are computed again, at most once per buy.

What the capped and skipped buys do not spend stays in the quote asset and is reported as
`projected.quoteBalance`. In the example nothing is bought and the 10 USD stay uninvested, with both buys in
`skipped`. The cap applies only after a skip: when every buy goes through, the pro rata shares already keep the
proportions.

One consequence is stated here because it can surprise: a constituent that cannot be bought holds back the buys
of constituents that are already at or above their target weight. They stay where they are until the amount
is large enough for every buy.

### A first replication

When the invested value is zero, the cap makes the plan all or nothing: if one constituent cannot be bought,
every other buy is capped at zero. A plan that buys nothing, or that sells the tokens to exit and buys nothing,
is not a replication of the index. It is reported as the blocker `below_minimum_portfolio_value` instead of a
ready plan with no legs, so that the reason is explicit and no sale is proposed on its own.

The blocker carries `minimumDeployableValueUsdE8`, a deployable value from which every constituent gets a buy
leg with the same reserve and minimum:

```
minimum = max over constituents of
          ceil((minLegValueUsdE8 + unit + rounding) * 10000 * 10000 / (weightBps * (10000 - reserveBps)))
unit     = ceil(priceE8 / 10^decimals)        value of one base unit of the token
rounding = 100 * (8 + number of tokens to exit)
```

A constituent of weight `w` receives about `value * w * (1 - reserve)`. That has to reach the minimum leg value
plus what rounding can take away: one base unit of the token and a few quote base units. The value is
sufficient, not the exact minimum: a property test plans every blocked first replication again with this value
in quote asset and checks that every constituent is bought. For 64 equal-weighted constituents, no reserve and
the default minimum it is 64.11 USD, rounded up to a cent.

It is a blocker and not a warning because a warning would come with a ready plan, and the only ready plans
available here are an empty one or one that only sells.

### Sells follow the buys

A sale whose proceeds no buy spends only moves value into the quote asset. That shrinks the invested value and
raises the weight of everything that was not sold, so it can increase drift. Sells are therefore sized last:

- `needed` is the proceeds the buys require, including their reserve (step 7).
- If no proceeds are needed, no constituent is sold. Each full sell is listed in `skipped` as `not_needed`.
- If less than the full proceeds is needed, each sell of quantity `q` out of full proceeds `P` over `k` sells
  becomes `min(q, max(ceil(q * (needed + k - 1) / P), smallest))`, where `smallest` is
  `ceil(max(minLegValueUsdE8, 100) * 10^decimals / priceE8)`, the smallest quantity that passes the minimum.

Rounding a scaled sell down to quote base units loses less than one unit, so `k` sells together lose at most
`k - 1`; aiming `k - 1` units higher makes them raise at least `needed`. A scaled sell is never above the full
sell, so no constituent is sold below its target value, and never below the minimum, so it remains a leg worth
proposing. Raising a sell to the minimum can leave up to one minimum leg value per sell in the quote asset.

`buyBudgetQuote` in the result is computed from the sells that are proposed, and the buys never exceed it.

### Buy only

In `buy_only` mode the plan has no sell. The targets are computed from the deployable value, the constituents
below target share the quote available as in step 6, and the constituents above target are left as they are.
It moves toward the target with the fewest legs. It does not reach the target when a constituent is above its
target value, and the projection states the drift that remains. `exitTokens` is ignored in this mode: the
tokens are not sold and their value is not deployable.

### Tokens to exit

A plan only ever trades constituents of the target version, with one exception. When a newer version removes a
constituent, the caller passes the tokens of the previous version that are no longer constituents as
`exitTokens`. In `rebalance` mode each one the wallet holds is sold in full (`exit: true` on the leg) and its
proceeds fund buys. A token to exit that the wallet holds needs a usable price; one the wallet does not hold
needs none.

An exit below the minimum leg value is skipped. It stays in the wallet, so its value is not part of the
deployable value and does not raise any target.

Any other token outside the index is never sold and never counted. Listing a constituent of the target version
as a token to exit is an input error.

### Projection

`projected` is the wallet after every proposed leg at reference prices: balance, value, weight and drift of
each constituent, the invested value, the quote asset left uninvested and the maximum drift.
`currentMaxAbsDriftBps` is the maximum drift before, or `null` when nothing is invested.

## Blockers and warnings

Data-quality problems are returned as data. `valuePortfolio` returns them in `issues`, each with its severity.
`planRebalance` returns the same findings split into `blockers` and `warnings`, and a result with any blocker
has status `blocked`.

| Code                            | Severity | Condition                                                            |
| ------------------------------- | -------- | -------------------------------------------------------------------- |
| `missing_price`                 | Blocker  | No price for a constituent, or for a held token to exit              |
| `price_unavailable`             | Blocker  | The status is `unavailable`, absent or not a known class             |
| `zero_price`                    | Blocker  | The price is zero                                                    |
| `decimals_mismatch`             | Blocker  | A holding reports other decimals than its constituent                |
| `zero_deployable_value`         | Blocker  | The deployable value of the plan is zero: there is nothing to deploy |
| `below_minimum_portfolio_value` | Blocker  | A first replication cannot buy every constituent                     |
| `market_closed`                 | Warning  | The status is `last_close`. A blocker with `blockOnLastClose`        |
| `price_delayed`                 | Warning  | The status is `delayed`                                              |
| `projected_drift_increase`      | Warning  | The projected maximum drift is above the current one                 |

Each finding names its token, or `null` when it concerns the whole portfolio.
`below_minimum_portfolio_value` carries `minimumDeployableValueUsdE8`. `projected_drift_increase` carries
`currentMaxAbsDriftBps` and `projectedMaxAbsDriftBps`; a first replication has no current drift, so its
projected drift is compared against zero and `currentMaxAbsDriftBps` is `null`.

### A closed market

**By default a `last_close` price is a warning, and a plan is computed with it.** With a `last_close` price the
market is closed: the reference price is the value the feed held when trading stopped, onchain markets keep
trading, and execution prices will differ by an amount this calculation cannot bound. The calculation reports
that and does not decide: whether to act on a plan built on a closed market is a decision of the layer above,
which knows the executable quotes.

A caller that does not want such a plan passes `blockOnLastClose: true`. The finding `market_closed` then has
severity `blocker` everywhere it is reported, in `valuePortfolio` and in `planRebalance` alike, and the plan
has status `blocked` with no legs. The position is still valued, because the last close is a published value:
drift and eligibility remain available while the market is closed.

A caller that leaves the default has to handle the `market_closed` warning. A ready plan that carries it is
sized on prices that are hours or days old.

### Input errors

Inputs that no correct caller produces throw a `CalculationInputError` with a code:

| Code                        | Condition                                                              |
| --------------------------- | ---------------------------------------------------------------------- |
| `invalid_address`           | A token that is not `0x` and 40 lowercase hexadecimal digits           |
| `duplicate_token`           | A token repeated in a list                                             |
| `negative_amount`           | A negative balance, usable price, deposit or minimum                   |
| `invalid_amount`            | A balance, usable price, deposit or minimum that is not a `bigint`     |
| `invalid_decimals`          | Decimals that are not an integer from 0 to 36                          |
| `invalid_weights`           | No constituent, a weight outside 1 to 10000, or a sum other than 10000 |
| `too_many_constituents`     | More than 64 constituents                                              |
| `invalid_bps`               | A threshold outside 1 to 10000, or a reserve outside 0 to 2000         |
| `invalid_time`              | A time or interval that is not a non-negative integer of seconds       |
| `invalid_mode`              | A mode other than `rebalance` or `buy_only`                            |
| `exit_token_is_constituent` | A token to exit that is a constituent of the target version            |

A number passed where a `bigint` is required is rejected with `invalid_amount` before any arithmetic. The amount
of a price that is not usable is not validated, because it is never read: such a price is a blocker.

## Guarantees

These hold for every input that produces a plan. They are checked by property tests over 4,000 seeded random
portfolios: first replications, wallets on target and arbitrary wallets, in both modes.

- **Funds**: the quote amounts of the buys sum to at most the buy budget, which is at most the quote available
  plus the proceeds of the sells. The projected quote balance is never negative and is at least the reserve.
- **Balances**: a sell never exceeds the balance held, and a token to exit is sold in full or not at all.
- **No empty leg**: every leg has a token quantity and a quote amount above zero and a value of at least the
  minimum. A buy spends exactly what its quantity costs, rounded up to a quote base unit.
- **Conservation**: the projected total (invested value plus quote value) is never above the total before
  (invested value, quote available and tokens sold to exit). It is below it by at most 100 per leg, in USD
  scaled by 1e8: one quote base unit.
- **Direction**: the projected value of every constituent lies between its current value and its target value,
  both included. No leg moves a constituent away from its target value or past it.
- **Weights**: current and projected weights each sum to exactly 10,000 when the invested value is above zero.
- **Order**: the output does not depend on the order of constituents, holdings, prices or tokens to exit.
- **Buy only**: a `buy_only` plan has no sell.
- **Skipped buys**: when a buy is skipped, no bought constituent ends above its target weight, up to the
  rounding `E` below.
- **Sells follow buys**: the constituents sold raise at most what the buys need, plus per sell one base unit of
  its token, the minimum leg value and three quote base units. When no buy is proposed no constituent is sold.
- **First replication**: a first replication either buys every constituent or is blocked, and the stated
  minimum deployable value is enough.

### Bounds on drift

`unit(t)` is the value of one base unit of token `t`, `ceil(priceE8 / 10^decimals)`. With `n` constituents and
`exits` tokens to exit,

```
E = sum of unit(t) over the constituents + 100 * (n + exits + 2) + 1
G = ceil(10000 * (n + 1) * 2 * E / projectedInvestedValue)
```

`E` is the largest distance, in USD scaled by 1e8, that rounding to base units can put between a projected
value and the value the rules aim at. `G` is that distance as a share of the projected invested value, in bps.
For a portfolio that is large against the granularity of its tokens `G` is 1.

- **A wallet on target stays on target.** When the current maximum drift is 0 bps, the projected maximum drift
  is at most `n + 4 + G` bps, in both modes and with any reserve and minimum. A drift of 0 bps means every
  weight is within 1 bps of its target; a plan can add at most that deviation once per constituent, plus the
  rounding of weights. In the seeded cases with `G` at most 1 the projected maximum drift of such a wallet is 0.
- **A full rebalance reaches the target.** In `rebalance` mode with `reserveBps` 0 and `minLegValueUsdE8` 0,
  when no buy is skipped, every projected drift is within `G + 1` bps, which is 2 bps for a portfolio that is
  large against the granularity of its tokens, and the projected maximum drift never exceeds the larger of the
  current one and that bound.

A plan that is partial, because of the reserve, the minimum leg value, a cap or `buy_only`, does not always
lower the maximum drift of a wallet that is off target. In `buy_only` mode the constituents above target cannot
be sold, and the pro rata buys can leave a large constituent further under its target than any constituent was
before. The plan does not hide this. It reports the maximum drift before and after, and adds the warning
`projected_drift_increase` with both numbers whenever the projected one is higher. The guarantee that holds
without exception is the one on values above: every constituent ends at least as close to its target value as
it started.

## What the plan does not know

- **Executable prices.** Every quantity is sized at a reference price. A reference price is not a quote, and no
  trade is guaranteed at it. `valueUsdE8` and `quoteAmount` of a sell are not the proceeds of a swap, and
  `tokenQuantity` of a buy is not what a swap returns.
- **Slippage and price impact.** The plan does not know the liquidity of any pool. The reserve covers movement
  of the reference price, nothing else.
- **Fees and gas.** Swap fees and network fees are not deducted. The minimum leg value is a threshold supplied
  by the caller, not a cost estimate.
- **Transfer restrictions.** The plan does not know whether a wallet is allowed to hold or transfer a token.
  A token that a wallet cannot receive still gets a buy leg.
- **Execution.** The plan assumes every leg settles in order. It does not model a leg that fails or settles at
  another amount: a later layer computes a new plan from the balances that result.
- **The quote asset price.** It is assumed to be exactly 1 USD.
- **Market hours.** It only sees the staleness class of each price. See [A closed market](#a-closed-market).

## Worked example

Vector `two-tokens-default-reserve`. An index of two constituents:

| Token | Decimals | Target | Balance (base units)             | Reference price | `priceE8`      |
| ----- | -------- | ------ | -------------------------------- | --------------- | -------------- |
| A     | 8        | 6000   | `80000000` (0.8)                 | 1,250.00 USD    | `125000000000` |
| B     | 18       | 4000   | `1000000000000000000000` (1,000) | 0.50 USD        | `50000000`     |

The wallet holds no quote asset. Defaults apply: reserve 50 bps, minimum leg value 1.00 USD.

**Valuation.** A is `floor(80000000 * 125000000000 / 10^8) = 100000000000` (1,000.00 USD). B is
`floor(10^21 * 50000000 / 10^18) = 50000000000` (500.00 USD). The invested value is `150000000000`.

**Weights.** A: `100000000000 * 10000 / 150000000000` is 6,666 with remainder `100000000000`. B: 3,333 with
remainder `50000000000`. One basis point is missing and goes to the larger remainder: A 6667, B 3333.

**Drift.** A `6667 - 6000 = +667`, B `3333 - 4000 = -667`. Maximum drift 667 bps, turnover 667 bps.

**Targets.** The deployable value is `150000000000`. A: `floor(150000000000 * 6000 / 10000) = 90000000000`.
B: `60000000000`. Deltas: A `-10000000000`, B `+10000000000`.

**Full sell.** A is 100.00 USD above target: `floor(10000000000 * 10^8 / 125000000000) = 8000000` base units
(0.08 A), worth `10000000000`, proceeds `100000000` quote base units (100 USDC).

**Budget.** `floor(100000000 * 9950 / 10000) = 99500000` (99.50 USDC).

**Buy.** B wants `floor(10000000000 / 100) = 100000000`, more than the budget, so its share is
`floor(100000000 * 99500000 / 100000000) = 99500000`. That buys
`floor(9950000000 * 10^18 / 50000000) = 199000000000000000000` base units (199 B), which cost
`ceil(199 * 10^18 * 50000000 / 10^18) = 9950000000`, so the leg spends `99500000`. Nothing is skipped, so
nothing is capped.

**Sells follow the buys.** The buy needs `ceil(99500000 * 10000 / 9950) = 100000000` of proceeds, which is the
full sell.

| #   | Side | Token | `tokenQuantity`         | `quoteAmount` | `valueUsdE8`  | `priceE8`      |
| --- | ---- | ----- | ----------------------- | ------------- | ------------- | -------------- |
| 1   | sell | A     | `8000000`               | `100000000`   | `10000000000` | `125000000000` |
| 2   | buy  | B     | `199000000000000000000` | `99500000`    | `9950000000`  | `50000000`     |

**Projection.** A holds `72000000` worth `90000000000`. B holds `1199000000000000000000` worth `59950000000`.
The invested value is `149950000000` and `500000` quote base units (0.50 USDC, the reserve) are left. A is
`90000000000 * 10000 / 149950000000 = 6002.0007`, B is `3997.9993` and takes the missing basis point:
6002 and 3998. The maximum drift goes from 667 bps to 2 bps. The 2 bps that remain are the reserve.

## Test vectors

`packages/core/vectors/rebalance-plans.json`, importable as `@equityos/core/vectors/rebalance-plans.json`.

| Property             | Content                                                                             |
| -------------------- | ----------------------------------------------------------------------------------- |
| `calc`               | `equityos.calc/1`                                                                   |
| `vectors[].name`     | Unique name                                                                         |
| `vectors[].input`    | The input of `planRebalance`. An optional property that is absent takes its default |
| `vectors[].expected` | The exact result, with `status` `ready` or `blocked`                                |

Every balance, price, value and quote amount is a decimal string, because these integers can exceed 2^53. Basis
points, decimals and booleans are JSON numbers and booleans. A value that is not defined is `null`. Two vectors
carry a price whose `status` is absent or not a known class.

The vectors cover both modes, the defaults, every blocker, warning and skip reason, a token to exit, tokens of
0, 6, 8 and 18 decimals, prices from 0.07 USD to 4,321.00 USD, an index of one constituent and one of 64, and
portfolios from 9 USD to 10 million USD.

The expected output of every vector was produced by `@equityos/core` and checked against an independent
implementation of this page written in another language, which is not part of the repository: blockers,
warnings, targets, legs, skipped legs and projection agree on all of them.

## Tests

`packages/core/test`: `portfolio.test.ts` (valuation, weights, findings, drift), `rebalance.test.ts`
(eligibility, worked examples with hand-computed numbers, one group per rule), `rebalance-properties.test.ts`
(the guarantees above over seeded random portfolios) and `plan-vectors.test.ts` (the published vectors).

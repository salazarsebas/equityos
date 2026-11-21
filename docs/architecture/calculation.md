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

`constituents` come from `computeConstituents` plus the decimals recorded for each token in the asset list.
`holdings` carry the decimals the token reports. `status` is the staleness class of the market data layer:
`live`, `delayed`, `last_close` or `unavailable`.

The quote asset is USDC. **Stated assumption:** one whole unit of the quote asset is valued at exactly 1 USD,
so one quote base unit is worth exactly 100 units of USD scaled by 1e8. The assumption is carried in every
valuation as `quotePriceE8`. The quote asset has no reference price input, so a depeg is not visible to this
calculation.

## Definitions

| Term              | Definition                                                                          |
| ----------------- | ----------------------------------------------------------------------------------- |
| Position value    | `floor(balance * priceE8 / 10^decimals)` of one constituent                         |
| Invested value    | Sum of the position values of the constituents                                      |
| Quote value       | `quoteBalance * 100`, exact                                                         |
| Deployable value  | Invested value plus quote value. In a plan, also the deposit and the tokens to exit |
| Current weight    | Share of a constituent in the invested value, in bps. The weights sum to 10,000     |
| Uninvested share  | `floor(quoteValue * 10000 / deployableValue)`: cash to deploy, in bps               |
| Outside the index | A token the wallet holds that is not a constituent. Reported, never counted         |
| Target weight     | `weightBps` of the constituent in the published version                             |
| Drift             | `currentWeightBps - targetWeightBps`, signed: positive above target                 |
| Maximum drift     | Largest absolute drift of a constituent                                             |
| Turnover          | Half the sum of the absolute drifts                                                 |
| Target value      | `floor(deployableValue * targetWeightBps / 10000)` of one constituent               |
| Delta             | Target value minus position value: positive to buy, negative to sell                |
| Leg               | One swap between a token and the quote asset                                        |
| Reserve           | Share of the available funds that buys leave unspent, `reserveBps`                  |
| Minimum leg value | Reference value below which a leg is not proposed, `minLegValueUsdE8`               |

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
price is usable when its status is `live`, `delayed` or `last_close` and it is above zero. When a blocker
concerns any constituent (see [Blockers and warnings](#blockers-and-warnings)), that position has no value, and
the invested value, the deployable value and every weight are `null`. The values of the other positions are
still returned.

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
| 1     | The balance of every constituent is zero         | Due: `first_replication`                                |
| 2     | Drift is `null`                                  | Not due: `drift_unavailable`                            |
| 3     | `maxAbsDriftBps < driftThresholdBps`             | Not due: `below_threshold`, with both numbers           |
| 4     | `lastRebalanceAt + minIntervalSeconds - now > 0` | Not due: `min_interval_not_elapsed`, `secondsRemaining` |
| 5     | Otherwise                                        | Due: `drift_threshold_reached`                          |

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
| `reserveBps`       | `50`        | Share of the available funds that buys leave unspent, 0 to 10000  |
| `minLegValueUsdE8` | `100000000` | Reference value below which a leg is skipped (1.00 USD)           |
| `blockOnLastClose` | `false`     | Turns the warning of a `last_close` price into a blocker          |

Every leg goes through the quote asset. A sell is exact in token quantity: the plan states the quantity to sell
and the proceeds at the reference price. A buy is exact in quote amount: the plan states the amount of quote
asset to spend and the quantity it buys at the reference price. Both are the amounts a wallet controls, so no
later step has to round them.

### Steps

1. **Available quote**: `quoteBalance + floor(depositUsdE8 / 100)` quote base units.
2. **Tokens to exit** (`rebalance` mode): every token of `exitTokens` that the wallet holds with a balance above
   zero. Its value is `floor(balance * priceE8 / 10^decimals)`.
3. **Deployable value**: invested value, plus `availableQuote * 100`, plus the values of the tokens to exit.
4. **Target value** of each constituent: `floor(deployable * targetWeightBps / 10000)`.
5. **Sells** (`rebalance` mode), in ascending token order. A constituent above its target sells
   `floor((value - target) * 10^decimals / priceE8)` base units. A token to exit sells its whole balance. The
   leg value is `floor(quantity * priceE8 / 10^decimals)` and its proceeds are `floor(value / 100)` quote base
   units.
6. **Buy budget**: `floor((availableQuote + proceeds of the proposed sells) * (10000 - reserveBps) / 10000)`.
7. **Buys**, in ascending token order. A constituent below its target wants `floor((target - value) / 100)`
   quote base units. When the sum wanted exceeds the budget, each buy is `floor(wanted * budget / sumWanted)`;
   otherwise it is the amount wanted. The leg value is `quoteAmount * 100` and the token quantity is
   `floor(value * 10^decimals / priceE8)`.
8. **Minimum**: a leg whose value is below `minLegValueUsdE8` is skipped as `below_minimum`. A remaining leg
   whose token quantity or quote amount is zero is skipped as `zero_quantity`. A leg worth exactly the minimum
   is proposed.
9. **Projection**: every proposed leg applied at its reference price. Balances, values, weights and drift of the
   constituents are computed as in a valuation, and the quote asset left is
   `availableQuote + proceeds - amounts spent`.

`legs` is the execution order: every sell, then every buy. Sells come first because they fund the buys.

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
| Scaled buy amount       | Down                         | The buys never sum to more than the budget                     |
| Buy token quantity      | Down                         | The plan never expects more tokens than the amount spent buys  |

### Reserve

The buys can spend at most the buy budget: the quote available plus the proceeds of the proposed sells, less
`reserveBps` of that sum. The reserve stays in the quote asset and appears in the projected quote balance.

The default is 50 bps. The reference feeds publish a new value when the price deviates by 0.5%, so a reference
price can trail the market by up to 50 bps while still being current, and a buy sized on it can cost that much
more by the time it executes. The reserve is a buffer for that movement. It is not an estimate of slippage,
fees or gas. A caller that executes in a closed market or in thin liquidity passes a larger value.

When the budget is smaller than what the buys want, every buy is scaled by the same ratio, so each constituent
below target closes the same fraction of its shortfall. The alternative of filling the constituent with the
widest shortfall first concentrates the plan in fewer, larger legs and makes the result depend on which
constituent happens to be widest; the proportional rule has no ordering in it.

### Minimum leg value

Every leg is one swap with a cost that does not shrink with its size: a network fee, a signature, the minimum
price increment of a pool. Below some size a leg costs a material share of what it moves. A leg whose reference
value is below `minLegValueUsdE8` is therefore not proposed. It is listed in `skipped` with its value and the
reason, and it stays visible.

The default is 1.00 USD. A caller that knows the real cost of a swap passes its own value, and `0` disables the
rule.

- What a skipped sell would have raised is not in the buy budget.
- What a skipped buy would have spent stays in the quote asset. It is not redistributed to the other buys.
- The drift that remains is reported: `projected.positions[].driftBps` and `projected.maxAbsDriftBps`.

A small deposit into an index with many constituents can be skipped entirely: 20 USD into 64 equal-weighted
constituents is 64 buys of about 0.31 USD, all below 1.00 USD. The plan then has no leg and 64 skipped entries.

### Buy only

In `buy_only` mode the plan has no sell. The targets are computed from the deployable value, the constituents
below target share the quote available as in step 7, and the constituents above target are left as they are.
It moves toward the target with the fewest legs. It does not reach the target when a constituent is above its
target value, and the projection states the drift that remains. `exitTokens`
is ignored in this mode: the tokens are not sold and their value is not deployable.

### Tokens to exit

A plan only ever trades constituents of the target version, with one exception. When a newer version removes a
constituent, the caller passes the tokens of the previous version that are no longer constituents as
`exitTokens`. In `rebalance` mode each one the wallet holds is sold in full (`exit: true` on the leg) and its
proceeds fund buys. A token to exit that the wallet holds needs a usable price; one the wallet does not hold
needs none.

Any other token outside the index is never sold and never counted. Listing a constituent of the target version
as a token to exit is an input error.

### Projection

`projected` is the wallet after every proposed leg at reference prices: balance, value, weight and drift of
each constituent, the invested value, the quote asset left and the maximum drift. `currentMaxAbsDriftBps` is
the maximum drift before. When the projected invested value is zero, the projected weights and drifts are
`null`.

## Blockers and warnings

Data-quality problems are returned as data. `planRebalance` returns `blockers`, `warnings`, the valuation and
the plan; the plan is `null` exactly when there is a blocker. `valuePortfolio` returns the same findings in
`issues`, each with its severity.

| Code                       | Severity | Condition                                                                |
| -------------------------- | -------- | ------------------------------------------------------------------------ |
| `missing_price`            | Blocker  | No price for a constituent, or for a held token to exit                  |
| `price_unavailable`        | Blocker  | The price has status `unavailable`                                       |
| `zero_price`               | Blocker  | The price is zero                                                        |
| `decimals_mismatch`        | Blocker  | A holding reports other decimals than the constituent it is matched with |
| `zero_deployable_value`    | Blocker  | The deployable value of the plan is zero: there is nothing to deploy     |
| `market_closed`            | Warning  | The price has status `last_close`. A blocker with `blockOnLastClose`     |
| `price_delayed`            | Warning  | The price has status `delayed`                                           |
| `projected_drift_increase` | Warning  | The projected maximum drift is above the current one                     |

Each finding names its token, or `null` when it concerns the whole portfolio. `market_closed` means the market
is closed and execution prices will differ from the reference price.

Inputs that no correct caller produces throw a `CalculationInputError` with a code: `invalid_address`,
`duplicate_token`, `negative_amount`, `invalid_decimals`, `invalid_weights`, `invalid_bps`, `invalid_time`,
`exit_token_is_constituent`.

## Guarantees

These hold for every input that produces a plan. They are checked by property tests over 4,000 seeded random
portfolios. `unit(t)` is the value of one base unit of token `t` rounded up, `ceil(priceE8 / 10^decimals)`.

- **Funds**: the quote amounts of the buys sum to at most the buy budget, which is at most the quote available
  plus the proceeds of the sells. The projected quote balance is never negative and is at least the reserve.
- **Balances**: a sell never exceeds the balance held.
- **No empty leg**: every leg has a token quantity and a quote amount above zero and a value of at least the
  minimum.
- **Conservation**: the projected total (invested value plus quote value) is never above the total before
  (invested value, quote available and tokens sold to exit). It is below it by at most 100 per sell plus
  `unit(t)` per buy, in USD scaled by 1e8.
- **Direction**: the projected value of every constituent lies between its current value and its target value,
  both included. No leg moves a constituent away from its target or past it.
- **Weights**: current and projected weights each sum to exactly 10,000 when the invested value is above zero.
- **Order**: the output does not depend on the order of constituents, holdings, prices or tokens to exit.
- **Buy only**: a `buy_only` plan has no sell.

### Maximum drift

In `rebalance` mode with `reserveBps` 0 and `minLegValueUsdE8` 0, every projected drift is within

```
boundBps = ceil(10000 * (n + 1) * E / projectedInvestedValue) + 1
E        = sum of unit(t) over the constituents + 100 * (n + exits + 2) + 1
```

where `n` is the number of constituents and `exits` the number of tokens to exit. `E` is the largest distance
of a projected value from its exact target: one base unit of every token, one quote base unit per rounding
step, and one value unit for the rounded target. The last `+ 1` is the rounding of a weight to whole basis
points. For a portfolio that is large against the granularity of its tokens the bound is 2 bps, and the
projected maximum drift never exceeds the larger of the current maximum drift and the bound.

With a reserve, a minimum leg value or `buy_only`, the plan is partial, and a partial plan does not always
lower the maximum drift. Drift is measured against the invested value, and a plan changes that value: a sell
whose proceeds are held back shrinks it, which raises the weight of every constituent that was not sold. The
plan does not hide this. It reports the maximum drift before and after, and adds the warning
`projected_drift_increase` whenever the projected one is higher. The guarantee that holds without exception is
the one on values above: every constituent ends at least as close to its target value as it started.

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
- **Market hours.** It only sees the staleness class of each price. With a `last_close` price the market is
  closed and executable prices differ from the reference by an amount the plan cannot bound; that is the
  `market_closed` warning and the reason for `blockOnLastClose`.

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

**Sell.** A is 100.00 USD above target: `floor(10000000000 * 10^8 / 125000000000) = 8000000` base units
(0.08 A), worth `10000000000`, proceeds `100000000` quote base units (100 USDC).

**Budget.** `floor(100000000 * 9950 / 10000) = 99500000` (99.50 USDC).

**Buy.** B wants `floor(10000000000 / 100) = 100000000`, more than the budget, so it is scaled:
`floor(100000000 * 99500000 / 100000000) = 99500000`. Its value is `9950000000` and it buys
`floor(9950000000 * 10^18 / 50000000) = 199000000000000000000` base units (199 B).

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
| `vectors[].expected` | The exact result: `blockers`, `warnings`, `valuation`, `plan`                       |

Every balance, price, value and quote amount is a decimal string, because these integers can exceed 2^53. Basis
points, decimals and booleans are JSON numbers and booleans. A value that is not defined is `null`.

The vectors cover both modes, the defaults, each blocker and warning, skipped legs, a token to exit, tokens of
0, 6, 8 and 18 decimals, prices from 0.07 USD to 4,321.00 USD, an index of one constituent and one of 64, and
portfolios from 5 USD to 10 million USD.

## Tests

`packages/core/test`: `portfolio.test.ts` (valuation, weights, findings, drift), `rebalance.test.ts`
(eligibility, worked examples with hand-computed numbers, one group per rule), `rebalance-properties.test.ts`
(the guarantees above over seeded random portfolios) and `plan-vectors.test.ts` (the published vectors).

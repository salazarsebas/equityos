# Portfolio API

Two read-only endpoints compare the holdings of any address on Base mainnet with one published version of an
index. Nothing is stored: there is no account and no saved replication. Every answer is computed on request from
three inputs, the published version, the balances of the address and the reference prices, with the calculation
`equityos.calc/1` of `@equityos/core` ([specification](../architecture/calculation.md)).

Conventions (envelope, errors, amounts as decimal strings, caching, versioning) are in the [overview](./README.md).
Both endpoints were added in API version 1.2.0.

## Where each input is read

| Input                     | Read from                                                        | Reported in     |
| ------------------------- | ---------------------------------------------------------------- | --------------- |
| Index version and weights | The index registry of the configured chain (`EQUITYOS_CHAIN_ID`) | `meta.registry` |
| Balances                  | Base mainnet: `balanceOf` of USDC and every listed token         | `meta.balances` |
| Reference prices          | Base mainnet: the reference feeds of the market data layer       | `meta.datasets` |

The registry and the market data can be on different chains: a local or test registry publishes the Base mainnet
addresses of the tokens, which are valued on Base mainnet. `meta.registry.chainId` and `meta.balances.chainId`
state both. The balance read and the price read are two blocks, each one given.

## Parameters

| Query parameter    | Endpoint | Values                                        | Default     |
| ------------------ | -------- | --------------------------------------------- | ----------- |
| `address`          | both     | `0x` and 40 hex digits, any letter case       | required    |
| `index`            | both     | An index identifier or index id               | required    |
| `version`          | both     | 1 to the latest version                       | latest      |
| `mode`             | plan     | `rebalance` or `buy_only`                     | required    |
| `depositUsdE8`     | plan     | 0 to `100000000000000000` (1,000,000,000 USD) | `0`         |
| `reserveBps`       | plan     | 0 to 2000                                     | `50`        |
| `minLegValueUsdE8` | plan     | 0 to `100000000000000` (1,000,000 USD)        | `100000000` |

`depositUsdE8` and `minLegValueUsdE8` are integers in decimal digits, USD scaled by 1e8: `12.5` USD is
`1250000000`. A value with a decimal point is refused. Tokens that left the index in a later version are not
passed to the plan as tokens to exit: no token outside the compared version is ever sold.

## Errors

| Status | `code`                   | When                                                                   |
| ------ | ------------------------ | ---------------------------------------------------------------------- |
| 400    | `invalid_parameter`      | A parameter is missing, unknown, repeated or out of its bounds         |
| 400    | `invalid_address`        | `address` is not `0x` followed by 40 hex digits                        |
| 400    | `invalid_identifier`     | `index` is neither an index id nor a slug with an index id prefix      |
| 404    | `index_not_found`        | No index has this identifier                                           |
| 404    | `version_not_found`      | The index has no version with this number                              |
| 409    | `registry_not_deployed`  | The registry has no code on the configured chain                       |
| 409    | `version_not_conformant` | The version fails verification, so it has no target weights to compare |
| 409    | `ineligible_token`       | A constituent is not in the asset list, so it has no decimals or price |
| 502    | `upstream_malformed`     | The balance of USDC or of a constituent could not be decoded           |
| 503    | `upstream_unavailable`   | Base mainnet did not answer. The balance read is never served stale    |

A missing or unusable reference price is not an error: the valuation reports it as a blocker (see below).

## GET /api/v1/portfolio

```sh
curl "http://localhost:3000/api/v1/portfolio?address=0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266&index=diversified-equity-d622e2a5"
```

The response below was produced by the test replay: the recorded Base mainnet block of
`apps/web/test/fixtures/market`, the recorded local registry and the constructed balances of
`test/fixtures/market/balances.json` (`meta.balances.mode` is `replay`). One constituent, one holding outside the
index and one finding are shown; the other entries have the same shape.

```
HTTP/1.1 200 OK
cache-control: public, max-age=15
content-type: application/json; charset=utf-8
x-equityos-api-version: 1.2.0
```

```json
{
  "data": {
    "address": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    "index": {
      "indexId": "0xd622e2a5c14a9c3da33be82cea76e20adeaf4a26ca46413ee21307d2c850d610",
      "identifier": "diversified-equity-d622e2a5",
      "name": "Diversified Equity",
      "version": 2,
      "latestVersion": 2,
      "isLatest": true,
      "specHash": "0x90d5104e4313a341690a14046df6da168cd3c1924f5ceca79cdc8b3b51fe74f6",
      "driftThresholdBps": 500,
      "minIntervalSeconds": 604800
    },
    "constituents": [
      {
        "token": "0xb20000000000000000000078ee7ce2fe4908108c",
        "symbol": "NVDAc",
        "name": "NVIDIA Corporation",
        "decimals": 8,
        "balance": "2464860328",
        "targetWeightBps": 2500,
        "currentWeightBps": 4000,
        "driftBps": 1500,
        "valueUsdE8": "319999999948",
        "referencePrice": {
          "status": "last_close",
          "priceE8": "12982480034",
          "updatedAt": "2026-11-20T23:42:40Z",
          "roundId": "36893488147419104856",
          "unavailableReason": null,
          "lastObserved": null,
          "feedProxy": "0x04689a41629776563e6822f76f2e57d148d28513"
        }
      }
    ],
    "totals": {
      "investedValueUsdE8": "799999999461",
      "quoteBalance": "250500000",
      "quoteValueUsdE8": "25050000000",
      "quotePriceE8": "100000000",
      "deployableValueUsdE8": "825049999461",
      "cashShareBps": 303
    },
    "drift": {
      "maxAbsDriftBps": 1500,
      "maxDriftToken": "0xb20000000000000000000078ee7ce2fe4908108c",
      "turnoverBps": 1500,
      "driftThresholdBps": 500,
      "thresholdReached": true
    },
    "outsideIndex": [
      {
        "token": "0xb2000000000000000000008bc8786b856e61707c",
        "symbol": "METAc",
        "name": "Meta Platforms Inc.",
        "decimals": 8,
        "balance": "300000000",
        "valueUsdE8": "170153376066",
        "referencePrice": {
          "status": "last_close",
          "priceE8": "56717792022",
          "updatedAt": "2026-11-20T21:15:17Z",
          "roundId": "36893488147419104702",
          "unavailableReason": null,
          "lastObserved": null,
          "feedProxy": "0x6526ae6797a76123638b863aee4dd27ba4e4b27d"
        }
      }
    ],
    "issues": [
      {
        "code": "market_closed",
        "severity": "warning",
        "token": "0xb2000000000000000000001e800a7f5189430cd0",
        "minimumDeployableValueUsdE8": null,
        "uninvestedQuote": null,
        "currentMaxAbsDriftBps": null,
        "projectedMaxAbsDriftBps": null
      }
    ]
  },
  "meta": {
    "asOf": "2026-11-21T19:10:55Z",
    "marketPhase": "closed",
    "referencePriceSource": "chainlink",
    "datasets": {
      "assetList": {
        "source": "coinbase_api",
        "fetchedAt": "2026-11-21T19:10:55Z",
        "ageSeconds": 0,
        "servedStale": false,
        "failure": null
      },
      "onchain": {
        "source": "base_rpc",
        "fetchedAt": "2026-11-21T19:10:55Z",
        "ageSeconds": 0,
        "servedStale": false,
        "failure": null,
        "blockNumber": "60489401",
        "blockTimestamp": "2026-11-21T19:10:55Z"
      }
    },
    "registry": {
      "chainId": 31337,
      "address": "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c",
      "mode": "replay"
    },
    "balances": {
      "chainId": 8453,
      "blockNumber": "60489401",
      "blockTimestamp": "2026-11-21T19:10:55Z",
      "mode": "replay"
    }
  }
}
```

- `constituents` lists every constituent of the version, held or not, in ascending token order. A constituent
  the address does not hold has `balance` `"0"`.
- `currentWeightBps` is the share of the invested value: constituents only, without USDC. It is `null` when a
  constituent has no usable price or when nothing is invested. `driftBps` is `currentWeightBps` minus
  `targetWeightBps`.
- `totals.investedValueUsdE8` is `null` when any constituent has no usable price. A partial total is never
  returned as the total: the blocker in `issues` names the token.
- `drift` is `null` when the weights are not defined. `thresholdReached` is `maxAbsDriftBps >= driftThresholdBps`
  of the spec.
- `outsideIndex` lists index-eligible tokens the address holds that are not constituents. They take no part in
  any total, weight or drift, and no plan sells them.
- `issues` are the findings of the valuation, as in the calculation specification: `missing_price`,
  `price_unavailable`, `zero_price` and `decimals_mismatch` are blockers; `market_closed` and `price_delayed`
  are warnings.

## GET /api/v1/portfolio/plan

```sh
curl "http://localhost:3000/api/v1/portfolio/plan?address=0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266&index=diversified-equity-d622e2a5&mode=rebalance"
```

The plan is arithmetic toward the published target weights at reference prices. **It contains no executable
quote, no slippage and no gas, and it is not an instruction to trade.** Every response says so in fixed fields:
`priceBasis` is `"reference"`, `executable` is `false` and `statement` carries that sentence. The same plan
quoted and checked for execution is [`POST /portfolio/execution-plan`](./execution.md); no endpoint executes a
trade.

`data` of the replayed example, with one warning, two legs and one projected position shown:

```json
{
  "address": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "index": {
    "indexId": "0xd622e2a5c14a9c3da33be82cea76e20adeaf4a26ca46413ee21307d2c850d610",
    "identifier": "diversified-equity-d622e2a5",
    "name": "Diversified Equity",
    "version": 2,
    "latestVersion": 2,
    "isLatest": true,
    "specHash": "0x90d5104e4313a341690a14046df6da168cd3c1924f5ceca79cdc8b3b51fe74f6",
    "driftThresholdBps": 500,
    "minIntervalSeconds": 604800
  },
  "priceBasis": "reference",
  "executable": false,
  "statement": "Arithmetic toward the published target weights at reference prices. It contains no executable quote, no slippage and no gas, and it is not an instruction to trade.",
  "mode": "rebalance",
  "depositUsdE8": "0",
  "reserveBps": 50,
  "minLegValueUsdE8": "100000000",
  "plan": {
    "status": "ready",
    "warnings": [
      {
        "code": "market_closed",
        "severity": "warning",
        "token": "0xb2000000000000000000001e800a7f5189430cd0",
        "minimumDeployableValueUsdE8": null,
        "uninvestedQuote": null,
        "currentMaxAbsDriftBps": null,
        "projectedMaxAbsDriftBps": null
      }
    ],
    "legs": [
      {
        "side": "sell",
        "token": "0xb20000000000000000000078ee7ce2fe4908108c",
        "symbol": "NVDAc",
        "decimals": 8,
        "exit": false,
        "tokenQuantity": "876084531",
        "quoteAmount": "1137374993",
        "valueUsdE8": "113737499318",
        "priceE8": "12982480034"
      },
      {
        "side": "buy",
        "token": "0xb2000000000000000000001e800a7f5189430cd0",
        "symbol": "TSLAc",
        "decimals": 8,
        "exit": false,
        "tokenQuantity": "131348801",
        "quoteAmount": "460311874",
        "valueUsdE8": "46031187400",
        "priceE8": "35045000000"
      }
    ],
    "skipped": [],
    "candidate": "uncapped",
    "otherCandidateMaxAbsDriftBps": null,
    "currentMaxAbsDriftBps": 1500,
    "availableQuote": "250500000",
    "buyBudgetQuote": "1380935618",
    "deployableValueUsdE8": "825049999461",
    "projected": {
      "positions": [
        {
          "token": "0xb20000000000000000000078ee7ce2fe4908108c",
          "symbol": "NVDAc",
          "balance": "1588775797",
          "valueUsdE8": "206262500630",
          "targetWeightBps": 2500,
          "weightBps": 2502,
          "driftBps": 2
        }
      ],
      "investedValueUsdE8": "824356061617",
      "quoteBalance": "6939376",
      "maxAbsDriftBps": 2
    }
  }
}
```

`plan.status` is `ready` or `blocked`. A blocked plan has `blockers` and `warnings` and no `legs` property. A
deposit of 2.00 USD into the empty constructed wallet in `buy_only` mode is blocked, because a first replication
that cannot buy every constituent is not proposed. The blocker carries the deployable value from which every
constituent gets a buy, here `1005033970`, a little over 10.05 USD:

```json
{
  "status": "blocked",
  "blockers": [
    {
      "code": "below_minimum_portfolio_value",
      "severity": "blocker",
      "token": null,
      "minimumDeployableValueUsdE8": "1005033970",
      "uninvestedQuote": null,
      "currentMaxAbsDriftBps": null,
      "projectedMaxAbsDriftBps": null
    }
  ],
  "warnings": [
    {
      "code": "market_closed",
      "severity": "warning",
      "token": "0xb2000000000000000000001e800a7f5189430cd0",
      "minimumDeployableValueUsdE8": null,
      "uninvestedQuote": null,
      "currentMaxAbsDriftBps": null,
      "projectedMaxAbsDriftBps": null
    }
  ]
}
```

| Field                      | Meaning                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `legs`                     | Sells in ascending token order, then buys. Quantities and amounts at reference price |
| `skipped`                  | Legs computed and not proposed, with the reason                                      |
| `currentMaxAbsDriftBps`    | Maximum drift before the plan. `null` when nothing is invested                       |
| `projected.maxAbsDriftBps` | Maximum drift after every leg at its reference price                                 |
| `projected.quoteBalance`   | USDC left: the reserve and whatever the buys did not spend                           |
| `candidate`                | Which of the two candidates of the calculation was chosen                            |

Warnings of a ready plan include `uninvested_quote` (with `uninvestedQuote` in USDC base units),
`projected_drift_increase` (with both maxima) and `nothing_to_do`. The rules behind each one are in the
[calculation specification](../architecture/calculation.md#blockers-and-warnings).

## Caching

Both endpoints answer `public, max-age=N`, where `N` is what is left of the shorter of the onchain read and the
balance read, at most 15 seconds. The URL carries the address and the server keeps one balance entry per address,
so a cached answer is only ever the answer for that address. When the market data is served stale the answer is
`no-store`.

## The page

`/portfolio` is the page built on these endpoints. See [Portfolio and drift](../product/portfolio.md).

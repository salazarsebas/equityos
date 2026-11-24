# Execution plan API

`POST /api/v1/portfolio/execution-plan` turns the reference-price plan of
[`GET /api/v1/portfolio/plan`](./portfolio.md) into an executable plan for Base mainnet: a quote for each leg, the
calls a wallet would make, and the result of every pre-trade check. It was added in API version 1.3.0.

**Nothing is signed or sent.** The answer is data: calls to show, and to send later through the user's wallet.
The design and every check are described in [Executable plan and pre-trade checks](../architecture/execution.md),
and what is trusted of the quote provider in [Aggregator calldata](../security/aggregator-calldata.md).
Conventions (envelope, errors, amounts as decimal strings, versioning) are in the [overview](./README.md).

## Request

`POST` with a JSON body and `Content-Type: application/json`. It is a POST because the answer depends on the
caller and expires within two minutes: it is never cached. The body is at most 4096 bytes, and an unknown field is
an error.

| Field              | Type    | Values                                                     | Default     |
| ------------------ | ------- | ---------------------------------------------------------- | ----------- |
| `address`          | string  | `0x` and 40 hex digits, any letter case                    | required    |
| `index`            | string  | An index identifier or index id                            | required    |
| `version`          | integer | 1 to the latest version                                    | latest      |
| `mode`             | string  | `rebalance` or `buy_only`                                  | required    |
| `reserveBps`       | integer | 0 to 2000                                                  | `50`        |
| `minLegValueUsdE8` | string  | Decimal digits, 0 to `100000000000000`                     | `100000000` |
| `slippageBps`      | integer | 0 to 200                                                   | `50`        |
| `maxDeviationBps`  | integer | 0 to 500, applied to the quoted and the minimum-out prices | `150`       |
| `allowUnsimulated` | boolean | Accept calls whose sequence could not be simulated         | `false`     |

There is no deposit: execution spends what the address holds on Base mainnet.

```sh
curl -X POST "http://localhost:3000/api/v1/portfolio/execution-plan" \
  -H "Content-Type: application/json" \
  -d '{"address":"0x9696f59e4d72e237be84ffd425dcad154bf96976","index":"diversified-equity-d622e2a5","mode":"buy_only"}'
```

## Rate limits and deadline

Each server instance applies these limits with in-process token buckets. Several instances each apply their own,
so a deployment should also limit the route in front of the app.

| Limit             | Value                                                                                 | Answer                                           |
| ----------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Per address       | 3 plans at once, then one every 20 seconds, keyed by `x-real-ip` or `x-forwarded-for` | 429 `rate_limited`, `Retry-After`                |
| Provider requests | 10 at once, refilled at one per second; a plan takes two per leg before quoting       | 503 `provider_rate_limited`, `Retry-After`       |
| Provider 429      | Never retried or waited on                                                            | 503 `provider_rate_limited`, the provider's wait |
| Deadline          | 20 seconds per request; pending provider requests are aborted                         | 503 `deadline_exceeded`, `Retry-After: 15`       |

A plan has at most 5 legs, so that it fits in the provider's limit of 10 requests per 10 seconds. Two legs are
quoted at a time.

## Errors

| Status | `code`                   | When                                                                           |
| ------ | ------------------------ | ------------------------------------------------------------------------------ |
| 400    | `invalid_body`           | Not `application/json`, not UTF-8 JSON, not an object, or over 4096 bytes      |
| 400    | `invalid_parameter`      | A field is unknown, missing or out of its bounds. `details.parameter` names it |
| 400    | `invalid_address`        | `address` is not `0x` followed by 40 hex digits                                |
| 404    | `index_not_found`        | No index has this identifier                                                   |
| 404    | `version_not_found`      | The index has no version with this number                                      |
| 409    | `registry_not_deployed`  | The registry has no code on the configured chain                               |
| 409    | `version_not_conformant` | The version fails verification                                                 |
| 409    | `ineligible_token`       | A constituent is not in the asset list                                         |
| 409    | `execution_unavailable`  | The server serves replayed market data (`details.reason: market_data_replay`)  |
| 429    | `rate_limited`           | Too many plans from one address                                                |
| 502    | `upstream_malformed`     | A balance could not be decoded                                                 |
| 503    | `upstream_unavailable`   | Base mainnet did not answer the balance read or the pre-trade read             |
| 503    | `provider_rate_limited`  | The provider's limit or the instance budget does not allow quoting now         |
| 503    | `deadline_exceeded`      | The plan was not built within 20 seconds                                       |

A restricted request, a closed market, a failed quote, a paused token or a failed simulation is not an error: the
answer is `200` with `status: "blocked"` and the checks that block.

## Response

`data.status` is `ready` or `blocked`.

| Field              | Meaning                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `executable`       | `true` only when every check passed or warned. `false` for a blocked plan, and for a ready plan that was accepted unsimulated |
| `priceBasis`       | Always `"executable_quote"`                                                                                                   |
| `statement`        | A fixed sentence on what the plan is and is not                                                                               |
| `expiresAt`        | 120 seconds after the first quote, or the earliest route deadline when sooner. Nothing may be sent after it                   |
| `checkedAtBlock`   | The Base mainnet block of the pre-trade read and of the simulation                                                            |
| `simulationMethod` | `eth_simulateV1` (the sequence) or `eth_call` (calls alone), `null` when nothing was simulated                                |
| `legs`             | The legs of the reference plan, each with its quote, or `null` when it has none                                               |
| `checks`           | Every check that ran, in order: `check`, `status`, `reason`, `token`, `leg`, `detail`                                         |
| `blockedBy`        | The checks that block. Empty when `ready`                                                                                     |
| `warnings`         | Every check that passed with a warning. A client shows each one and asks the user to acknowledge it                           |
| `approvals`        | Per token sold: current allowance toward the router, the exact amount, and whether it is required                             |
| `calls`            | `ready` only: approvals, then sells, then buys. `to`, `data` and `value` are what a wallet sends                              |
| `totals`           | `ready` only: USDC held, minimum USDC from sells, USDC the buys spend, balances after at minimum outs                         |
| `planHash`         | `ready` only: keccak256 of `abi.encode("equityos.execution-plan/1", 8453, address, expiresAt, (to, value, data)[])`           |

In a leg, `amountIn` is exact, `quotedAmountOut` is the provider's quote and is not guaranteed, `minAmountOut`
is decoded from the calldata and enforced by the router, `deadline` is decoded from the route and enforced onchain,
`deviationBps` is the quoted price against the reference and `minimumDeviationBps` the minimum-out price against it,
both signed and rounded away from zero. `referenceAmountOut` is what the same amount buys or returns at the
reference price.

### What a client that sends the calls must do

The next step of the product sends these calls. A client that sends them:

1. verifies every swap again in the browser with the same module the server uses,
   `apps/web/src/lib/execution/calldata.ts` (`verifyQuote`, pure and browser-safe), and every approval for its
   exact amount and spender;
2. recomputes `planHash` from exactly the calls it is about to send and `expiresAt`, and sends nothing when it
   differs from the hash it showed;
3. refuses to send after `expiresAt`, measured by chain time (the latest block), not by the device clock;
4. shows every entry of `warnings` and asks for an acknowledgement of each.

## Example

Produced by the endpoint on 2026-11-24 against Base mainnet and the live KyberSwap API, for an address that held
USDC, with the recorded local registry of the tests (`meta.registry.mode` is `replay`). The plan buys the five
constituents; one leg is shown, with its checks, one warning, the approval and its swap; calldata is shortened
after 74 characters. The market was in its overnight session, so four references were `delayed` and warned.
The complete response is `packages/sdk/test/fixtures/execution-plan.json`.

```
HTTP/1.1 200 OK
cache-control: no-store
content-type: application/json; charset=utf-8
x-equityos-api-version: 1.3.0
```

```json
{
  "data": {
    "address": "0x9696f59e4d72e237be84ffd425dcad154bf96976",
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
    "chainId": 8453,
    "priceBasis": "executable_quote",
    "statement": "Executable quotes from a third-party aggregator, checked against reference prices and the chain at one block. Each swap returns at least its minimum amount out or reverts; more than the minimum is not guaranteed. The plan must be quoted again after expiresAt, and it is not an instruction to trade.",
    "mode": "buy_only",
    "reserveBps": 50,
    "minLegValueUsdE8": "100000000",
    "slippageBps": 50,
    "maxDeviationBps": 150,
    "allowUnsimulated": false,
    "provider": {
      "name": "kyberswap",
      "router": "0x6131b5fae19ea4f9d964eac0408e4408b66337b5"
    },
    "status": "ready",
    "executable": true,
    "expiresAt": "2026-11-24T07:21:57Z",
    "checkedAtBlock": {
      "number": "61572114",
      "timestamp": "2026-11-24T07:19:58Z"
    },
    "simulationMethod": "eth_simulateV1",
    "legs": [
      {
        "side": "buy",
        "token": "0xb20000000000000000000078ee7ce2fe4908108c",
        "symbol": "NVDAc",
        "decimals": 8,
        "tokenIn": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "tokenOut": "0xb20000000000000000000078ee7ce2fe4908108c",
        "amountIn": "183909739",
        "referencePriceE8": "16374374608",
        "referenceStatus": "live",
        "referenceAmountOut": "112315580",
        "quote": {
          "provider": "kyberswap",
          "router": "0x6131b5fae19ea4f9d964eac0408e4408b66337b5",
          "functionName": "swap",
          "quotedAmountOut": "112528617",
          "minAmountOut": "111965973",
          "deviationBps": -19,
          "minimumDeviationBps": 32,
          "deadline": "2026-11-24T07:21:57Z",
          "gasEstimate": "925081",
          "quotedAt": "2026-11-24T07:19:58Z",
          "routeId": "c9399a171RJExpLg"
        }
      }
    ],
    "checks": [
      {
        "check": "jurisdiction",
        "status": "pass",
        "reason": "permitted_country",
        "token": null,
        "leg": null,
        "detail": "DE"
      },
      {
        "check": "reference_plan",
        "status": "pass",
        "reason": "ready",
        "token": null,
        "leg": null,
        "detail": null
      },
      {
        "check": "reference_freshness",
        "status": "pass",
        "reason": "live",
        "token": "0xb20000000000000000000078ee7ce2fe4908108c",
        "leg": 2,
        "detail": null
      },
      {
        "check": "quote",
        "status": "pass",
        "reason": "verified",
        "token": "0xb20000000000000000000078ee7ce2fe4908108c",
        "leg": 2,
        "detail": "c9399a171RJExpLg"
      },
      {
        "check": "price_deviation",
        "status": "pass",
        "reason": "within_band",
        "token": "0xb20000000000000000000078ee7ce2fe4908108c",
        "leg": 2,
        "detail": "-19/32"
      },
      {
        "check": "transfers_not_paused",
        "status": "pass",
        "reason": "not_paused",
        "token": "0xb20000000000000000000078ee7ce2fe4908108c",
        "leg": null,
        "detail": null
      },
      {
        "check": "policy_authorized",
        "status": "pass",
        "reason": "authorized",
        "token": "0xb20000000000000000000078ee7ce2fe4908108c",
        "leg": null,
        "detail": null
      },
      {
        "check": "multiplier_window",
        "status": "pass",
        "reason": "none_pending",
        "token": "0xb20000000000000000000078ee7ce2fe4908108c",
        "leg": null,
        "detail": null
      },
      {
        "check": "allowance",
        "status": "pass",
        "reason": "within_plan",
        "token": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "leg": null,
        "detail": "0"
      },
      {
        "check": "balance",
        "status": "pass",
        "reason": "sufficient",
        "token": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "leg": null,
        "detail": "735638949/739335637"
      },
      {
        "check": "simulation",
        "status": "pass",
        "reason": "sequence_simulated",
        "token": null,
        "leg": null,
        "detail": null
      },
      {
        "check": "plan_expiry",
        "status": "pass",
        "reason": "current",
        "token": null,
        "leg": null,
        "detail": "1795504917"
      }
    ],
    "blockedBy": [],
    "warnings": [
      {
        "check": "reference_freshness",
        "status": "warn",
        "reason": "delayed",
        "token": "0xb2000000000000000000001e800a7f5189430cd0",
        "leg": 0,
        "detail": null
      }
    ],
    "approvals": [
      {
        "token": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "spender": "0x6131b5fae19ea4f9d964eac0408e4408b66337b5",
        "currentAllowance": "0",
        "amount": "735638949",
        "required": true
      }
    ],
    "calls": [
      {
        "kind": "approve",
        "to": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "data": "0x095ea7b30000000000000000000000006131b5fae19ea4f9d964eac0408e4408b66337b5...",
        "value": "0",
        "token": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "leg": null,
        "minAmountOut": null
      },
      {
        "kind": "swap",
        "to": "0x6131b5fae19ea4f9d964eac0408e4408b66337b5",
        "data": "0xe21fd0e90000000000000000000000000000000000000000000000000000000000000020...",
        "value": "0",
        "token": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "leg": 2,
        "minAmountOut": "111965973"
      }
    ],
    "totals": {
      "usdcBalance": "739335637",
      "minUsdcFromSells": "0",
      "maxUsdcForBuys": "735638949",
      "endBalances": [
        {
          "token": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          "before": "739335637",
          "after": "3696688"
        },
        {
          "token": "0xb20000000000000000000078ee7ce2fe4908108c",
          "before": "0",
          "after": "111965973"
        }
      ]
    },
    "planHash": "0x9996eed2d36c99858bb540b4e13d56a5f70da2cd7cd3a5543b51eac66f5a74b8"
  },
  "meta": {
    "asOf": "2026-11-24T07:19:57Z",
    "marketPhase": "extended",
    "referencePriceSource": "chainlink",
    "datasets": {
      "assetList": {
        "source": "coinbase_api",
        "fetchedAt": "2026-11-24T07:19:55Z",
        "ageSeconds": 2,
        "servedStale": false,
        "failure": null
      },
      "onchain": {
        "source": "base_rpc",
        "fetchedAt": "2026-11-24T07:19:55Z",
        "ageSeconds": 2,
        "servedStale": false,
        "failure": null,
        "blockNumber": "61572104",
        "blockTimestamp": "2026-11-24T07:19:56Z"
      }
    },
    "registry": {
      "chainId": 31337,
      "address": "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c",
      "mode": "replay"
    },
    "balances": {
      "chainId": 8453,
      "blockNumber": "61572109",
      "blockTimestamp": "2026-11-24T07:19:57Z",
      "mode": "live"
    }
  }
}
```

A request located in the United States is answered with the jurisdiction check alone:

```json
{
  "check": "jurisdiction",
  "status": "block",
  "reason": "restricted_country",
  "token": null,
  "leg": null,
  "detail": null
}
```

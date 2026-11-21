# Assets API

The tokenized stock universe: every token of the issuer's list, with its onchain state, its index eligibility and
its reference price. The conventions (envelope, errors, amounts, caching, versioning) are in the
[API overview](./README.md). The meaning of each value, the staleness classes and the eligibility rules are in
the [market data layer](../architecture/market-data.md).

The responses below were recorded on 2026-11-21 from a local server reading Base mainnet, between blocks 60566221
and 60567330. It was a Saturday: the US market was closed and every reference price was the value the feed held
since Friday. Long lists are cut where marked.

## The asset object

| Field                              | Type                   | Meaning                                                                 |
| ---------------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| `address`                          | address                | Token address on Base mainnet. The identifier of the asset              |
| `symbol`, `name`                   | string                 | Display data from the issuer's list. Mutable: never a key               |
| `decimals`                         | integer                | Decimals as listed by the issuer                                        |
| `isin`                             | string or null         | ISIN as listed by the issuer                                            |
| `onchain.status`                   | string                 | `ok`, `not_initialized` or `read_failed`. The rest is null unless `ok`  |
| `onchain.decimals`                 | integer or null        | Decimals the token reports onchain                                      |
| `onchain.totalSupply`              | integer string or null | Minted supply in base units of `onchain.decimals`                       |
| `onchain.multiplierWad`            | integer string or null | Shares of the underlying stock per token, scaled by 1e18                |
| `onchain.pendingMultiplier`        | object or null         | `{ multiplierWad, effectiveAt }` of a recorded update not yet in effect |
| `onchain.transfersPaused`          | boolean or null        | Whether the issuer paused transfers                                     |
| `eligibility.eligible`             | boolean                | Whether the asset may be a constituent of an index                      |
| `eligibility.reasons`              | array of strings       | Every failed condition. Empty when eligible                             |
| `referencePrice.status`            | string                 | `live`, `delayed`, `last_close` or `unavailable`                        |
| `referencePrice.priceE8`           | integer string or null | USD per whole token, scaled by 1e8                                      |
| `referencePrice.updatedAt`         | timestamp or null      | Time the feed published the round                                       |
| `referencePrice.roundId`           | integer string or null | Feed round the price comes from                                         |
| `referencePrice.unavailableReason` | string or null         | Set exactly when `status` is `unavailable`                              |
| `referencePrice.lastObserved`      | object or null         | `{ priceE8, updatedAt, roundId }` of a feed that missed its heartbeat   |
| `referencePrice.feedProxy`         | address or null        | Feed proxy mapped to the token                                          |

- `eligibility.reasons` values: `not_listed`, `onchain_read_failed`, `not_initialized`, `decimals_mismatch`,
  `not_minted`, `missing_feed`, `feed_mismatch`.
- `referencePrice.unavailableReason` values: `not_eligible` (only eligible assets get a reference price),
  `feed_read_failed`, `feed_mismatch`, `invalid_round`, `stale_feed`.
- `priceE8` is the price of one token and already includes the share multiplier. Never multiply or divide it by
  `multiplierWad`. In the example below one SNDKc token represents 8 shares and is priced at 649.44 USD.
- `lastObserved` is for display with its age. It is not a price to calculate with.

`meta` of both asset endpoints:

| Field                  | Meaning                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `asOf`                 | Time the staleness classes were computed for                                                 |
| `marketPhase`          | `regular`, `extended`, `closed`, or `unknown` outside the covered calendar. One per response |
| `referencePriceSource` | `chainlink`                                                                                  |
| `datasets.assetList`   | Source `coinbase_api`: `fetchedAt`, `ageSeconds`, `servedStale`, `failure`                   |
| `datasets.onchain`     | Source `base_rpc`: the same fields plus `blockNumber` and `blockTimestamp`                   |
| `count`, `total`       | List endpoint only: assets returned, and listed assets before filtering                      |

Every token state and feed round of a response belongs to the one block in `datasets.onchain`.

## GET /api/v1/assets

Every listed asset, ordered by symbol and then by address.

| Query parameter | Values          | Effect                                                      |
| --------------- | --------------- | ----------------------------------------------------------- |
| `eligible`      | `true`, `false` | Only index-eligible assets, or only the others. Absent: all |

The list is not paginated. The full universe was 415 assets on the day of the recording: 215 kB of JSON, 18 kB
compressed. A single response keeps every asset on the same block, which pages fetched one after another could
not guarantee.

```sh
curl "http://localhost:3000/api/v1/assets?eligible=true"
```

```
HTTP/1.1 200 OK
access-control-allow-origin: *
cache-control: public, max-age=14
content-type: application/json; charset=utf-8
x-equityos-api-version: 1.0.0
```

```json
{
  "data": [
    {
      "address": "0xb200000000000000000000c2e324d24d7eecd1fb",
      "symbol": "AAPLc",
      "name": "Apple Inc.",
      "decimals": 8,
      "isin": "US0378331005",
      "onchain": {
        "status": "ok",
        "decimals": 8,
        "totalSupply": "610312108319",
        "multiplierWad": "1000500389301980219",
        "pendingMultiplier": null,
        "transfersPaused": false
      },
      "eligibility": { "eligible": true, "reasons": [] },
      "referencePrice": {
        "status": "last_close",
        "priceE8": "34529769685",
        "updatedAt": "2026-11-20T23:12:02Z",
        "roundId": "36893488147419103834",
        "unavailableReason": null,
        "lastObserved": null,
        "feedProxy": "0x787f13dea48db0897cbcdd985de77809d837f988"
      }
    }
  ],
  "meta": {
    "asOf": "2026-11-21T23:27:00Z",
    "marketPhase": "closed",
    "referencePriceSource": "chainlink",
    "datasets": {
      "assetList": {
        "source": "coinbase_api",
        "fetchedAt": "2026-11-21T23:26:59Z",
        "ageSeconds": 1,
        "servedStale": false,
        "failure": null
      },
      "onchain": {
        "source": "base_rpc",
        "fetchedAt": "2026-11-21T23:26:59Z",
        "ageSeconds": 1,
        "servedStale": false,
        "failure": null,
        "blockNumber": "60566221",
        "blockTimestamp": "2026-11-21T23:26:59Z"
      }
    },
    "count": 13,
    "total": 415
  }
}
```

`data` is cut to its first element. It held 13 assets.

An asset that is not eligible has no reference price, and says why. From `GET /api/v1/assets?eligible=false`,
one element of `data`:

```json
{
  "address": "0xb2000000000000000000004feb8d277dd14b08bb",
  "symbol": "AALc",
  "name": "American Airlines Group Inc.",
  "decimals": 8,
  "isin": "US02376R1023",
  "onchain": {
    "status": "ok",
    "decimals": 8,
    "totalSupply": "0",
    "multiplierWad": "1000000000000000000",
    "pendingMultiplier": null,
    "transfersPaused": false
  },
  "eligibility": { "eligible": false, "reasons": ["not_minted", "missing_feed"] },
  "referencePrice": {
    "status": "unavailable",
    "priceE8": null,
    "updatedAt": null,
    "roundId": null,
    "unavailableReason": "not_eligible",
    "lastObserved": null,
    "feedProxy": null
  }
}
```

A misspelled parameter is rejected with 400:

```sh
curl "http://localhost:3000/api/v1/assets?eligble=true"
```

```json
{
  "error": {
    "code": "invalid_parameter",
    "message": "Unknown query parameter \"eligble\".",
    "details": { "parameter": "eligble", "accepted": ["eligible"] }
  }
}
```

## GET /api/v1/assets/{address}

One listed asset. The address is accepted in any letter case and looked up in lowercase. A checksum is not
required and is not verified.

```sh
curl "http://localhost:3000/api/v1/assets/0xB200000000000000000000397293CB8cda9a10c5"
```

```json
{
  "data": {
    "address": "0xb200000000000000000000397293cb8cda9a10c5",
    "symbol": "SNDKc",
    "name": "Sandisk Corporation",
    "decimals": 8,
    "isin": "US80004C2008",
    "onchain": {
      "status": "ok",
      "decimals": 8,
      "totalSupply": "333003853669",
      "multiplierWad": "8000000000000000000",
      "pendingMultiplier": null,
      "transfersPaused": false
    },
    "eligibility": { "eligible": true, "reasons": [] },
    "referencePrice": {
      "status": "last_close",
      "priceE8": "64944000000",
      "updatedAt": "2026-11-20T23:38:55Z",
      "roundId": "36893488147419108543",
      "unavailableReason": null,
      "lastObserved": null,
      "feedProxy": "0x388b0dc46c0fb05a74bee0994fa5b02c6fcca2ea"
    }
  },
  "meta": {
    "asOf": "2026-11-21T23:30:42Z",
    "marketPhase": "closed",
    "referencePriceSource": "chainlink",
    "datasets": {
      "assetList": {
        "source": "coinbase_api",
        "fetchedAt": "2026-11-21T23:30:41Z",
        "ageSeconds": 1,
        "servedStale": false,
        "failure": null
      },
      "onchain": {
        "source": "base_rpc",
        "fetchedAt": "2026-11-21T23:30:41Z",
        "ageSeconds": 1,
        "servedStale": false,
        "failure": null,
        "blockNumber": "60567330",
        "blockTimestamp": "2026-11-21T23:30:41Z"
      }
    }
  }
}
```

An address that is not a 20-byte hex string answers 400, and one that no listed asset has answers 404:

```sh
curl "http://localhost:3000/api/v1/assets/0x1234"
curl "http://localhost:3000/api/v1/assets/0x0000000000000000000000000000000000000001"
```

```json
{"error":{"code":"invalid_address","message":"The address is not a 0x-prefixed 20-byte hex string.","details":{"parameter":"address"}}}
{"error":{"code":"asset_not_found","message":"No listed asset has this token address.","details":{"address":"0x0000000000000000000000000000000000000001"}}}
```

## GET /api/v1/status

What the API is, what it reads and how current each dataset is. It answers 200 when a data source is down and
reports the failure in `marketData.error`, so it can be used to tell an API problem from a source problem. It
names sources by identifier and never returns an endpoint URL.

| Field                        | Meaning                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| `apiVersion`                 | Version of the API contract                                             |
| `chainId`                    | `8453`, Base mainnet                                                    |
| `marketPhase`                | Phase of the US equity market now                                       |
| `executionAvailable`         | Always `false` in this version                                          |
| `executionUnavailableReason` | `restricted_jurisdiction`, `jurisdiction_unknown` or `not_released`     |
| `marketData.mode`            | `live`, or `replay` when the server serves a recorded block for testing |
| `marketData.available`       | Whether the market data could be loaded                                 |
| `marketData.datasets`        | The two datasets as in the asset `meta`, or `null` when unavailable     |
| `marketData.error`           | `{ code, details }` of the failure, or `null`                           |

The execution fields are explained under
[Execution availability and the jurisdiction gate](./README.md#execution-availability-and-the-jurisdiction-gate).

A local server receives no geolocation header, so this request sets the one the hosting platform would set:

```sh
curl -H "x-vercel-ip-country: US" "http://localhost:3000/api/v1/status"
```

```json
{
  "data": {
    "apiVersion": "1.0.0",
    "chainId": 8453,
    "marketPhase": "closed",
    "executionAvailable": false,
    "executionUnavailableReason": "restricted_jurisdiction",
    "marketData": {
      "mode": "live",
      "available": true,
      "referencePriceSource": "chainlink",
      "datasets": {
        "assetList": {
          "source": "coinbase_api",
          "fetchedAt": "2026-11-21T23:30:41Z",
          "ageSeconds": 1,
          "servedStale": false,
          "failure": null
        },
        "onchain": {
          "source": "base_rpc",
          "fetchedAt": "2026-11-21T23:30:41Z",
          "ageSeconds": 1,
          "servedStale": false,
          "failure": null,
          "blockNumber": "60567330",
          "blockTimestamp": "2026-11-21T23:30:41Z"
        }
      },
      "error": null
    }
  },
  "meta": { "asOf": "2026-11-21T23:30:42Z" }
}
```

The same request with `x-vercel-ip-country: DE` answered `"executionUnavailableReason": "not_released"`.

## GET /api/v1/openapi.json

The OpenAPI 3.1 document of the deployment. It is served as is, without the envelope.

```sh
curl "http://localhost:3000/api/v1/openapi.json"
```

## The assets page

`/assets` in the web app renders the same snapshot as a table. It calls the market data layer directly, not this
API. The "JSON" link in the table caption is the API request that returns the rows on screen.

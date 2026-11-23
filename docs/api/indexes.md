# Indexes API

The published indexes of the [index registry](../architecture/index-registry.md): the list, one index with its
versions, one version with its verification report, and the composition of a version joined with the asset
universe. The conventions (envelope, errors, amounts, versioning) are in the [API overview](./README.md). How the
registry is read and how identifiers work is in the [registry reader](../architecture/registry-reader.md). What
each verification check means for a reader is in [Index profile](../product/index-profile.md).

The responses below were recorded on 2026-11-22 from a local server reading a local Anvil chain (chain id 31337)
after the deployment script and the seed of [Local chain](../development/local-chain.md), with reference prices
read from Base mainnet at block 60741739. The indexes are the examples of the seed. They exist on no public
network. Long values and lists are cut where marked.

## The registry may not be deployed

**The registry is not deployed on Base mainnet or Base Sepolia.** A server configured for one of those chains
answers every endpoint of this page with 409 and the code `registry_not_deployed`:

```sh
curl -i "http://localhost:3000/api/v1/indexes"
```

```
HTTP/1.1 409 Conflict
cache-control: no-store
```

```json
{
  "error": {
    "code": "registry_not_deployed",
    "message": "The index registry is not deployed on the configured chain.",
    "details": {
      "chainId": 8453,
      "registry": "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c",
      "reason": "not_configured"
    }
  }
}
```

- `reason` is `not_configured` when no deployment is recorded for the chain, and `no_code` when a deployment is
  recorded and the address holds no code.
- This is a normal state of the service, not a failure. It is answered as 409 for these reasons:
  - Not 200. A client that reads `data` and ignores the rest would see a list without indexes, which is a
    different statement: "the registry holds no index". A deployed registry without indexes answers 200 with
    `"data": []` and `"total": 0`.
  - Not 404. That status says one identifier is unknown in a registry that exists.
  - Not 5xx. Nothing failed, retrying does not help, and a monitor should not alarm.
  - 409 is what this API already uses for "the request is valid and the current state does not allow an answer".
- `GET /api/v1/status` reports the same fact without an error, in `data.registry`, so a client can check first:

```json
{
  "chainId": 8453,
  "address": "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c",
  "mode": "live",
  "deployed": false,
  "notDeployedReason": "not_configured",
  "indexCount": null,
  "error": null
}
```

`mode` is `replay` when the server serves a recording of a development chain for testing. `deployed` is `null`
when the chain endpoint could not be read, and `error` then carries the code.

## Identifiers

`{identifier}` is either of:

- The canonical identifier: the slug of the latest verified version, a hyphen, and a prefix of the index id, for
  example `diversified-equity-d622e2a5`. It changes if the creator publishes a version with another slug.
- The index id: `0x` and 64 hexadecimal digits, in any letter case. It never changes.

While the latest version of an index fails verification its canonical identifier is its index id, because an
unverified spec provides no slug to trust.

| Status | `code`                   | When                                                                     |
| ------ | ------------------------ | ------------------------------------------------------------------------ |
| 400    | `invalid_identifier`     | The identifier is neither an index id nor a slug with an index id prefix |
| 400    | `invalid_parameter`      | A version is not an integer from 1 to 4294967295, or a query is invalid  |
| 404    | `index_not_found`        | No index has this id, or the slug is not the one of the index            |
| 404    | `version_not_found`      | The index exists and has no version with this number                     |
| 409    | `registry_not_deployed`  | See above                                                                |
| 409    | `version_not_conformant` | A composition was asked of a version that fails verification             |
| 502    | `upstream_malformed`     | The chain answered with something the registry cannot have stored        |
| 503    | `upstream_unavailable`   | The chain endpoint did not answer. `details.source` is `registry_rpc`    |

`meta.registry` of every response says which registry was read: `chainId`, `address` and `mode`.

## GET /api/v1/indexes

A page of indexes in creation order, each with a summary of its latest version.

| Query parameter | Values   | Effect                                           |
| --------------- | -------- | ------------------------------------------------ |
| `offset`        | 0 and up | Position of the first index to return. Default 0 |
| `limit`         | 1 to 50  | Maximum number of indexes to return. Default 20  |

Pagination is by position, not by an opaque cursor. The registry is append-only and an index keeps its position
forever, so an offset already is a stable cursor: a page never shifts, repeats or skips an index while new ones
are created. `meta.nextOffset` is the offset of the next page, or `null` on the last one. The newest indexes are
at the end: `offset = total - limit` returns them.

```sh
curl "http://localhost:3000/api/v1/indexes?offset=3&limit=2"
```

```
HTTP/1.1 200 OK
access-control-allow-origin: *
cache-control: public, max-age=10
content-type: application/json; charset=utf-8
x-equityos-api-version: 1.1.0
```

```json
{
  "data": [
    {
      "indexId": "0xa3e409e2ba1d9818a1b8fe0630a2920b2e24be1f1acce585e22e0866ef0b2704",
      "identifier": "semiconductors-fixed-a3e409e2",
      "position": 3,
      "creator": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      "createdAt": "2026-11-16T14:00:05Z",
      "latestVersion": 1,
      "deprecated": false,
      "deprecatedAt": null,
      "latest": {
        "version": 1,
        "name": "Semiconductors Fixed Weight",
        "slug": "semiconductors-fixed",
        "weighting": "fixed",
        "composition": "static",
        "constituentCount": 3,
        "specHash": "0x5e69dc77d1869847dfcbe389524a6448e03daa4efea571bd064de5ea8999ccf8",
        "publishedAt": "2026-11-16T14:00:05Z",
        "publishedBlock": "7",
        "verification": { "conformant": true, "failedCheck": null }
      }
    }
  ],
  "meta": {
    "asOf": "2026-11-22T04:48:57Z",
    "registry": {
      "chainId": 31337,
      "address": "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c",
      "mode": "live"
    },
    "total": 5,
    "offset": 3,
    "limit": 2,
    "count": 2,
    "nextOffset": null
  }
}
```

`data` is cut to its first element. It held 2 indexes.

An index whose latest version fails verification is listed, with its state and nothing taken from its spec. The
first index of the seed publishes weights that differ from its own methodology. Its entry, from
`GET /api/v1/indexes?limit=1`, `data[0].latest`:

```json
{
  "version": 1,
  "name": null,
  "slug": null,
  "weighting": null,
  "composition": "static",
  "constituentCount": 2,
  "specHash": "0xf0d73df88cb1dee88d5a454bb5527c878c9369366dce566eddf3ffaf9079c40f",
  "publishedAt": "2026-11-16T14:00:05Z",
  "publishedBlock": "3",
  "verification": { "conformant": false, "failedCheck": { "id": "C5", "code": "weight_mismatch" } }
}
```

| Field                              | Meaning                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `position`                         | Position in creation order. It never changes                                   |
| `deprecated`, `deprecatedAt`       | Whether and when the creator deprecated the index. It is one-way               |
| `latest.name`, `slug`, `weighting` | From the spec. `null` unless the version passes every check                    |
| `latest.composition`               | `static`, `dynamic_weights` or `rule_based`: what the registry mirrors onchain |
| `latest.constituentCount`          | Number of constituents the registry stores for the version                     |
| `latest.verification`              | `conformant`, and the first failed check with its code when it is not          |

## GET /api/v1/indexes/{identifier}

One index: the fields of the list, plus `versions`, the most recent versions, newest first. At most 50 are
returned. `latestVersion` says how many exist, and every version is reachable through the next endpoint.

```sh
curl "http://localhost:3000/api/v1/indexes/diversified-equity-d622e2a5"
```

`data.versions` of the response:

```json
[
  {
    "version": 2,
    "publishedAt": "2026-11-16T14:00:05Z",
    "publishedBlock": "9",
    "specHash": "0x90d5104e4313a341690a14046df6da168cd3c1924f5ceca79cdc8b3b51fe74f6",
    "conformant": true
  },
  {
    "version": 1,
    "publishedAt": "2026-11-16T14:00:05Z",
    "publishedBlock": "8",
    "specHash": "0xe64cf7b3200cae7821979cad14798da5796817439c6a5dd96f1f52946cc87b03",
    "conformant": true
  }
]
```

```sh
curl "http://localhost:3000/api/v1/indexes/another-name-d622e2a5"
curl "http://localhost:3000/api/v1/indexes/not%20an%20id"
```

```json
{"error":{"code":"index_not_found","message":"The registry holds no index with this identifier.","details":null}}
{"error":{"code":"invalid_identifier","message":"The identifier is neither a 32-byte index id nor a slug followed by an index id prefix.","details":{"parameter":"identifier"}}}
```

## GET /api/v1/indexes/{identifier}/versions/{version}

Everything the registry stores for one version, and the report of checks C1 to C5 on it.

```sh
curl "http://localhost:3000/api/v1/indexes/0xd622e2a5c14a9c3da33be82cea76e20adeaf4a26ca46413ee21307d2c850d610/versions/2"
```

```json
{
  "data": {
    "indexId": "0xd622e2a5c14a9c3da33be82cea76e20adeaf4a26ca46413ee21307d2c850d610",
    "identifier": "diversified-equity-d622e2a5",
    "version": 2,
    "latestVersion": 2,
    "isLatest": true,
    "creator": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    "chainId": 31337,
    "registry": "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c",
    "specHash": "0x90d5104e4313a341690a14046df6da168cd3c1924f5ceca79cdc8b3b51fe74f6",
    "publishedAt": "2026-11-16T14:00:05Z",
    "publishedBlock": "9",
    "composition": "static",
    "specSize": 969,
    "specBytes": "0x7b2263616c63223a226571756974796f732e63...",
    "specText": "{\"calc\":\"equityos.calc/1\",\"chainId\":31337,\"constraints\":{\"ma...",
    "spec": {
      "schema": "equityos.index/1",
      "calc": "equityos.calc/1",
      "chainId": 31337,
      "name": "Diversified Equity",
      "slug": "diversified-equity",
      "description": "Five companies from different industries at fixed weights. Version 2 adds a fifth company.",
      "universe": { "type": "static", "tokens": ["0xb2000000000000000000001e800a7f5189430cd0"] },
      "weighting": { "type": "fixed", "weightsBps": [2500, 1000, 2500, 2500, 1500] },
      "constraints": { "maxWeightBps": 2500 },
      "pricing": {
        "source": "chainlink-aggregator-v3",
        "feeds": ["0xfaf869185383a24f8cb00e27bda6b63b9905dcb4"]
      },
      "rebalance": { "trigger": "drift", "driftThresholdBps": 500, "minIntervalSeconds": 604800 }
    },
    "constituents": [
      { "token": "0xb2000000000000000000001e800a7f5189430cd0", "weightBps": 2500 },
      { "token": "0xb2000000000000000000004884b426556b92883d", "weightBps": 1000 }
    ],
    "verification": {
      "conformant": true,
      "checks": [
        {
          "id": "C1",
          "title": "The spec bytes hash to the published spec hash",
          "status": "pass",
          "code": "ok",
          "reason": "keccak256 of the 969 bytes is 0x90d5104e4313a341690a14046df6da168cd3c1924f5ceca79cdc8b3b51fe74f6"
        }
      ],
      "specErrors": []
    }
  },
  "meta": {
    "asOf": "2026-11-22T09:12:02Z",
    "registry": {
      "chainId": 31337,
      "address": "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c",
      "mode": "live"
    }
  }
}
```

Cut: `specBytes` and `specText` to their first characters, `tokens` and `feeds` to one of 5, `constituents` to 2
of 5, `checks` to 1 of 5.

| Field                     | Meaning                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `specHash`                | keccak256 of the spec bytes, computed by the registry at publication                     |
| `specBytes`               | The stored spec, byte for byte, as hexadecimal. `specSize` is its length in bytes        |
| `specText`                | The same bytes as text. `null` when they are not well-formed UTF-8                       |
| `spec`                    | The parsed spec. `null` unless the version passes every check                            |
| `constituents`            | What the registry stores: `token` and `weightBps`, in its order. Checked by C5           |
| `verification.checks`     | C1 to C5 in order: `id`, `title`, `status` (`pass`, `fail`, `skipped`), `code`, `reason` |
| `verification.specErrors` | Every schema violation found by C4: `path`, `code`, `message`                            |

- `spec` is the document as its author wrote it: optional properties (`constraints`, `parent`, a single bound)
  are absent, not `null`. Everything else in the response follows the rule that every key is present.
- `specText` and `constituents` are returned for a version that fails verification too. They are what the chain
  stores, not a methodology: do not compute from them. `spec` is the only field to compute from.
- A `skipped` check was not evaluated because an earlier one failed. It is never a success.
- Hashing `specBytes` with keccak256 gives `specHash`. [Index profile](../product/index-profile.md) shows how to
  check that against the chain without this API.

A version number that is not a positive integer answers 400. One the index does not have answers 404:

```sh
curl "http://localhost:3000/api/v1/indexes/diversified-equity-d622e2a5/versions/3"
```

```json
{ "error": { "code": "version_not_found", "message": "The index has no version with this number.", "details": null } }
```

## GET /api/v1/indexes/{identifier}/composition

The constituents of a verified version with their target weights, joined with the asset universe as it is now.

| Query parameter | Values           | Effect                                   |
| --------------- | ---------------- | ---------------------------------------- |
| `version`       | A version number | That version. Absent: the latest version |

```sh
curl "http://localhost:3000/api/v1/indexes/diversified-equity-d622e2a5/composition"
```

```json
{
  "data": {
    "indexId": "0xd622e2a5c14a9c3da33be82cea76e20adeaf4a26ca46413ee21307d2c850d610",
    "identifier": "diversified-equity-d622e2a5",
    "version": 2,
    "isLatest": true,
    "constituents": [
      {
        "token": "0xb2000000000000000000001e800a7f5189430cd0",
        "symbol": "TSLAc",
        "name": "Tesla Inc.",
        "targetWeightBps": 2500,
        "eligibility": { "eligible": true, "reasons": [] },
        "transfersPaused": false,
        "referencePrice": {
          "status": "last_close",
          "priceE8": "35045000000",
          "updatedAt": "2026-11-20T22:43:49Z",
          "roundId": "36893488147419104789",
          "unavailableReason": null,
          "lastObserved": null,
          "feedProxy": "0xfaf869185383a24f8cb00e27bda6b63b9905dcb4"
        }
      }
    ]
  },
  "meta": {
    "asOf": "2026-11-22T09:12:04Z",
    "marketPhase": "closed",
    "referencePriceSource": "chainlink",
    "datasets": {
      "assetList": {
        "source": "coinbase_api",
        "fetchedAt": "2026-11-22T09:12:02Z",
        "ageSeconds": 2,
        "servedStale": false,
        "failure": null
      },
      "onchain": {
        "source": "base_rpc",
        "fetchedAt": "2026-11-22T09:12:02Z",
        "ageSeconds": 2,
        "servedStale": false,
        "failure": null,
        "blockNumber": "60741739",
        "blockTimestamp": "2026-11-22T09:12:03Z"
      }
    },
    "registry": {
      "chainId": 31337,
      "address": "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c",
      "mode": "live"
    }
  }
}
```

`constituents` is cut to its first element. It held 5, in the order the registry stores them.

- `targetWeightBps` is the published weight in basis points. It is a rule, fixed at publication.
- `eligibility`, `transfersPaused` and `referencePrice` are the state of the token now, read from Base mainnet at
  the block in `meta.datasets.onchain`. They are the objects of the [Assets API](./assets.md). A token can stop
  being index-eligible after a version is published: it stays in the response with `eligible: false` and the
  reasons. A token the asset list does not hold has `symbol` and `name` `null` and the reason `not_listed`.
- A reference price is an indication of value, not an executable price. Nothing in the response is advice.
- The registry can be on another chain than the market data. A constituent is matched to an asset by its
  address alone.

A version that fails verification has no composition, because nothing may be computed from it:

```sh
curl "http://localhost:3000/api/v1/indexes/0x50f8aacd30bddc6f9e0fbca1501526b2ac01106e626678eab50a7867eb94d759/composition"
```

```json
{
  "error": {
    "code": "version_not_conformant",
    "message": "The version fails verification, so it has no composition.",
    "details": { "version": 1, "failedCheck": "C5", "code": "weight_mismatch" }
  }
}
```

## Caching

Responses built from the registry alone carry `Cache-Control: public, max-age=10`, the lifetime of the reader's
cache: a new index, a new version or a deprecation is visible within ten seconds. The composition follows the
market data, as the asset endpoints do. Errors are never stored.

## The pages

`/indexes` and `/indexes/{identifier}` in the web app render the same data. They call the registry reader and
the market data layer directly, not this API. The "JSON" link of each table is the API request that returns its
rows.

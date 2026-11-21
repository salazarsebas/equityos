# Public API

EquityOS serves a public, keyless, read-only HTTP API from the web app. This page states its conventions once.
The endpoints are described in:

- [Assets](./assets.md): the tokenized stock universe and the API status.
- The OpenAPI 3.1 document, served by every deployment at `/api/v1/openapi.json`.

The implementation lives in `apps/web/src/server/api` (envelope, errors, validation, OpenAPI document, handlers)
and `apps/web/src/app/api/v1` (one `route.ts` per path, each a single line that binds a handler to the market
data service). The data comes from the [market data layer](../architecture/market-data.md).

The API names the Coinbase tokenized stocks API, Base mainnet and Chainlink feeds as the sources of its data.
EquityOS is not affiliated with their operators. Nothing the API returns is investment advice.

## Base URL and access

```
https://<deployment>/api/v1
```

- No API key and no authentication. Every endpoint is a `GET`.
- CORS is open: every response carries `Access-Control-Allow-Origin: *`, and `OPTIONS` answers a preflight for
  `GET`.
- There is no rate limit in the application. A deployment may apply one in front of it.

## Envelope

A successful response is always an object with `data` and `meta`:

```json
{ "data": {}, "meta": { "asOf": "2026-11-21T23:30:42Z" } }
```

- `data` is the resource, or an array of resources.
- `meta` says what the data was built from: the time it describes (`asOf`), the market phase, the source of
  reference prices and, per cached dataset, when it was loaded and whether it is served past its TTL.

A failed response is always an object with `error`:

```json
{
  "error": {
    "code": "invalid_address",
    "message": "The address is not a 0x-prefixed 20-byte hex string.",
    "details": { "parameter": "address" }
  }
}
```

- `code` is stable. Branch on it.
- `message` is for a developer reading a log. It can change.
- `details` is an object with machine-readable context, or `null`.

Every key of a documented object is always present. A value that does not exist is `null`, next to a field that
says why. Nothing is replaced by zero, an empty string or the last known value.

## Errors

| Status | `code`                  | When                                                                         |
| ------ | ----------------------- | ---------------------------------------------------------------------------- |
| 400    | `invalid_parameter`     | A query parameter is unknown, given twice or has a value that is not allowed |
| 400    | `invalid_address`       | A path address is not `0x` followed by 40 hex digits                         |
| 404    | `asset_not_found`       | The address is well formed and no listed asset has it                        |
| 409    | `ineligible_token`      | A value was requested that an ineligible token does not have                 |
| 409    | `token_paused`          | The issuer paused transfers of the token                                     |
| 409    | `missing_feed`          | The token has no usable reference feed                                       |
| 409    | `stale_feed`            | The reference feed of the token missed its heartbeat                         |
| 500    | `service_misconfigured` | The server is not configured to read its data sources                        |
| 500    | `internal_error`        | Anything unexpected                                                          |
| 502    | `upstream_malformed`    | A data source answered with a payload of an unexpected shape                 |
| 503    | `upstream_unavailable`  | A data source did not answer and no recent copy of its data is cached        |

- An unknown query parameter is an error and is not ignored, so a misspelled filter cannot return unfiltered data.
- A 503 carries `Retry-After: 15`. A 502 and a 503 carry `details.source`: `coinbase_api` or `base_rpc`.
- A 500 never says what is misconfigured or what failed. The cause is written to the server log.
- The four 409 codes are the per-token conditions of the market data layer. No endpoint of this version returns
  them: the asset endpoints report these conditions as data. They are reserved for endpoints that need a value a
  token cannot provide.
- A source that is down does not immediately produce a 503. The last successful read is served for a bounded time
  with `servedStale: true` in `meta` (see [Caching](#caching)).

## Amounts, prices, time and addresses

No financial quantity is a JSON number. A JSON number is a double in most clients and cannot hold a token supply
or an 8-decimal price exactly.

| Kind                   | Representation                                                                | Example                  |
| ---------------------- | ----------------------------------------------------------------------------- | ------------------------ |
| Price                  | Integer in a decimal string. The scale is in the field name: `priceE8` is 1e8 | `"64944000000"`          |
| Ratio                  | Integer in a decimal string. `multiplierWad` is scaled by 1e18                | `"8000000000000000000"`  |
| Token amount           | Integer in a decimal string, in base units of the `decimals` given next to it | `"333003853669"`         |
| Block number, round id | Integer in a decimal string                                                   | `"60567330"`             |
| Count, decimals, age   | JSON integer. Always small                                                    | `8`                      |
| Time                   | ISO 8601, UTC, second precision                                               | `"2026-11-21T23:30:42Z"` |
| Address                | Lowercase hex. A path address is accepted in any letter case                  | `"0xb200...10c5"`        |

To read `priceE8` as dollars, divide by 10^8 with a decimal or big integer library: `"64944000000"` is 649.44 USD.
The serializer of the API throws on any number that is not a safe integer, so a float cannot be emitted by
mistake.

A reference price is an indication of value from an oracle feed. It is not an executable price: no trade is
guaranteed at it.

## Caching

`Cache-Control` states how long a response stays current at its source of truth.

| Response                                   | `Cache-Control`                                        |
| ------------------------------------------ | ------------------------------------------------------ |
| Assets, built from a fresh snapshot        | `public, max-age=N`: what is left of the 15 second TTL |
| Assets, built from a snapshot served stale | `no-store`                                             |
| Status                                     | `no-store`: it depends on where the request comes from |
| OpenAPI document                           | `public, max-age=3600`                                 |
| Any error                                  | `no-store`                                             |

The server reads the chain at most once every 15 seconds and the asset list at most once every 10 minutes. A
client that polls faster receives the same snapshot again, with a growing `ageSeconds`. The staleness class of a
reference price is computed for the time of each response.

## Versioning

- The major version is in the path. `/api/v1` will not remove or rename a field, change the type or the unit of
  a field, or change the meaning of an error code.
- Additive changes are made within `v1`: a new endpoint, a new field, a new value of an enumeration such as an
  error code or an ineligibility reason. Clients must ignore fields they do not know and must treat an unknown
  enumeration value as "unknown", not as a failure.
- Every response carries `X-EquityOS-Api-Version`, the version of the contract that produced it, which is also
  `info.version` of the OpenAPI document. Its minor part rises with each additive change. Current: `1.0.0`.
- A breaking change gets a new path prefix.

## The OpenAPI document is the contract

`apps/web/src/server/api/openapi.ts` holds the document as a typed object. Two tests in
`apps/web/test/api/openapi.test.ts` keep it true:

- The set of paths in the document must equal the set of `route.ts` files under `apps/web/src/app/api/v1`.
- Real responses of each handler, produced from the recorded fixtures (success, each error status, stale and
  unavailable data), must validate against the schema the document gives for that path and status. Every object
  schema is closed, so a field that is not documented fails the test.

To add an endpoint: write the handler, add its `route.ts`, add its path and schemas to the document, and add its
responses to the validation test.

## Execution availability and the jurisdiction gate

No endpoint executes or prepares a trade. `GET /api/v1/status` already reports `executionAvailable`, which is
`false` for every request in this version, with a reason:

| `executionUnavailableReason` | Meaning                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `restricted_jurisdiction`    | The request is located in the United States or one of its territories          |
| `jurisdiction_unknown`       | The location of the request could not be established                           |
| `not_released`               | The gate would let the request through. This version has no execution endpoint |

The gate is `classifyJurisdiction` in `apps/web/src/server/jurisdiction.ts`. It reads the country the hosting
platform reports in the `x-vercel-ip-country` header.

- `US`, `AS`, `GU`, `MP`, `PR`, `UM` and `VI` are restricted.
- When the header is absent in production the request is restricted, as `jurisdiction_unknown`. A deployment
  that does not receive the header cannot tell where a request comes from, and treating that as allowed would
  open the gate for everyone.
- When the header is absent outside production the request is not restricted. A local server never receives the
  header, and the features behind the gate could not be developed otherwise.
- A header that is not a two-letter code is `jurisdiction_unknown` in every environment.

The gate does not block any read endpoint and must not be used for that: public data stays public everywhere.
It will guard execution endpoints and the execution interface when they are added.

It is a coarse network signal and not a compliance control. It reflects the address a request arrives from,
which a VPN changes. It says nothing about the residence or the eligibility of a person. It can be forged when
the server is reachable without the platform proxy that sets the header. The issuer of a token enforces its own
transfer rules onchain, independently of this gate.

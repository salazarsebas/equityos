# Network API

`GET /api/v1/network` returns the [network metrics](../product/network-metrics.md): registry and usage figures
computed from chain events only, each with its definition id, chain, block range and computation time, the
thresholds of the usage tiers, the excluded accounts, the 50 most recent classified attestations and every
definition. The conventions (envelope, errors, amounts, versioning) are in the [API overview](./README.md).

The response below was recorded on 2026-11-24 from a local server replaying `apps/web/test/fixtures/registry`
(a local Anvil chain after the deployment script and `bun run seed:local`) with
`EQUITYOS_EXCLUDED_ACCOUNTS=0x5eed00000000000000000000000000000000000e=Local seed test account`. The tokens and
feeds of that chain are mocks that answer 100.00 USD. Lists and metrics are cut to a few entries.

```sh
curl "http://localhost:3000/api/v1/network"
```

```json
{
  "data": {
    "chainId": 31337,
    "registry": "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c",
    "rebalanceLog": "0x593449aef0efc05528d3bc7be9eb8d99e39aa41c",
    "scan": {
      "fromBlock": "0",
      "scannedToBlock": "29",
      "targetBlock": "29",
      "complete": true,
      "usageComplete": true
    },
    "thresholds": {
      "minimumNotionalUsdE8": "100000000",
      "tierBWindowSeconds": 900,
      "toleranceMarginBps": 200
    },
    "metrics": {
      "indexesPublished": {
        "id": "registry.indexes_published",
        "value": 5,
        "chainId": 31337,
        "fromBlock": "0",
        "toBlock": "29",
        "computedAt": "2026-11-24T07:21:49Z"
      },
      "attestationsTierA": {
        "id": "usage.attestations_tier_a",
        "value": 2,
        "chainId": 31337,
        "fromBlock": "0",
        "toBlock": "29",
        "computedAt": "2026-11-24T07:21:49Z"
      },
      "tierAReferenceValueUsdE8": {
        "id": "volume.tier_a_reference_value",
        "value": "130000000000",
        "chainId": 31337,
        "fromBlock": "0",
        "toBlock": "29",
        "computedAt": "2026-11-24T07:21:49Z"
      },
      "excludedActivity": {
        "id": "exclusions.activity",
        "value": {
          "indexes": 0,
          "versions": 0,
          "attestations": {
            "tierA": 1,
            "tierB": 0,
            "unmatched": 0
          }
        },
        "chainId": 31337,
        "fromBlock": "0",
        "toBlock": "29",
        "computedAt": "2026-11-24T07:21:49Z"
      }
    },
    "attestations": [
      {
        "transactionHash": "0x6a7ed891b509d234b1b4b27d4dc0a011df73b413c7aae7b6bc6a733b396dbe96",
        "blockNumber": "27",
        "blockTimestamp": "2026-11-16T14:00:05Z",
        "account": "0x5eed00000000000000000000000000000000000d",
        "indexId": "0xd622e2a5c14a9c3da33be82cea76e20adeaf4a26ca46413ee21307d2c850d610",
        "version": 2,
        "tier": "unmatched",
        "reason": "below_minimum_notional",
        "valueUsdE8": null,
        "linkedTransaction": null,
        "tracking": null,
        "excluded": false
      },
      {
        "transactionHash": "0x8f6107fa3603e291d69d42c09955601d8bf68979d8d9edffafcd1e16ae8ab022",
        "blockNumber": "26",
        "blockTimestamp": "2026-11-16T14:00:05Z",
        "account": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        "indexId": "0xa4abb1bd873da973f8f67b9afdc261adc490db29e8c2069c7cf9c01ff37a1492",
        "version": 1,
        "tier": "b",
        "reason": "no_constituent_flows",
        "valueUsdE8": "10000000000",
        "linkedTransaction": "0xba7049f7bed165a9bf2baa1cfc0b7b8f8f828b4b41738fb7d126d1e175e8070c",
        "tracking": null,
        "excluded": false
      }
    ],
    "exclusions": [
      {
        "address": "0x5eed00000000000000000000000000000000000e",
        "label": "Local seed test account"
      }
    ],
    "definitions": [
      {
        "id": "registry.indexes_published",
        "title": "Published indexes",
        "definition": "IndexCreated events. The registry writes version 1 in the same call, so every index has a published version. Activity of excluded accounts is not counted.",
        "source": "IndexRegistry logs"
      }
    ]
  },
  "meta": {
    "asOf": "2026-11-24T07:21:49Z",
    "registry": {
      "chainId": 31337,
      "address": "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c",
      "mode": "replay"
    }
  }
}
```

Since API version 1.5.0 `meta` also carries `mode`, the mode of the whole response: the registry's, here
`replay`. See [Data mode](./README.md#data-mode).

## Fields

| Field                     | Meaning                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `scan`                    | Blocks scanned (`fromBlock` to `scannedToBlock` of `targetBlock`) and whether usage is fully classified    |
| `thresholds`              | `minimumNotionalUsdE8` (1.00 USD), `tierBWindowSeconds` (900), `toleranceMarginBps` (200)                  |
| `metrics.<name>`          | `id`, `value`, `chainId`, `fromBlock`, `toBlock`, `computedAt`. `value` is a count, a list or a USD amount |
| `attestations[]`          | Newest first: transaction, block, account, index, version, `tier`, `reason`, `valueUsdE8`, `tracking`      |
| `attestations[].excluded` | Whether the account is excluded. Excluded rows count only in `metrics.excludedActivity`                    |
| `exclusions`              | The excluded accounts and their labels                                                                     |
| `definitions`             | `id`, `title`, `definition` and `source` of every metric                                                   |

- `tierAReferenceValueUsdE8` and `valueUsdE8` are USD scaled by 1e8, at reference prices. They are not traded
  value and not a price any trade executed at.
- `tracking` is `null` unless the tier is `a`. Its `status` is `within`, `outside` or `not_assessed` (with a
  `reason`: `not_static`, `not_verified` or `not_valued`).
- No query parameter is accepted.

## Errors

| Status | `code`                  | When                                                                 |
| ------ | ----------------------- | -------------------------------------------------------------------- |
| 400    | `invalid_parameter`     | Any query parameter                                                  |
| 409    | `registry_not_deployed` | The registry has no code on the configured chain, as for the indexes |
| 500    | `service_misconfigured` | The chain or `EQUITYOS_EXCLUDED_ACCOUNTS` is unusable                |
| 502    | `upstream_malformed`    | The chain returned something the registry cannot have stored         |
| 503    | `upstream_unavailable`  | The chain endpoint failed. Nothing older is served                   |

`Cache-Control` is `public, max-age=10` on success.

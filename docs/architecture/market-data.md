# Market data layer

The market data layer is the server-side, read-only source of every price and eligibility decision in EquityOS.
It lives in `apps/web/src/server/market` and is guarded by `import "server-only"`. Its pure parts (market
calendar, staleness classification, position value) live in `@equityos/core`, so that they can be reused and
tested without a network or a clock.

It never sends a transaction, never holds a key and never writes anywhere. It has no database: state is an
in-process cache.

## Sources

| Data                                                | Source                                                                  | How it is read                              |
| --------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| Which tokens exist: address, symbol, name, decimals | Coinbase tokenized stocks API, `GET /v1/tokenized-stocks`, public       | HTTPS, every page, strict parsing           |
| Token state: decimals, supply, multiplier, pause    | The B20 token precompile at the token address, Base mainnet             | `eth_call` through Multicall3, one block    |
| Whether an address is an initialized B20            | B20 factory precompile `0xB20f000000000000000000000000000000000000`     | `isB20Initialized(address)`, same multicall |
| Reference price                                     | Chainlink tokenized equity feed proxy mapped to the token, Base mainnet | `latestRoundData()`, same multicall         |

EquityOS is not affiliated with the operators of these sources. It reads their public interfaces.

The asset list says which tokens the issuer lists. Everything else about a token is read from the chain. The API
also reports supply, multiplier and a NAV price as JSON numbers. The layer validates their type and then drops
them, because the chain is authoritative for supply and multiplier, the feed is authoritative for price, and no
financial quantity may pass through a floating-point number.

Tokens are identified by lowercase address everywhere. Symbols and names are mutable onchain and are display
data only: nothing is keyed by symbol.

### Onchain functions

- Token (B20 asset interface): `decimals()`, `totalSupply()`, `multiplier()`, `newUIMultiplier()`,
  `effectiveAt()`, and `isPaused(uint8)` with feature `0` (`TRANSFER`).
- Factory: `isB20Initialized(address)`.
- Feed proxy (AggregatorV3Interface): `latestRoundData()`, `decimals()`, `description()`.
- Multicall3 at `0xcA11bde05977b3631167028862bE2a173976CA11`: `aggregate3` and `getChainId()`.

A read first fetches the latest block, then runs every call pinned to that block number, in requests of 500
calls. All values of a snapshot therefore belong to one block. The chain id is checked on every read, so an
endpoint that points to another chain is rejected.

### Configuration

`BASE_RPC_URL` is the Base mainnet JSON-RPC endpoint. In production it is required: without it the layer throws
`MissingConfigurationError`. Outside production it falls back to the public endpoint, which is rate limited and
not suitable for serving users. See `apps/web/.env.example`.

## What each number means

| Field               | Unit                               | Meaning                                                                 |
| ------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| `priceE8`           | USD per whole token, scaled by 1e8 | The feed answer, unchanged                                              |
| `updatedAt`         | Unix seconds                       | Time the feed published the round                                       |
| `roundId`           | Feed round identifier              | Identifies the exact round the price came from                          |
| `totalSupply`       | Token base units                   | Raw supply. Divide by 10^decimals for whole tokens                      |
| `multiplierWad`     | WAD, 1e18 is 1.0                   | Shares of the underlying stock that one token represents                |
| `pendingMultiplier` | WAD and Unix seconds               | A recorded multiplier update whose effective time is ahead of the block |
| `valueUsdE8`        | USD scaled by 1e8                  | Result of `positionValueUsdE8`: `balance * priceE8 / 10^decimals`       |

`positionValueUsdE8` in `@equityos/core` takes the rounding direction as a required argument. Round down when
the value is credited to the holder, up when it is an amount the holder must cover.

### The multiplier is not applied to the price

The feed publishes the price of one token: the market price of the underlying share multiplied by the token's
share multiplier. A token with multiplier 8 that tracks a share trading at 81.18 USD has a feed answer of
649.44 USD. `priceE8` is that answer. Applying the multiplier again would overstate the value eight times.
`multiplierWad` is exposed for display (how many shares a token represents) and for detecting corporate actions,
never for pricing. A test with a recorded multiplier-8 token fails if the multiplier is applied.

### Reference price, not executable price

A reference price is an indication of value. It comes from an oracle that aggregates equity market data. It is
not a quote: no trade is guaranteed at it, it does not reflect the liquidity of any onchain pool, and outside
US trading sessions it is a held value while onchain markets keep trading. The feeds also do not price issuer
risk such as insolvency or a halt in redemptions.

This layer provides reference prices only. It never provides an executable price, and a reference price must
never be shown or used as the price a trade will execute at.

## Staleness classes

The feeds follow the US equity 24/5 schedule. They publish when the price moves by 0.5% and at least once every
24 hours of trading time (the heartbeat), from Sunday 20:00 to Friday 20:00 Eastern Time. On weekends and market
holidays they hold their last value: `updatedAt` stops advancing while the contract keeps answering.

Every reference price carries a status, computed by the pure function `classifyStaleness` from the publication
time, the observation time and the market session.

| Status        | Meaning                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- |
| `live`        | Published at most 30 minutes ago, in an open session, with no closure since               |
| `delayed`     | Published earlier in the current run of trading time, within heartbeat plus grace         |
| `last_close`  | The value held since trading last stopped, or a value whose session cannot be established |
| `unavailable` | No usable value: the feed missed its heartbeat, or the round or its timestamp is invalid  |

Rules, in order:

1. A timestamp that is zero, not an integer, or more than 120 seconds ahead of the clock is `unavailable`.
2. If the market calendar does not cover the interval: `last_close` up to 4 days of age, `unavailable` beyond.
   Never `live` or `delayed`.
3. More than 24 hours 15 minutes of trading time since publication is `unavailable`. Trading time excludes
   weekends and holidays, so a Friday value is not stale on Sunday, and a feed that stays frozen through a full
   trading day is.
4. If the market is closed, or a closure lies between publication and now: `last_close`.
5. Otherwise `live` up to 30 minutes of age and `delayed` after.

| Constant                       | Value      | Reason                                                                             |
| ------------------------------ | ---------- | ---------------------------------------------------------------------------------- |
| `LIVE_MAX_AGE_SECONDS`         | 30 minutes | Feeds publish on deviation: sampled gaps had a median of 7 and a p90 of 38 minutes |
| `FEED_HEARTBEAT_SECONDS`       | 24 hours   | Heartbeat published for the feeds                                                  |
| `HEARTBEAT_GRACE_SECONDS`      | 15 minutes | Time for the heartbeat transaction to be included                                  |
| `CLOCK_SKEW_TOLERANCE_SECONDS` | 2 minutes  | A block timestamp may lead the server clock slightly                               |
| `UNCOVERED_MAX_AGE_SECONDS`    | 4 days     | A three-day weekend closure plus one heartbeat                                     |

`live` does not mean the value equals the current market price. A feed in a quiet market can be `delayed` for
hours and still be within 0.5% of its source. The status says how recent the publication is, nothing more.

A read served from cache after a failed refresh is never `live`: a newer round may exist that was not seen.

### Market calendar

`packages/core/src/market-calendar.ts` models the schedule:

- A trading day is a weekday that is not a full closure. Its window runs from 20:00 ET on the previous calendar
  day to 20:00 ET on the day, or to 17:00 ET on an early-close day.
- The regular session is 09:30 to 16:00 ET, or 09:30 to 13:00 ET on an early-close day. The rest of the window
  is the extended session.
- Full closures and early closes are a static table of the NYSE holidays for 2026 and 2027. Eastern Time is
  computed from the US daylight saving rule and tested against the IANA time zone database for every hour of
  both years.

The table covers 2026-01-01 to 2027-12-31. Outside it the phase is `unknown` and rule 2 applies. The table must
be extended before the end of 2027, and a test makes sure it is: `packages/core/test/market-calendar-coverage.test.ts`
reads the clock and, from October 1 of any year, fails unless the table covers the whole of the next year. With
the current table it starts failing on 2027-10-01, with a message that says what to add. Unscheduled halts and closures are not modelled: during one, a price shows
as `delayed` and then `unavailable` once the heartbeat is missed. Whether the overnight session runs on the
evening before a holiday is an assumption of the model, not a verified fact.

The calendar is a guard, not the trigger: `live` also requires a publication in the last 30 minutes, so an error
in the calendar can make a fresh price look older, not an old price look fresh.

## Eligibility

A token is index-eligible when all of these hold:

1. It is in the asset list.
2. The B20 factory reports it as initialized, and its onchain decimals equal the decimals in the list.
3. Its total supply is above zero.
4. It has a verified reference feed.

Each failed condition is reported as a typed code. A token can carry several.

| Code                  | Meaning                                                                            |
| --------------------- | ---------------------------------------------------------------------------------- |
| `not_listed`          | The address is not in the asset list                                               |
| `onchain_read_failed` | The token state could not be read, so nothing about it is established              |
| `not_initialized`     | The factory does not report an initialized B20 at the address                      |
| `decimals_mismatch`   | The chain and the asset list disagree on decimals                                  |
| `not_minted`          | Total supply is zero                                                               |
| `missing_feed`        | No verified reference feed is mapped to the token                                  |
| `feed_mismatch`       | The mapped proxy does not answer with the decimals and description recorded for it |

Eligibility fails closed. A paused token and a pending multiplier update do not change eligibility: they are
reported on the token state, and `requireTransferable` turns a pause into a typed error. Whether a specific
account is authorized to hold or transfer a token is not checked by this layer.

Only eligible tokens get a reference price.

### Feed map

`apps/web/src/server/market/feeds.ts` maps each feed-covered token address to its feed proxy and the exact
`description()` of that feed. An entry is added only after onchain confirmation: the proxy's `description()`
names the ticker, its `decimals()` is 8, the token's `symbol()` matches, and the feed answer equals the NAV price
the issuer API publishes for the token. The description and decimals are read again on every snapshot, so a
proxy that changes identity makes the token ineligible instead of mispricing it.

`apps/web/test/market/live.test.ts` repeats the whole verification against the live API and chain:

```sh
cd apps/web
LIVE_TESTS=1 bun test test/market/live.test.ts
```

It is skipped unless `LIVE_TESTS=1` and does not run in CI.

## Caching

| Data                        | TTL        | Served stale on failure for | Reason                                                 |
| --------------------------- | ---------- | --------------------------- | ------------------------------------------------------ |
| Asset list                  | 10 minutes | 24 more hours               | Listings change rarely; token state is re-read onchain |
| Token state and feed rounds | 15 seconds | 5 more minutes              | Feeds publish minutes apart; bounds RPC load           |
| Balances of one account     | 15 seconds | never                       | Balances move with every transfer                      |

Balances are cached per account, at most 1,000 accounts, the entry loaded longest ago dropped first. The key is
the account address, so the balances of one address are never returned for another.

- A cached value keeps the time it was loaded (`fetchedAt`). Serving it again, fresh or stale, never changes
  that time.
- When a reload fails and a value within the stale window exists, it is served with `servedStale: true` and
  the code of the failure. Past the window the failure is thrown. A policy whose stale window is zero, such as
  the balances, never serves stale: a failed reload is thrown even for a value exactly at its TTL.
- Staleness classes are not cached. They are recomputed on every call from the round's `updatedAt` and the
  current time, so a cached price ages correctly.
- Concurrent callers share one load. A failed load is not cached.

The cache is per process. Each server instance holds its own copy.

## Failure behaviour

Every failure has a typed error with a stable `code`.

| Code                    | Error class                 | When                                                                      |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------- |
| `upstream_failure`      | `UpstreamError`             | The API or the RPC endpoint failed, timed out or returned an error status |
| `malformed_response`    | `MalformedResponseError`    | The API payload does not have the expected shape                          |
| `missing_configuration` | `MissingConfigurationError` | `BASE_RPC_URL` is unset in production, invalid, or not Base mainnet       |
| `ineligible_token`      | `IneligibleTokenError`      | A value was demanded for a token that is not eligible                     |
| `token_paused`          | `TokenPausedError`          | Transfers of the token are paused                                         |
| `missing_feed`          | `MissingFeedError`          | The token has no usable reference feed                                    |
| `stale_feed`            | `StaleFeedError`            | The feed missed its heartbeat                                             |

- **API unreachable.** Each page is tried up to 3 times with a 10 second timeout. Only transport errors,
  timeouts, HTTP 429 and 5xx are retried. Then the cached list is served if it is within its stale window,
  otherwise `UpstreamError` is thrown.
- **API payload malformed.** Not retried. A missing required field, a wrong type, a duplicate token, an empty
  list, or pagination that repeats or does not end are all errors. Nothing is defaulted. Fields the layer does
  not know are ignored, because the API adds fields and omits default-valued ones.
- **RPC unreachable.** A failed request fails the whole read. It is never interpreted as reverting calls. The
  cached read is served if it is within its stale window, flagged, with prices capped at `delayed`.
- **One call reverts** (partial multicall failure). Only the token or feed the call belongs to is affected: the
  token is ineligible with `onchain_read_failed`, or its price is `unavailable` with `feed_read_failed`. No
  value is defaulted to zero.
- **Feed stale or round invalid.** The price is `unavailable` with reason `stale_feed` or `invalid_round`. An
  unavailable price has no price field. A stale round is exposed separately as `lastObserved`, for display with
  its age. No other source is substituted.

`requireReferencePrice` returns a usable price or throws one of the errors above, for callers that cannot
proceed without a price.

## Balances

`getBalances(account)` reads `balanceOf(account)` of USDC (`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`, the
address Circle publishes for its native USDC on Base) and of every token of the asset list, in one Multicall3
request at the latest block, with the same chain id check as the snapshot (`readBalances` in
`apps/web/src/server/market/balances.ts`). A call that reverts or does not decode is `null` for that token, never
zero. A failed request is an `UpstreamError`, and a failed balance read is not answered from an older one.

The balance read and the snapshot are two reads, each at its own block. A consumer reports both blocks.

## Replay of a recording

When `MARKET_REPLAY_DIR` names a directory, the process-wide service does not read the API or the chain. It
serves the recording in that directory (`asset-list.json` and `onchain.json`, in the format of
`apps/web/test/fixtures/market`) through the same parsing, decoding, eligibility and pricing code, with the clock
fixed at the time of the recorded block. The staleness classes are computed for that moment, on every run, and
then capped: a usable recorded price is always `last_close`, never `live` or `delayed`, whatever its age at the
recorded block. A recorded value is the value held since the recording, and the status says no more than that.
An unusable round stays `unavailable`.

This exists for the browser smoke tests, which run the production build without network access. It is not a way
to serve users: a replayed snapshot is real data of a past block, not current data. `marketDataMode()` returns
`replay`, the assets page shows a warning that names the recorded block, every API response built from it reports
`meta.mode: "replay"`, and `GET /api/v1/status` reports `marketData.mode: "replay"`.

### Where a replay is refused

`replayRefusal` in `apps/web/src/server/data-mode.ts` decides, for `MARKET_REPLAY_DIR` and for the registry's
`REGISTRY_REPLAY_DIR` alike:

| Environment                                                 | Replay  |
| ----------------------------------------------------------- | ------- |
| `VERCEL_ENV` set to any value (a Vercel deployment)         | Refused |
| `NODE_ENV=production` without `EQUITYOS_REPLAY_FOR_TESTS=1` | Refused |
| `NODE_ENV=production` with `EQUITYOS_REPLAY_FOR_TESTS=1`    | Allowed |
| Any other `NODE_ENV` (development, unit tests)              | Allowed |

`EQUITYOS_REPLAY_FOR_TESTS` is a test-only flag: only `apps/web/playwright.config.ts` sets it, for the smoke
tests that run `next start` on a production build. It has no effect on a deployment.

A refused variable fails loudly. `marketDataMode()` and `getMarketData()` throw `MissingConfigurationError` naming
`MARKET_REPLAY_DIR`, the server's startup hook (`apps/web/src/instrumentation.ts`) calls both mode functions so
that the server does not start, and any request that still reaches a route answers `500 service_misconfigured`.

A recording can also hold `balances.json`: balances for a few fixed accounts, constructed for the tests and not
read from any chain. The replay answers `balanceOf` of those accounts from it, a token an account does not list at
zero, and fails the read of any other account as an endpoint that does not answer. A surface that shows them says
that they are constructed.

## Consumers

- `/assets` renders the snapshot as a table.
- The public API under `/api/v1` serializes it. See [the API documentation](../api/README.md).
- `GET /api/v1/portfolio` joins the balances of an address with the snapshot. See [Portfolio](../api/portfolio.md).

`listAssets(snapshot, eligible?)` returns the tokens of a snapshot ordered by symbol and then by address, for
both.

## Tests

Unit tests run without a network. They replay fixtures recorded from the live API and from Base mainnet
(`apps/web/test/fixtures/market`, recorded 2026-11-21 at block 60489401) through a mocked `fetch` and a mocked
viem transport that answers Multicall3 requests call by call. The fixture files state their source, time and how
they were trimmed. `balances-recorded.json` is a balance read of one Base mainnet contract, recorded with
`bun run --filter @equityos/web record:balances <account> <file>`.

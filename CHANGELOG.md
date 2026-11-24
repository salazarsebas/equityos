# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Bun workspaces monorepo with a shared strict TypeScript configuration and Biome formatting and linting.
- `@equityos/core` package with fixed-point helpers on `bigint`: `BPS`, `mulDivDown` and `mulDivUp`.
- `@equityos/sdk` package skeleton exporting `SDK_VERSION`.
- Next.js web app with a static home page.
- Foundry project with a pinned compiler, EVM version and formatter configuration.
- CI workflow with `web` and `contracts` jobs.
- Contributor documentation: `README.md`, `AGENTS.md`, `CONTRIBUTING.md` and the `docs` index.
- Design tokens for color, type, spacing and radius as CSS custom properties mapped to Tailwind CSS, with light
  and dark themes, a persisted theme toggle and an automated WCAG AA contrast test.
- Self-hosted IBM Plex Sans and IBM Plex Mono through `next/font`.
- Component library in `apps/web/src/components/ui`: button, link, field, input, select, checkbox, tabs, tag,
  callout, data table, stat, source line, skeleton, empty state, error state and dialog.
- Number and time formatting utilities on `bigint` in `apps/web/src/lib/format.ts`.
- Application shell with header, typed primary navigation, footer, skip link and a 12-column layout grid.
- Component reference page at `/dev/components`, excluded from search indexing.
- `robots.txt`, `sitemap.xml` and an SVG icon for the web app.
- Playwright smoke test, run by the `web` CI job.
- Design system documentation in `docs/product/design-system.md`.
- Methodology spec `equityos.index/1` in `@equityos/core`: strict validator, published JSON Schema, RFC 8785
  canonicalization, keccak256 spec hash, equal and fixed weight calculation, verification checks and test vectors.
- Market data layer: tokenized stock list client, onchain token and reference feed reads, eligibility rules,
  staleness classification with a US market calendar, and position value math on `bigint`.
- `IndexRegistry` and `RebalanceLog` contracts with unit, fuzz and invariant tests, gas snapshots and a
  deterministic deployment script. Not audited and not deployed.
- Public API v1: `GET /api/v1/assets`, `GET /api/v1/assets/{address}`, `GET /api/v1/status` and an OpenAPI 3.1
  document at `/api/v1/openapi.json`.
- Assets page listing the tokenized stock universe with reference prices and their staleness.
- Architecture, API and security documentation for the above.
- Public API v1.1.0: `GET /api/v1/indexes`, `GET /api/v1/indexes/{identifier}`,
  `GET /api/v1/indexes/{identifier}/versions/{version}` and `GET /api/v1/indexes/{identifier}/composition`. On a
  chain without the registry they answer 409 `registry_not_deployed`. `GET /api/v1/status` reports the registry.
- Index explorer at `/indexes`, and index profile pages at `/indexes/{identifier}` and
  `/indexes/{identifier}/versions/{n}` with composition, a verification panel with reproducible commands, a
  plain-language methodology and a version history with the changes between versions.
- Registry replay (`REGISTRY_REPLAY_DIR`) and a recorder, so that tests serve a recorded local registry.
- The local seed publishes an index that fails verification and a deprecated index next to the three examples.
- Documentation of the indexes API and of the index profile and its verification checks.
- Public API v1.2.0: `GET /api/v1/portfolio` compares any address on Base mainnet with a published index version
  (balances, values, current and target weights, drift, holdings outside the index, findings), and
  `GET /api/v1/portfolio/plan` returns the reference-price rebalance plan of `@equityos/core`. Nothing is stored.
- Balance read of the market data layer (`balanceOf` by multicall), a recorded Base mainnet fixture, a recorder,
  and constructed balances served by the market data replay for tests.
- Index Studio at `/studio`: an editor that builds a valid `equityos.index/1` spec with a live preview of the
  composition, the canonical JSON and the spec hash, a draft kept in the browser, an export of the canonical
  bytes, and a reviewed, simulated and verified `createIndex` publication where the registry is deployed.
- Reusable transaction state machine and contract error decoding in `apps/web/src/lib/tx`.
- Browser test of the publish flow against a local Anvil node, run by the `integration` CI job.
- Portfolio page at `/portfolio`: any address compared with a published index version, with a drift table, the
  holdings outside the index and a reference-price plan preview in rebalance or buy-only mode. Linked from the
  index profile and the primary navigation.
- Landing page at `/`: what an index is and is not, an example spec with its hash and weights computed by
  `@equityos/core`, the commands that verify a published version, the asset universe and registry state with
  their sources and times, the portfolio comparison, the keyless API and the current limitations. Rendered on
  request. Open Graph image at `/opengraph-image`.
- `@equityos/sdk`: a typed client of every endpoint of the public API v1 with runtime decoding, amounts as
  `bigint` and typed errors including `registry_not_deployed`; `verifyIndexVersion`, which reads a version from
  the registry contract and runs checks C1 to C5 without calling the API; and the methodology functions of
  `@equityos/core` from the same entry. A test keeps its types equal to the OpenAPI document.
- Recorded example responses of the API in `apps/web/src/server/api/examples.json`, regenerated with
  `record:api-examples` and checked against the handlers.
- Developer pages: `/developers` with the conventions, three keyless requests, the SDK and verification from the
  contract; `/developers/api`, the API reference generated from the OpenAPI document; and `/developers/spec`, the
  methodology spec reference generated from its JSON Schema with an example hashed at build time. Linked from the
  primary navigation and listed in the sitemap.
- `CodeBlock` component: monospace text with a title bar and a copy button.
- Public API v1.3.0: `POST /api/v1/portfolio/execution-plan` quotes the reference-price plan for execution on
  Base mainnet through the KyberSwap aggregator, verifies the calldata against an allowlisted router, runs
  pre-trade checks at one block (jurisdiction, reference freshness, price deviation, pause, B20 policies,
  pending multiplier, balances at minimum amounts out, exact approvals), simulates the calls and returns either
  the blocking checks or the ordered calls with `planHash`. Nothing is signed or sent. Rate limited per address
  and per instance, with a 20 second deadline. The calldata verification is a browser-safe module.
- `@equityos/sdk`: `executionPlan` for the new endpoint.
- Network metrics at `/network` and `GET /api/v1/network`, computed from chain events only: published indexes,
  versions, creators and deprecations, rebalance attestations by tier (A: matching constituent flows in the same
  transaction, B: linked within 900 seconds, unmatched), distinct accounts, accounts within tolerance and the
  reference value moved, each with its definition and block range. Excluded accounts are set with
  `EQUITYOS_EXCLUDED_ACCOUNTS` and shown apart. Public API v1.4.0, and `getNetworkMetrics` in `@equityos/sdk`.
  Linked from the current state on the landing page.
- The local seed records example usage with mock tokens and feeds, and the registry replay carries the
  requests of the network metrics.
- Public API v1.5.0: every successful response carries `meta.mode`, `live` or `replay`, which is `replay` as soon
  as one source of the response is a replayed recording. The SDK decodes it.
- `transferWarnings` on `GET /api/v1/portfolio` and `GET /api/v1/portfolio/plan`: a typed `transfers_paused`
  warning for each constituent whose issuer paused transfers, and a line in the plan statement of the page.
- Execution from the user's wallet on the portfolio page: "Prepare to execute" requests an executable plan,
  the browser verifies every call against the plan's legs and the connected account and recomputes `planHash`,
  and a review built on a frozen snapshot shows each call, the totals, the checks, a checkbox per warning, the
  expiry and three fixed statements. One pure send decision returns the exact wallet request or a typed refusal,
  with the expiry measured by the latest block. Atomic wallets sign one EIP-5792 batch with `atomicRequired`;
  others sign one transaction at a time, each after the previous one confirmed, stopping at the first failure
  with an exact report of what confirmed, failed and was not sent. Receipts are checked against the account and
  the plan's transfer bounds; balances are read again and drift recomputed. Executions are recorded in the
  browser's local storage only.
- `RebalanceLog` attestation where the log is deployed: the last call of an atomic batch, or an optional
  transaction after every swap confirmed one at a time. Not on Base, where the contracts are not deployed.
- The browser bounds every swap of a plan with its own reads before it can be signed: `decimals()` of every token
  and the pinned Chainlink feed of every leg, at the latest block, with the server's validity and staleness
  rules; a minimum out more than 200 bps worse than that reference, a closed or stale feed, other decimals, or a
  plan for another index or version than the comparison is refused. The feed map is shared with the server.
- ERC-8021 Builder Code attribution with `NEXT_PUBLIC_BUILDER_CODE`: the suffix on each transaction sent one at a
  time and the optional `dataSuffix` capability of a batch; nothing when no code is configured.
- Browser tests of execution on a local Anvil node, with a mock router, executor and tokens installed at the
  pinned addresses, and of the review states with mocked plans.

### Changed

- Public API v1.6.0: `GET /api/v1/status` answers `executionAvailable: true` for every request the jurisdiction
  gate lets through.
  The `not_released` reason is no longer returned, and the SDK and the OpenAPI document no longer list it.

- The home page uses the application shell and the design tokens.
- The home page states that indexes can be browsed and verified, and what a network without the registry shows.
- IBM Plex Sans and IBM Plex Mono load from pinned Fontsource packages with `next/font/local`, so the build
  makes no network request.

### Fixed

- A transaction that is mined and reverts is reported as reverted, in the Studio as in execution, instead of as
  not found: its receipt is read with viem, which returns a reverted receipt, rather than wagmi, which throws.

- A deployment can no longer serve a replayed recording: `MARKET_REPLAY_DIR` and `REGISTRY_REPLAY_DIR` are
  refused on Vercel (`VERCEL_ENV` set) and in a production build without the test-only flag
  `EQUITYOS_REPLAY_FOR_TESTS=1`, with a typed configuration error at startup and on every request. A replayed
  reference price is never `live` or `delayed`: it is reported as `last_close`.
- Balances are never served stale: a cache with a stale window of zero no longer serves a value that is exactly
  at its TTL when its reload fails, and the portfolio endpoints refuse a balance read served stale with `503`. Any
  response built from an input served stale is `no-store`, on every caching route.
- A constituent missing from the balance read (the asset list changed between the snapshot and the balance read)
  answers `502 upstream_malformed` instead of being valued at zero, so a plan can no longer propose buying a
  position whose balance is unknown.
- The home page no longer says "None yet" for the newest index of a registry that holds indexes when the read of
  the newest one fails: it says that the registry cannot be read right now.
- `@equityos/core`: when the capped candidate of a rebalance is chosen, its sells are scaled again to what its
  own buys spend, so a plan no longer sells a constituent only to leave the proceeds uninvested. A deposit that
  adds less than one quote base unit no longer counts as a deposit in the tie between the two candidates.
- The deposit field of the portfolio plan accepts at most 6 decimals, the precision of USDC, and says so,
  instead of 8 decimals that could not be deposited.
- A test fails from October 1 of any year unless the market calendar covers the whole of the next year, so the
  end of the holiday table on 2027-12-31 cannot pass unnoticed.

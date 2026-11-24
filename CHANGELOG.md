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

### Changed

- The home page uses the application shell and the design tokens.
- The home page states that indexes can be browsed and verified, and what a network without the registry shows.
- IBM Plex Sans and IBM Plex Mono load from pinned Fontsource packages with `next/font/local`, so the build
  makes no network request.

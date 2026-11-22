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
- Index Studio at `/studio`: an editor that builds a valid `equityos.index/1` spec with a live preview of the
  composition, the canonical JSON and the spec hash, a draft kept in the browser, an export of the canonical
  bytes, and a reviewed, simulated and verified `createIndex` publication where the registry is deployed.
- Reusable transaction state machine and contract error decoding in `apps/web/src/lib/tx`.
- Browser test of the publish flow against a local Anvil node, run by the `integration` CI job.

### Changed

- The home page uses the application shell and the design tokens.

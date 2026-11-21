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

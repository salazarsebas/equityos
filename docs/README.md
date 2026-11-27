# Documentation

Technical documentation for EquityOS. This index lists only pages that exist.

| Section        | Scope                                                   | Pages                                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `architecture` | System design, components and the decisions behind them | [Methodology spec](architecture/methodology-spec.md), [Index registry](architecture/index-registry.md), [Market data](architecture/market-data.md), [Registry reader](architecture/registry-reader.md), [Execution](architecture/execution.md)                                |
| `api`          | REST API and SDK reference                              | [Overview](api/README.md), [Assets](api/assets.md), [Indexes](api/indexes.md), [Portfolio](api/portfolio.md), [Execution plan](api/execution.md), [Network](api/network.md), [TypeScript SDK](api/sdk.md)                                                                     |
| `security`     | Threat model, trust assumptions and security practices  | [Index registry](security/index-registry.md), [Publishing from the Studio](security/studio-publishing.md), [Aggregator calldata](security/aggregator-calldata.md), [Sending an execution plan](security/execution-sending.md), [Static analysis](security/static-analysis.md) |
| `development`  | Setting up, building and testing the project            | [Getting started](development/getting-started.md), [Local chain](development/local-chain.md), [Deployment](development/deployment.md), [Consuming an index from a contract](development/consuming-an-index.md), [Performance and SEO budgets](development/performance.md)     |
| `product`      | Product concepts and terminology                        | [Design system](product/design-system.md), [Index profile](product/index-profile.md), [Index Studio](product/index-studio.md), [Portfolio and drift](product/portfolio.md), [Network metrics](product/network-metrics.md)                                                     |

A section directory is created together with its first page.

Related documents at the repository root:

- [README.md](../README.md): overview and current status.
- [AGENTS.md](../AGENTS.md): working rules for contributors and coding agents.
- [CONTRIBUTING.md](../CONTRIBUTING.md): how to propose a change.
- [CHANGELOG.md](../CHANGELOG.md): notable changes.
